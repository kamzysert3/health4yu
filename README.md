# Healt4yu Backend

Simple Express backend providing:
- Document upload route using `multer`
- Donation payment route using Stripe Checkout

Quick start

1. Install:

```bash
npm install
```

2. Create `.env` from `.env.example` and set your Stripe secret key:

```
STRIPE_SECRET_KEY=sk_test_...
PORT=4000
```

3. Add the following environment variables for email configuration:

```
SMTP_HOST=smtp.example.com
SMTP_USER=your_email@example.com
SMTP_PASS=your_password
SMTP_PORT=587
SMTP_SECURE=false
```

Environment variables (what they are and how to get them)

- STRIPE_SECRET_KEY — your Stripe secret API key used to create Checkout sessions.
  - Where to get it: Log in to the Stripe Dashboard → Developers → API keys. Use the **test** key (starts with `sk_test_`) while developing. When you are ready for production, switch your dashboard to **Live** mode and copy the **live secret** key (starts with `sk_live_`). Keep this value secret and never commit it to source control.

- PORT — the port the Express server will listen on (default: `4000` if unset). Useful when deploying to hosting platforms that provide a port via an environment variable.

- SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE — SMTP credentials and connection details for sending emails.
  - What they are:
    - `SMTP_HOST` — the SMTP server host (e.g. `smtp.gmail.com`, `smtp.mailgun.org`).
    - `SMTP_PORT` — port for the SMTP server (commonly `587` for STARTTLS or `465` for implicit TLS).
    - `SMTP_USER` / `SMTP_PASS` — authentication credentials for the SMTP account.
    - `SMTP_SECURE` — `true` if the server requires an implicit TLS connection (port 465), otherwise `false` for STARTTLS (port 587).
  - Where to get them:
    - Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`. If your account uses 2FA you must create an **App Password** and use that as `SMTP_PASS` (or configure OAuth2).
    - Mailgun/SendGrid/SES: check the provider's dashboard for SMTP credentials (they usually provide host, port and username/password).
    - For local/dev testing: leave SMTP values unset and the app will automatically use an Ethereal test account; the `/mail` response will include a `previewUrl` you can open to view the sent message.

- MAIL_DELETE_UPLOADS — optional (default: `true`). When `true` (or unset) uploaded attachments are deleted from the `uploads/` directory after a successful email send. Set `MAIL_DELETE_UPLOADS=false` to keep uploaded files for inspection.

Security notes
- Always store secrets in `.env` (or a secret store) and never commit `.env` to git. Use `gitignore` to exclude it.
- Use the Stripe **test** keys for local development and switch to **live** keys only when you're ready to process real payments.

Example `.env` snippet

```
# Stripe
STRIPE_SECRET_KEY=sk_test_your_key_here
# Server
PORT=4000
# SMTP (example for Gmail app password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_SECURE=false
# Remove uploaded files after sending
MAIL_DELETE_UPLOADS=true
```
3. Start server:

```bash
npm start
```

API endpoints

- `GET /` — health check
- `POST /upload/document` — multipart form upload. Field name: `document`. Returns uploaded file metadata.
- `POST /donate` — create Stripe Checkout session. JSON body: `{ "amount": 10, "currency": "usd", "success_url": "https://example.com/success", "cancel_url": "https://example.com/cancel" }`. Returns `{ url, id }` to redirect donor to.
- `POST /mail` — contact form endpoint. Sends an email with fields `name`, `email`, `subject`, `message`. If the form includes `uploadedFilename` (returned by `POST /upload/document`) the server will attach that file from the `uploads/` directory to the email.

Uploads are saved to the `uploads/` directory.

Notes

- This is a minimal example for local development and testing only. If SMTP credentials are not provided, the mailer falls back to an Ethereal test account and the `/mail` response will include a `previewUrl` you can open to view the sent message.
- Uploaded attachments are deleted after a successful send by default to avoid storing sensitive files on the server; set `MAIL_DELETE_UPLOADS=false` in your `.env` to disable deletion and keep files in the `uploads/` folder.
- For production, validate inputs, secure keys, and serve uploaded files from a proper storage (S3, etc.).
