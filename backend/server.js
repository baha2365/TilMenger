require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { connectDB } = require('./Db');
const authRoutes    = require('./authRoutes');
const vocabRoutes   = require('./vocabRoutes');
const path = require('path');
const quizRoutes = require('./quizRoutes');
const courseRoutes = require('./courseRoutes');
const studentRoutes = require('./studentRoutes');



const app  = express();
const PORT = process.env.PORT || 3030;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin "${origin}" is not allowed.`));
    }
  },
  credentials: true,
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/vocab', vocabRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/student', studentRoutes);


app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "landing_page.html"));
});

app.use(
  '/uploads',
  express.static(
    path.join('C:/Users/HP/three_js_tutor/images/beginner_images')
  )
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

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀  Server running on http://localhost:${PORT}`);
      
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
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();