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

const LINGUA = (() => {
  const base = 'https://ravine-decrease-staleness.ngrok-free.dev';

  return {
    base,
    auth:    `${base}/api/auth`,
    vocab:   `${base}/api/vocab`,
    quizzes: `${base}/api/quizzes`,
    courses: `${base}/api/courses`,
    student: `${base}/api/student`,
    game: `${base}/api/game`
  };
})();