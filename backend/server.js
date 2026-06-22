/**
 * server.js  — UPDATED VERSION
 *
 * Changes from original:
 *  1. Import http + socket.io
 *  2. Import gameRoutes (router + registerSocketHandlers)
 *  3. Mount /api/game router
 *  4. Attach io to app so routes can emit events
 *  5. Register socket handlers
 *  6. Listen on httpServer (not app) so socket.io works
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server } = require('socket.io');
const { connectDB } = require('./Db');
const authRoutes    = require('./authRoutes');
const vocabRoutes   = require('./vocabRoutes');
const path = require('path');
const quizRoutes    = require('./quizRoutes');
const courseRoutes  = require('./courseRoutes');
const studentRoutes = require('./studentRoutes');
const { router: gameRouter, registerSocketHandlers } = require('./gameRoutes');
const readingRoutes = require('./readingRoutes');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.PORT || 3030;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
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

// ─── Socket.io (NEW) ──────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io available to route handlers via req.app.get('io')
app.set('io', io);

// Register all socket event handlers
registerSocketHandlers(io);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/vocab',   vocabRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/game',    gameRouter);
app.use('/api/reading', readingRoutes);

app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing_page.html'));
});

app.use(
  '/uploads',
  express.static(
    path.join('C:/Users/HP/three_js_tutor/images/beginner_images')
  )
);

app.use(
  '/audios',
  express.static(path.join('C:/Users/HP/three_js_tutor/backend/audios/beginner_audios'))
);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// 404 handler
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
});

// ─── Start (listen on httpServer, NOT app) ────────────────────────────────────
(async () => {
  try {
    await connectDB();
    httpServer.listen(PORT, () => {                       // CHANGED: app.listen → httpServer.listen
      console.log(`🚀  Server running on http://localhost:${PORT}`);
      console.log(`🎮  Socket.io enabled`);

      console.log(`   POST /api/auth/register`);
      console.log(`   POST /api/auth/login`);
      console.log(`   GET  /api/auth/me        (protected)`);

      console.log(`   GET  /api/vocab/parts    (protected)`);
      console.log(`   GET  /api/vocab/words/:partId  (protected)`);
      console.log(`   GET  /api/vocab/progress (protected)`);
      console.log(`   POST /api/vocab/progress/complete (protected)`);

      console.log('   POST /api/quizzes         (protected)');
      console.log('   GET  /api/quizzes         (protected)');
      console.log('   GET  /api/quizzes/:id     (protected)');
      console.log('   DELETE /api/quizzes/:id   (protected)');

      console.log('   POST   /api/courses              – create course');
      console.log('   GET    /api/courses              – list my courses');
      console.log('   GET    /api/courses/:id          – get one course');
      console.log('   PATCH  /api/courses/:id          – update course');
      console.log('   DELETE /api/courses/:id          – delete course');
      console.log('   POST   /api/courses/:id/regen    – new invite code');

      console.log('   POST   /api/game/classes/:id/start   – teacher starts game');
      console.log('   GET    /api/game/classes/:id/session – get active session');
      console.log('   DELETE /api/game/classes/:id/session – teacher ends game');
      console.log('   POST   /api/reading              – teacher creates reading task');
      console.log('   GET    /api/reading              – teacher lists their tasks');
      console.log('   GET    /api/reading/:id          – get full task (teacher)');
      console.log('   GET    /api/reading/:id/play     – student view (no answers)');
      console.log('   POST   /api/reading/:id/check    – student submits answers');
      console.log('   PATCH  /api/reading/:id          – teacher updates task');
      console.log('   DELETE /api/reading/:id          – teacher deletes task');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();