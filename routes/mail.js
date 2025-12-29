const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const router = express.Router();

// store uploads in the project's uploads/ directory
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + unique + ext);
  }
});

const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

async function createTransporter() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
      secure: !!process.env.SMTP_SECURE,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // fallback - create an ethereal test account (for local/dev)
  const testAccount = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
}

// Accepts multipart form-data (no file field expected) where the client references a previously uploaded file
router.post('/', upload.none(), async (req, res) => {
  try {
    const { name, email, subject, message, uploadedFilename, uploadedOriginalName } = req.body;

    const from = 'Website Contact <contact@health4yu.de>';
    const to = 'contact@health4yu.de';
    const replyTo = email || 'jane@gmail.com';

    const text = `Name: ${name || '—'}\nEmail: ${email || '—'}\nSubject: ${subject || '—'}\n\n${message || ''}`;
    const html = `<p><strong>Name:</strong> ${name || '—'}</p><p><strong>Email:</strong> ${email || '—'}</p><p><strong>Subject:</strong> ${subject || '—'}</p><hr><p>${(message||'').replace(/\n/g, '<br>')}</p>`;

    const attachments = [];
    // keep track of actual file paths so they can be deleted later if configured
    const attachedFilePaths = [];

    // file referenced from the separate /upload/document flow
    if (uploadedFilename) {
      const filePath = path.join(uploadsDir, uploadedFilename);
      if (fs.existsSync(filePath)) {
        attachments.push({ filename: uploadedOriginalName || uploadedFilename, path: filePath });
        attachedFilePaths.push(filePath);
      } else {
        console.warn('Referenced uploaded file not found:', filePath);
      }
    }

    // If a file was sent directly in this form submission (unexpected), accept it gracefully
    // and attach it. This prevents a 400 "Unexpected field" while encouraging the Upload flow.
    let directUploadWarning = null;
    if (req.files && req.files.length > 0) {
      directUploadWarning = 'A file was included directly in the form; it was attached to the email. Prefer using the Upload button.';
      console.warn('Direct file(s) posted to /mail; handling them. Files:', req.files.map((f) => f.path));
      req.files.forEach((f) => {
        attachments.push({ filename: f.originalname, path: f.path });
        attachedFilePaths.push(f.path);
      });
    }

    const transporter = await createTransporter();

    const info = await transporter.sendMail({
      from,
      to,
      replyTo,
      subject: subject || 'Website Contact',
      text,
      html,
      attachments,
    });

    const preview = nodemailer.getTestMessageUrl(info) || null;

    // Optionally delete the uploaded files after a successful send. Set MAIL_DELETE_UPLOADS=false to keep files.
    if (attachedFilePaths.length > 0 && process.env.MAIL_DELETE_UPLOADS !== 'false') {
      for (const p of attachedFilePaths) {
        try {
          await fs.promises.unlink(p);
          console.log('Deleted uploaded attachment:', p);
        } catch (delErr) {
          console.warn('Failed to delete uploaded attachment:', p, delErr);
        }
      }
    }

    const responsePayload = { ok: true, messageId: info.messageId, previewUrl: preview };
    if (directUploadWarning) responsePayload.warning = directUploadWarning;

    res.json(responsePayload);
  } catch (err) {
    console.error('Mail send failed', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// Multer error handler: give a helpful error when an unexpected file field is included
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || /Unexpected field/i.test(err.message)) {
      return res.status(400).json({ error: 'Unexpected file field. Please use the Upload button to attach files before submitting.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;