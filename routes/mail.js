const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const router = express.Router();

const crypto = require('crypto');
const Stripe = require('stripe');
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) console.warn('STRIPE_SECRET_KEY not set — contact payment flow will fail until set');
const stripe = Stripe(stripeKey || '');

// Contact token store (used to hold form data until payment completes)
const contactTokens = new Map();
const CONTACT_TOKEN_TTL = 15 * 60 * 1000; // 15 minutes

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function appendQuery(url, key, val) {
  if (!url) return url;
  function encodeVal(v) {
    if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
      return '{' + encodeURIComponent(v.slice(1, -1)) + '}';
    }
    return encodeURIComponent(v);
  }
  return url + (url.includes('?') ? '&' : '?') + encodeURIComponent(key) + '=' + encodeVal(val);
}

// store uploads in the project's tmp/uploads/ directory (temporary storage)
const uploadsDir = '/tmp/uploads';
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

// helper: send email from contact data and optionally delete attachments
async function sendContactEmail({ name, email, subject, message, uploadedFilename, uploadedOriginalName, extraFiles = [] }) {
  const from = process.env.SMTP_USER ? `Website Contact <${process.env.SMTP_USER}>` : 'Website Contact <email@example.com>';
  const to = process.env.SMTP_USER ? `${process.env.SMTP_USER}` : 'email@example.com';
  const replyTo = email;

  const text = `Name: ${name || '—'}\nEmail: ${email || '—'}\nSubject: ${subject || '—'}\n\n${message || ''}`;
  const html = `<p><strong>Name:</strong> ${name || '—'}</p><p><strong>Email:</strong> ${email || '—'}</p><p><strong>Subject:</strong> ${subject || '—'}</p><hr><p>${(message||'').replace(/\n/g, '<br>')}</p>`;

  const attachments = [];
  const attachedFilePaths = [];

  if (uploadedFilename) {
    const filePath = path.join(uploadsDir, uploadedFilename);
    if (fs.existsSync(filePath)) {
      attachments.push({ filename: uploadedOriginalName || uploadedFilename, path: filePath });
      attachedFilePaths.push(filePath);
    } else {
      console.warn('Referenced uploaded file not found:', filePath);
    }
  }

  // include any files that came directly with the request
  for (const f of extraFiles) {
    attachments.push({ filename: f.originalname, path: f.path });
    attachedFilePaths.push(f.path);
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

  // delete attachments if configured
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

  return { info, previewUrl: nodemailer.getTestMessageUrl(info) || null };
}

// Immediate send endpoint (used when payments are not required)
router.post('/', upload.none(), async (req, res) => {
  try {
    const { name, email, subject, message, uploadedFilename, uploadedOriginalName } = req.body;
    const extraFiles = (req.files && req.files.length) ? req.files : [];
    const result = await sendContactEmail({ name, email, subject, message, uploadedFilename, uploadedOriginalName, extraFiles });
    const response = { ok: true, messageId: result.info.messageId, previewUrl: result.previewUrl };
    if (extraFiles.length) response.warning = 'A file was included directly in the form; it was attached to the email. Prefer using the Upload button.';
    res.json(response);
  } catch (err) {
    console.error('Mail send failed', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// Create a Checkout Session for contact submissions requiring payment
router.post('/checkout', upload.none(), async (req, res) => {
  try {
    const { name, email, subject, message, uploadedFilename, uploadedOriginalName } = req.body;

    const feeCents = parseInt(process.env.CONTACT_FEE_CENTS || '1000', 10);
    const feeCurrency = (process.env.CONTACT_FEE_CURRENCY || 'eur').toLowerCase();
    const requirePayment = process.env.CONTACT_REQUIRE_PAYMENT !== 'false';

    // if payment disabled, send immediately
    if (!requirePayment || !feeCents || feeCents <= 0) {
      const result = await sendContactEmail({ name, email, subject, message, uploadedFilename, uploadedOriginalName });
      return res.json({ ok: true, messageId: result.info.messageId, previewUrl: result.previewUrl });
    }

    const token = makeToken();
    contactTokens.set(token, { expires: Date.now() + CONTACT_TOKEN_TTL, used: false, data: { name, email, subject, message, uploadedFilename, uploadedOriginalName } });

    const host = `${req.protocol}://${req.get('host')}`;
    const successUrlBase = appendQuery(`${host}/mail/success`, 'token', token);
    const successWithSession = appendQuery(successUrlBase, 'session_id', '{CHECKOUT_SESSION_ID}');
    const cancelUrl = appendQuery(`${host}/mail/cancel`, 'token', token);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: feeCurrency,
            product_data: { name: 'Contact message fee' },
            unit_amount: feeCents,
          },
          quantity: 1,
        },
      ],
      success_url: successWithSession,
      cancel_url: cancelUrl,
    });

    contactTokens.set(token, { expires: Date.now() + CONTACT_TOKEN_TTL, used: false, data: { name, email, subject, message, uploadedFilename, uploadedOriginalName }, sessionId: session.id });

    res.json({ url: session.url, id: session.id, token });
  } catch (err) {
    console.error('Failed to create checkout for contact:', err);
    res.status(500).json({ error: 'Failed to create checkout', details: err.message });
  }
});

