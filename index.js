require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const uploadRouter = require('./routes/upload');
const donationRouter = require('./routes/donation');
const mailRouter = require('./routes/mail');

const app = express();
const PORT = process.env.PORT || 4000;

// ensure tmp/uploads directory exists (uploads are temporary)
const uploadsDir = '/tmp/uploads';
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(morgan('dev'));
app.use(cors());

// Use Express's built-in body parsers (avoid using body-parser plus express.json() together
// because double-parsing the request stream causes 'stream is not readable' errors).
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Prevent direct static access to the unprotected success/cancel HTML files so they
// can't be reached by typing the URL — these pages are served only through the
// protected `/donate/success` and `/donate/cancel` routes.
app.use((req, res, next) => {
  const blocked = ['/donate-success.html', '/donate-cancel.html', '/contact-success.html', '/contact-cancel.html'];
  if (blocked.includes(req.path)) return res.status(404).send('Not found');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/upload', uploadRouter);
app.use('/donate', donationRouter);
app.use('/mail', mailRouter);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/services', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'services.html'));
});

app.get('/participate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'participate.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.get('/Donate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Donate.html'));
});


app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
