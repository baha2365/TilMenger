const crypto = require('crypto');
const { pool } = require('./Db');
const { isSubActive } = require('./subscriptionMiddleware');

const PADDLE_API_BASE = () =>
  process.env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

// ─── GET /api/paddle/config ───────────────────────────────────────────────────
// Everything here is safe to expose to the browser — the client-side token
// is a *public* token by design (it can only open checkouts, nothing else).
// The real secret (PADDLE_API_KEY) never leaves the server.
function getConfig(_req, res) {
  const { PADDLE_CLIENT_TOKEN, PADDLE_PRICE_ID_SPEAKING_MONTHLY, PADDLE_ENVIRONMENT } = process.env;

  if (!PADDLE_CLIENT_TOKEN || !PADDLE_PRICE_ID_SPEAKING_MONTHLY) {
    return res.status(500).json({
      success: false,
      message: 'Paddle is not configured yet. Set PADDLE_CLIENT_TOKEN and PADDLE_PRICE_ID_SPEAKING_MONTHLY in .env.',
    });
  }

  return res.json({
    success:     true,
    clientToken: PADDLE_CLIENT_TOKEN,
    environment: PADDLE_ENVIRONMENT || 'sandbox',
    priceId:     PADDLE_PRICE_ID_SPEAKING_MONTHLY,
  });
}

// ─── GET /api/paddle/status  (protected) ──────────────────────────────────────
async function getStatus(req, res) {
  try {
    const [{ rows: subRows }, { rows: userRows }] = await Promise.all([
      pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [req.userId]),
      pool.query('SELECT name, email, trial_topic_slug FROM users WHERE id = $1', [req.userId]),
    ]);

    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const sub  = subRows[0] || null;
    const user = userRows[0];

    return res.json({
      success:           true,
      hasAccess:         isSubActive(sub),
      status:            sub?.status || 'none',
      currentPeriodEnd:  sub?.current_period_end || null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
      trialTopicSlug:    user.trial_topic_slug || null,
      trialUsed:         !!user.trial_topic_slug,
      email:             user.email,
      name:              user.name,
    });
  } catch (err) {
    console.error('getStatus error:', err);
    return res.status(500).json({ success: false, message: 'Could not load subscription status.' });
  }
}

// ─── GET /api/paddle/manage-link  (protected) ─────────────────────────────────
// Fetches FRESH customer-portal deep links from Paddle's API. These links
// carry a short-lived auth token, so they're deliberately never stored —
// always re-fetched right before the student clicks "Manage billing".
async function getManageLink(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT paddle_subscription_id FROM subscriptions WHERE user_id = $1',
      [req.userId]
    );
    const subId = rows[0]?.paddle_subscription_id;
    if (!subId) {
      return res.status(404).json({ success: false, message: 'No subscription on file.' });
    }

    const pRes = await fetch(`${PADDLE_API_BASE()}/subscriptions/${subId}`, {
      headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}` },
    });
    const pData = await pRes.json();
    if (!pRes.ok) {
      console.error('Paddle API error (manage-link):', pRes.status, pData);
      throw new Error(pData?.error?.detail || 'Paddle API error');
    }

    const links = pData.data?.management_urls;
    if (!links) {
      return res.status(404).json({
        success: false,
        message: 'Management links unavailable — your Paddle API key needs the "Customer portal session (Write)" permission.',
      });
    }

    return res.json({
      success:              true,
      updatePaymentMethod:  links.update_payment_method,
      cancel:                links.cancel,
    });
  } catch (err) {
    console.error('getManageLink error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch billing management link.' });
  }
}

// ─── Webhook signature verification ──────────────────────────────────────────
// Implements Paddle's documented algorithm by hand (no extra dependency):
// header is `ts=<unix_ts>;h1=<hex hmac>`, and the signed payload is the
// literal string "<ts>:<raw_body>", HMAC-SHA256'd with your notification
// destination's secret key. See developer.paddle.com/webhooks/signature-verification.
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(';').map((p) => p.split('='))
  );
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  // Replay protection — reject anything older than 5 minutes.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf      = Buffer.from(h1, 'hex');
  if (expectedBuf.length !== gotBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

// Insert-or-update the one subscription row a user can have. COALESCE keeps
// fields we weren't given on THIS event (e.g. a renewal update usually still
// includes everything, but this makes the function safe to call with partial
// data too).
async function upsertSubscription({
  userId,
  paddleCustomerId,
  paddleSubscriptionId,
  paddlePriceId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
}) {
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, paddle_customer_id, paddle_subscription_id, paddle_price_id,
        status, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET paddle_customer_id     = COALESCE(EXCLUDED.paddle_customer_id, subscriptions.paddle_customer_id),
           paddle_subscription_id = COALESCE(EXCLUDED.paddle_subscription_id, subscriptions.paddle_subscription_id),
           paddle_price_id        = COALESCE(EXCLUDED.paddle_price_id, subscriptions.paddle_price_id),
           status                 = EXCLUDED.status,
           current_period_end     = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
           updated_at             = NOW()`,
    [
      userId,
      paddleCustomerId || null,
      paddleSubscriptionId || null,
      paddlePriceId || null,
      status,
      currentPeriodEnd || null,
      cancelAtPeriodEnd,
    ]
  );
}