// Serve contact success page (protected)
router.get('/success', (req, res) => {
  const token = req.query.token;
  if (!token || !contactTokens.has(token)) return res.status(403).send('Forbidden');
  const info = contactTokens.get(token);
  if (info.expires < Date.now()) {
    contactTokens.delete(token);
    return res.status(403).send('Token expired');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'contact-success.html'));
});

// Info endpoint: consumes token, verifies payment and sends the stored contact message
router.get('/info', async (req, res) => {
  const token = req.query.token;
  if (!token || !contactTokens.has(token)) return res.status(403).json({ error: 'Forbidden' });
  const info = contactTokens.get(token);
  if (info.used) return res.status(403).json({ error: 'Forbidden' });
  if (info.expires < Date.now()) {
    contactTokens.delete(token);
    return res.status(403).json({ error: 'Token expired' });
  }

  if (!info.sessionId) return res.status(400).json({ error: 'No session information' });

  try {
    const session = await stripe.checkout.sessions.retrieve(info.sessionId);
    const status = session.payment_status || session.status || 'unknown';

    if (status !== 'paid') {
      return res.json({ paid: false, status });
    }

    // payment confirmed — send the email now
    const { name, email, subject, message, uploadedFilename, uploadedOriginalName } = info.data;
    const result = await sendContactEmail({ name, email, subject, message, uploadedFilename, uploadedOriginalName });

    // consume token
    info.used = true;

    res.json({ paid: true, status, messageId: result.info.messageId, previewUrl: result.previewUrl });
  } catch (err) {
    console.error('Failed to retrieve Stripe session or send contact email:', err);
    res.status(500).json({ error: 'Failed to complete contact send', details: err.message });
  }
});

// Serve cancel page and mark token used
router.get('/cancel', (req, res) => {
  const token = req.query.token;
  if (!token || !contactTokens.has(token)) return res.status(403).send('Forbidden');
  const info = contactTokens.get(token);
  if (info.used) return res.status(403).send('Forbidden');
  if (info.expires < Date.now()) {
    contactTokens.delete(token);
    return res.status(403).send('Token expired');
  }
  info.used = true;
  res.sendFile(path.join(__dirname, '..', 'public', 'contact-cancel.html'));
});

// Public helper: return current contact fee (so the client can display it)
router.get('/fee', (req, res) => {
  const feeCents = parseInt(process.env.CONTACT_FEE_CENTS || '1000', 10);
  const currency = (process.env.CONTACT_FEE_CURRENCY || 'eur').toLowerCase();
  res.json({ feeCents, currency });
});

// cleanup expired/used tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [t, info] of contactTokens) {
    if (info.expires < now || info.used) contactTokens.delete(t);
  }
}, 60 * 1000);

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