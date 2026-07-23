const { pool } = require('./Db');

// ─── Pricing (display only — the real price of record lives in Paddle,
// on the Price object you create in the Paddle dashboard) ───────────────────
const MONTHLY_PRICE_KZT = 1500;
const MONTHLY_PRICE_USD = 3;

// Paddle keeps billing a subscription through short payment hiccups before
// it gives up (the dunning/retry window), so we treat 'past_due' as still
// having access rather than cutting the student off on the first failed
// charge. It only actually loses access once Paddle moves it to 'canceled'
// or 'paused', or once current_period_end passes.
function isSubActive(sub) {
  if (!sub) return false;
  if (!['active', 'past_due'].includes(sub.status)) return false;
  if (!sub.current_period_end) return false;
  return new Date(sub.current_period_end) > new Date();
}

// Shared by the /status endpoint and anywhere else that wants a full picture
// without duplicating the two queries below.
async function getAccessSummary(userId) {
  const [{ rows: subRows }, { rows: userRows }] = await Promise.all([
    pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]),
    pool.query('SELECT trial_topic_slug FROM users WHERE id = $1', [userId]),
  ]);
  const sub = subRows[0] || null;

  return {
    hasAccess:         isSubActive(sub),
    subscriptionStatus: sub?.status || 'none',
    currentPeriodEnd:   sub?.current_period_end || null,
    cancelAtPeriodEnd:  sub?.cancel_at_period_end || false,
    trialTopicSlug:     userRows[0]?.trial_topic_slug || null,
  };
}

// ─── Gate for topic-bearing endpoints: /session, /greet, /chat ─────────────
// An active subscriber always passes. Otherwise this enforces the one-topic
// free trial: the FIRST topic a user ever opens is silently claimed as their
// trial topic right here (no separate "start trial" step needed) — after
// that, only that same topic stays reachable until they subscribe.
async function requireSpeakingAccess(req, res, next) {
  const topic = req.query.topic || req.body?.topic;
  if (!topic) {
    return res.status(400).json({ success: false, message: 'topic is required.' });
  }

  try {
    const { rows: subRows } = await pool.query(
      'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
      [req.userId]
    );
    if (isSubActive(subRows[0])) {
      req.hasSpeakingAccess = true;
      return next();
    }

    const { rows: userRows } = await pool.query(
      'SELECT trial_topic_slug FROM users WHERE id = $1',
      [req.userId]
    );
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const trialSlug = userRows[0].trial_topic_slug;

    // No trial claimed yet — this topic becomes it.
    if (!trialSlug) {
      await pool.query(
        'UPDATE users SET trial_topic_slug = $1 WHERE id = $2',
        [topic, req.userId]
      );
      req.hasSpeakingAccess = true;
      req.isTrial = true;
      return next();
    }

    // Continuing/finishing the same topic they already claimed — fine.
    if (trialSlug === topic) {
      req.hasSpeakingAccess = true;
      req.isTrial = true;
      return next();
    }

    // Trial already spent on a different topic.
    return res.status(402).json({
      success: false,
      paymentRequired: true,
      message: `You've used your free topic. Subscribe for ${MONTHLY_PRICE_KZT} ₸/month to unlock every topic in Speaking Practice.`,
    });
  } catch (err) {
    console.error('requireSpeakingAccess error:', err);
    return res.status(500).json({ success: false, message: 'Could not verify access.' });
  }
}

// ─── Lighter gate for topic-agnostic endpoints: /transcribe, /speak ────────
// These don't carry a topic, so we can't check "is this THE trial topic" —
// they only ever get called from inside a chat flow that already passed
// requireSpeakingAccess once, so it's enough to confirm the user has EITHER
// an active subscription OR has already claimed a trial topic at some point.
async function requireAnySpeakingAccess(req, res, next) {
  try {
    const { rows: subRows } = await pool.query(
      'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
      [req.userId]
    );
    if (isSubActive(subRows[0])) {
      req.hasSpeakingAccess = true;
      return next();
    }

    const { rows: userRows } = await pool.query(
      'SELECT trial_topic_slug FROM users WHERE id = $1',
      [req.userId]
    );
    if (userRows[0]?.trial_topic_slug) {
      req.hasSpeakingAccess = true;
      return next();
    }

    return res.status(402).json({
      success: false,
      paymentRequired: true,
      message: 'Subscribe to unlock Speaking Practice.',
    });
  } catch (err) {
    console.error('requireAnySpeakingAccess error:', err);
    return res.status(500).json({ success: false, message: 'Could not verify access.' });
  }
}

module.exports = {
  requireSpeakingAccess,
  requireAnySpeakingAccess,
  getAccessSummary,
  isSubActive,
  MONTHLY_PRICE_KZT,
  MONTHLY_PRICE_USD,
};