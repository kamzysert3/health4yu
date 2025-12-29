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
