const express = require('express');
const multer  = require('multer');
const { authenticate } = require('./authMiddleware');
const { requireSpeakingAccess, requireAnySpeakingAccess } = require('./subscriptionMiddleware');
const {
  getSession,
  greetTopic,
  chatWithTopic,
  transcribeAudio,
  speakText,
  getTopicsProgress,
  restartTopic,
  getResults,
} = require('./aiTeacherController');

const router = express.Router();

// Memory storage — buffer goes straight to Lemonfox, no disk touch needed.
// Lemonfox allows uploads up to 100MB, but 25MB is plenty for short voice clips.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('audio/')),
});

router.use(authenticate);

// ── Topic-scoped conversation — gated ────────────────────────────────────────
// requireSpeakingAccess lets an active subscriber through, otherwise enforces
// the one-topic free trial (see subscriptionMiddleware.js). Returns 402
// paymentRequired:true when neither applies — the frontend redirects to
// subscribe.html on that response.
router.get('/session', requireSpeakingAccess, getSession);        // ?topic=<slug>&title=<name>
router.post('/greet',  requireSpeakingAccess, greetTopic);         // { topic, title }
router.post('/chat',   requireSpeakingAccess, chatWithTopic);      // { topic, title, text }

// ── Topic-agnostic — lighter check ───────────────────────────────────────────
// These don't carry a topic slug, so they can't be checked against the exact
// trial topic — see requireAnySpeakingAccess for what it does check instead.
router.post('/transcribe', upload.single('audio'), requireAnySpeakingAccess, transcribeAudio);
router.post('/speak',                              requireAnySpeakingAccess, speakText);

// ── Progress / restart / results — NOT gated ─────────────────────────────────
// Deliberate choice: a student whose subscription has lapsed can still see
// what they already completed and their past scores (read/manage operations
// on data they already own), they just can't start or continue new chat
// turns above. Flip this if you'd rather lock these down too.
router.get('/topics/progress', getTopicsProgress);
router.post('/restart',        restartTopic);
router.get('/results',         getResults);

module.exports = router;