const express = require('express');
const multer  = require('multer');
const { authenticate } = require('./authMiddleware');
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

// Topic-scoped conversation (replaces the old free-chat session/chat pair)
router.get('/session',                             getSession);        // ?topic=<slug>&title=<name>
router.post('/greet',                               greetTopic);        // { topic, title }
router.post('/chat',                                chatWithTopic);     // { topic, title, text }

// Unchanged — level-aware, topic-agnostic
router.post('/transcribe', upload.single('audio'), transcribeAudio);
router.post('/speak',                               speakText);

// Drives the lock/current/completed chain on the topic-select page
router.get('/topics/progress',                      getTopicsProgress);

// Wipes a topic's stored conversation in place so the student can redo it
router.post('/restart',                             restartTopic);

// Full transcript + per-message corrections + score — only returns data once
// the topic's current session is actually completed
router.get('/results',                               getResults);

module.exports = router;