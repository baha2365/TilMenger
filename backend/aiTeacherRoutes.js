const express = require('express');
const multer  = require('multer');
const { authenticate } = require('./authMiddleware');
const {
  getSession,
  transcribeAudio,
  chatWithTeacher,
  speakText,
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

router.get('/session',                              getSession);
router.post('/transcribe', upload.single('audio'), transcribeAudio);
router.post('/chat',                               chatWithTeacher);
router.post('/speak',                              speakText);

module.exports = router;