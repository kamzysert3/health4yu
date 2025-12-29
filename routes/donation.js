const express = require('express');
const Stripe = require('stripe');

const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) console.warn('STRIPE_SECRET_KEY not set — donation route will fail until set');
const stripe = Stripe(stripeKey || '');

// simple in-memory token store: token -> { expires: timestamp, used: bool }
const tokens = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function makeToken() {
    return crypto.randomBytes(16).toString('hex');
}

function appendQuery(url, key, val) {
    if (!url) return url;
    // preserve placeholder braces like {CHECKOUT_SESSION_ID} so Stripe can replace them
    function encodeVal(v) {
        if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
            return '{' + encodeURIComponent(v.slice(1, -1)) + '}';
        }
        return encodeURIComponent(v);
    }
    return url + (url.includes('?') ? '&' : '?') + encodeURIComponent(key) + '=' + encodeVal(val);
}

// endpoint used by Stripe redirect to display a protected success page
router.get('/success', (req, res) => {
    const token = req.query.token;
    if (!token || !tokens.has(token)) return res.status(403).send('Forbidden');
    const info = tokens.get(token);
    if (info.expires < Date.now()) {
        tokens.delete(token);
        return res.status(403).send('Token expired');
    }

    res.sendFile(path.join(__dirname, '..', 'public', 'donate-success.html'));
});

// Protected endpoint returning safe session info (consumes the token on first use)
router.get('/info', async (req, res) => {
    const token = req.query.token;
    if (!token || !tokens.has(token)) return res.status(403).json({ error: 'Forbidden' });
    const info = tokens.get(token);
    if (info.used) return res.status(403).json({ error: 'Forbidden' });
    if (info.expires < Date.now()) {
        tokens.delete(token);
        return res.status(403).json({ error: 'Token expired' });
    }

    // ensure we have a session id stored
    if (!info.sessionId) return res.status(400).json({ error: 'No session information' });

    try {
        const session = await stripe.checkout.sessions.retrieve(info.sessionId);
        const amount = (session.amount_total != null) ? (session.amount_total / 100).toFixed(2) : null;
        const currency = session.currency ? session.currency.toUpperCase() : '';
        const status = session.payment_status || session.status || 'unknown';
        const shortRef = session.id ? `${session.id.slice(0, 8)}...${session.id.slice(-4)}` : '';

        // consume token
        info.used = true;

        res.json({ amount, currency, status, reference: shortRef });
    } catch (err) {
        console.error('Failed to retrieve Stripe session for info:', err.message || err);
        res.status(500).json({ error: 'Failed to retrieve session' });
    }
});

// endpoint used by Stripe redirect to display a protected cancel page
router.get('/cancel', (req, res) => {
    const token = req.query.token;
    if (!token || !tokens.has(token)) return res.status(403).send('Forbidden');
    const info = tokens.get(token);
    if (info.used) return res.status(403).send('Forbidden');
    if (info.expires < Date.now()) {
        tokens.delete(token);
        return res.status(403).send('Token expired');
    }
    // mark used and serve the cancel page
    info.used = true;
    res.sendFile(path.join(__dirname, '..', 'public', 'donate-cancel.html'));
});

// Create a Checkout Session for a donation. Expects JSON body: { amount, currency, success_url, cancel_url }
router.post('/', async (req, res) => {
    try {
        const { amount, currency = 'eur', success_url, cancel_url } = req.body;
        if (!amount) return res.status(400).json({ error: 'Missing amount (in major currency units, e.g. 10 for €10)' });
        if (!success_url || !cancel_url) return res.status(400).json({ error: 'Missing success_url or cancel_url' });

        const amountInt = Math.round(Number(amount) * 100); // convert to cents
        if (Number.isNaN(amountInt) || amountInt <= 0) return res.status(400).json({ error: 'Invalid amount' });

        // create a short-lived token and append it to the success/cancel urls
        const token = makeToken();
        tokens.set(token, { expires: Date.now() + TOKEN_TTL_MS, used: false });

        // For success we also include the placeholder for Stripe to inject the session id
        const successWithToken = appendQuery(success_url, 'token', token);
        const successWithSession = appendQuery(successWithToken, 'session_id', '{CHECKOUT_SESSION_ID}');
        const cancelWithToken = appendQuery(cancel_url, 'token', token);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency,
                        product_data: { name: 'Donation' },
                        unit_amount: amountInt,
                    },
                    quantity: 1,
                },
            ],
            success_url: successWithSession,
            cancel_url: cancelWithToken,
        });

        // store session id and amount in the token entry so the client-side page can fetch safe info
        tokens.set(token, { expires: Date.now() + TOKEN_TTL_MS, used: false, sessionId: session.id, amount: amountInt, currency });

        res.json({ url: session.url, id: session.id, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// cleanup expired/used tokens every minute
setInterval(() => {
    const now = Date.now();
    for (const [t, info] of tokens) {
        if (info.expires < now || info.used) tokens.delete(t);
    }
}, 60 * 1000);

module.exports = router;