// Fallback path for events where Paddle doesn't echo back our custom_data
// (this can happen on some renewal-triggered subscription.updated events) —
// match on the Paddle subscription ID we already stored instead.
async function updateSubscriptionByPaddleId(paddleSubscriptionId, { status, currentPeriodEnd, cancelAtPeriodEnd }) {
  await pool.query(
    `UPDATE subscriptions
        SET status = $1, current_period_end = COALESCE($2, current_period_end),
            cancel_at_period_end = $3, updated_at = NOW()
      WHERE paddle_subscription_id = $4`,
    [status, currentPeriodEnd || null, !!cancelAtPeriodEnd, paddleSubscriptionId]
  );
}

// ─── POST /api/paddle/webhook  (raw body — see paddleWebhookRoute.js) ────────
async function handleWebhook(req, res) {
  const signature = req.headers['paddle-signature'];
  const rawBody    = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;

  if (!verifyPaddleSignature(rawBody, signature, process.env.PADDLE_WEBHOOK_SECRET)) {
    console.warn('Paddle webhook: signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid JSON');
  }

  const eventId   = event.event_id || event.notification_id;
  const eventType = event.event_type;
  const data      = event.data || {};

  try {
    // Idempotency — Paddle retries on anything but a 2xx, and can send the
    // same event more than once even after a successful delivery.
    const { rowCount } = await pool.query(
      `INSERT INTO paddle_webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType, JSON.stringify(event)]
    );
    if (rowCount === 0) {
      return res.status(200).send('OK (duplicate, already processed)');
    }

    switch (eventType) {
      // Safety net for the very first payment on a new checkout — the
      // subscription.created event below is the main source of truth, but
      // this can arrive first in some sequences, so we handle it too.
      case 'transaction.completed': {
        const userId         = data.custom_data?.userId;
        const subscriptionId = data.subscription_id;
        if (userId && subscriptionId) {
          await upsertSubscription({
            userId,
            paddleCustomerId:      data.customer_id,
            paddleSubscriptionId:  subscriptionId,
            status:                'active',
          });
        }
        break;
      }

      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'subscription.paused':
      case 'subscription.resumed': {
        const userId    = data.custom_data?.userId;
        const priceId    = data.items?.[0]?.price?.id;
        const periodEnd  = data.current_billing_period?.ends_at || null;
        const willCancel = !!data.scheduled_change && data.scheduled_change.action === 'cancel';

        if (userId) {
          await upsertSubscription({
            userId,
            paddleCustomerId:     data.customer_id,
            paddleSubscriptionId: data.id,
            paddlePriceId:         priceId,
            status:                 data.status,
            currentPeriodEnd:       periodEnd,
            cancelAtPeriodEnd:      willCancel,
          });
        } else {
          await updateSubscriptionByPaddleId(data.id, {
            status:            data.status,
            currentPeriodEnd:  periodEnd,
            cancelAtPeriodEnd: willCancel,
          });
        }
        break;
      }

      default:
        // Anything else (customer.*, address.*, etc.) — not something we
        // act on. Not an error; just ignored.
        break;
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Paddle webhook processing error:', err);
    // Non-2xx tells Paddle to retry — safe, because the handler is
    // idempotent on event_id.
    return res.status(500).send('Internal error');
  }
}

module.exports = {
  getConfig,
  getStatus,
  getManageLink,
  handleWebhook,
};