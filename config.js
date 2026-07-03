// ─────────────────────────────────────────────────────────────────────────────
//  LinguaAI — Central API Configuration
//
//  This file is loaded globally via <script src="/config.js"></script>.
//  Change ONLY this file when the backend URL changes (e.g. new ngrok tunnel,
//  staging → production, localhost → deployed).
//
//  Usage in any HTML file's <script>:
//    const API   = LINGUA.auth;
//    const VOCAB = LINGUA.vocab;
// ─────────────────────────────────────────────────────────────────────────────

// Render URL: https://ai-english-teacher-o9m4.onrender.com
// ngrok url: https://ravine-decrease-staleness.ngrok-free.dev
// localhost url: http://localhost:3030

const LINGUA = (() => {
  const base = 'https://ai-english-teacher-o9m4.onrender.com';

  return {
    base,
    auth:    `${base}/api/auth`,
    vocab:   `${base}/api/vocab`,
    quizzes: `${base}/api/quizzes`,
    courses: `${base}/api/courses`,
    student: `${base}/api/student`,
    game: `${base}/api/game`,
    reading: `${base}/api/reading`,
    aiTeacher: `${base}/api/ai-teacher`,
    pronunciation: `${base}/api/pronunciation`,
    race: `${base}/api/race`,
  };
})();

