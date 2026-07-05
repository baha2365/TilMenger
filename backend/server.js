require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const { connectDB }    = require('./Db');
const authRoutes       = require('./authRoutes');
const vocabRoutes      = require('./vocabRoutes');
const quizRoutes       = require('./quizRoutes');
const courseRoutes     = require('./courseRoutes');
const studentRoutes    = require('./studentRoutes');
const readingRoutes    = require('./readingRoutes');
const aiTeacherRoutes  = require('./aiTeacherRoutes');
const pronunciationRoutes = require('./pronunciationRoutes');
const { router: gameRouter, registerSocketHandlers } = require('./gameRoutes');
const { router: raceRouter, registerRaceSocketHandlers } = require('./raceRoutes');
const topicRoutes = require('./topicRoutes');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.PORT || 3030;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin "${origin}" is not allowed.`));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:  allowedOrigins.length ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
app.set('io', io);
registerSocketHandlers(io);
registerRaceSocketHandlers(io);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/vocab',      vocabRoutes);
app.use('/api/quizzes',    quizRoutes);
app.use('/api/courses',    courseRoutes);
app.use('/api/student',    studentRoutes);
app.use('/api/game',       gameRouter);
app.use('/api/race',       raceRouter);
app.use('/api/reading',    readingRoutes);
app.use('/api/ai-teacher', aiTeacherRoutes);
app.use('/api/pronunciation', pronunciationRoutes);
app.use('/api/topics', topicRoutes);

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, '..'), {
    index: false
  })
);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing_page.html'));
});

app.use(
  '/uploads',
  express.static(path.join('C:/Users/HP/three_js_tutor/images/beginner_images'))
);
app.use(
  '/audios',
  express.static(path.join('C:/Users/HP/three_js_tutor/backend/audios/beginner_audios'))
);
app.use(
  '/sentence-audios',
  express.static(path.join(__dirname, '..', 'audios', 'sentence_audios'))
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── 404 & global error ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    httpServer.listen(PORT, () => {
      console.log(`\n🚀  Server running on http://localhost:${PORT}`);
      console.log(`🎮  Socket.io enabled\n`);

      console.log('── Auth ──────────────────────────────────────────');
      console.log('   POST   /api/auth/register');
      console.log('   POST   /api/auth/verify');
      console.log('   POST   /api/auth/resend');
      console.log('   POST   /api/auth/login');
      console.log('   GET    /api/auth/me           (protected)');

      console.log('\n── Vocab ─────────────────────────────────────────');
      console.log('   GET    /api/vocab/parts        (protected)');
      console.log('   GET    /api/vocab/words/:partId(protected)');
      console.log('   GET    /api/vocab/progress     (protected)');
      console.log('   POST   /api/vocab/progress/complete (protected)');

      console.log('\n── Quizzes ───────────────────────────────────────');
      console.log('   POST   /api/quizzes            (protected)');
      console.log('   GET    /api/quizzes            (protected)');
      console.log('   GET    /api/quizzes/:id        (protected)');
      console.log('   DELETE /api/quizzes/:id        (protected)');

      console.log('\n── Courses ───────────────────────────────────────');
      console.log('   POST   /api/courses            – create');
      console.log('   GET    /api/courses            – list mine');
      console.log('   GET    /api/courses/:id        – get one');
      console.log('   PATCH  /api/courses/:id        – update');
      console.log('   DELETE /api/courses/:id        – delete');
      console.log('   POST   /api/courses/:id/regen  – new invite code');

      console.log('\n── Game ──────────────────────────────────────────');
      console.log('   POST   /api/game/classes/:id/start');
      console.log('   GET    /api/game/classes/:id/session');
      console.log('   DELETE /api/game/classes/:id/session');

      console.log('\n── Race (live quiz) ──────────────────────────────');
      console.log('   POST   /api/race/classes/:classId/quizzes/:quizId/start');
      console.log('   GET    /api/race/classes/:classId/quizzes/:quizId/session');
      console.log('   GET    /api/race/classes/:classId/quizzes/:quizId/my-result');
      console.log('   DELETE /api/race/classes/:classId/quizzes/:quizId/session');
      console.log('   GET    /api/race/sessions/:sessionId/results');

      console.log('\n── Reading ───────────────────────────────────────');
      console.log('   POST   /api/reading');
      console.log('   GET    /api/reading');
      console.log('   GET    /api/reading/:id');
      console.log('   GET    /api/reading/:id/play');
      console.log('   POST   /api/reading/:id/check');
      console.log('   PATCH  /api/reading/:id');
      console.log('   DELETE /api/reading/:id');

      console.log('\n── AI Teacher ────────────────────────────────────');
      console.log('   GET    /api/ai-teacher/session    (protected)');
      console.log('   POST   /api/ai-teacher/transcribe (protected)');
      console.log('   POST   /api/ai-teacher/chat       (protected)');
      console.log('   POST   /api/ai-teacher/speak      (protected)');

      console.log('\n── Pronunciation ────────────────────────────────');
      console.log('   GET    /api/pronunciation/sentences/:partId (protected)');
      console.log('   POST   /api/pronunciation/check             (protected)');

      console.log('\n── Topics & Homeworks ────────────────────────────');
      console.log('   POST   /api/topics');
      console.log('   GET    /api/topics');
      console.log('   GET    /api/topics/:id');
      console.log('   GET    /api/topics/:id/results');
      console.log('   PATCH  /api/topics/:id');
      console.log('   DELETE /api/topics/:id');
      console.log('   GET    /api/topics/:id/play');
      console.log('   POST   /api/topics/:id/submit');
      console.log('');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();