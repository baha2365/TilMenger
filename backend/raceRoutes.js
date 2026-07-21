/**
 * raceRoutes.js
 *
 * Live "racing quiz" mode — Kahoot/Quizizz-style. Students join a session,
 * answer questions against the clock, and are ranked in real time by score
 * (then speed as a tiebreaker). Once a student finishes a racing session
 * they cannot replay it (checked against quiz_race_participants).
 *
 * Mounted at /api/race in server.js.
 *
 * REST:
 *   POST   /api/race/classes/:classId/quizzes/:quizId/start   – teacher creates/returns the live session
 *   GET    /api/race/classes/:classId/quizzes/:quizId/session – current session for this class+quiz (or null)
 *   GET    /api/race/classes/:classId/quizzes/:quizId/my-result – student: have I already finished this?
 *   DELETE /api/race/classes/:classId/quizzes/:quizId/session – teacher force-ends the session
 *   GET    /api/race/sessions/:sessionId/results               – full leaderboard + podium
 *
 * Socket.io (room: `race:${sessionId}`, notifications also go to `class:${classId}`):
 *   Client → Server:
 *     race_join      { sessionId, token }
 *     race_begin     { sessionId, token }                         – teacher only, waiting → active
 *     race_answer    { sessionId, token, questionId, answerId, timeMs }
 *     race_finish    { sessionId, token, totalTimeMs }
 *     race_end       { sessionId, token }                         – teacher only
 *
 *   Server → Client:
 *     race_state               { session, leaderboard }
 *     race_participant_joined  { leaderboard }
 *     race_begin                {}                                 – "go!" signal
 *     race_answer_result       { questionId, isCorrect, points, correctAnswerId, totalScore }
 *     race_leaderboard_update  { leaderboard }
 *     race_participant_finished{ studentId, name, rank, score }
 *     race_ended                { leaderboard, podium }
 *     error                     { message }
 *
 * IMPORTANT — user ids:
 *   studentId / teacherId are UUID strings (users.id is a uuid column as of
 *   the users-to-uuid migration). They are NEVER passed through Number()
 *   — always compare them as plain strings.
 */

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware');

const router = express.Router();

// ─── Scoring constants ─────────────────────────────────────────────────────
const RACE_BASE_POINTS     = 500;   // guaranteed for any correct answer within the time window
const RACE_SPEED_BONUS_MAX = 500;   // extra, scaled by how fast the answer came in
const RACE_QUESTION_TIME_MS = 20000; // 20s "par" window used for the speed bonus curve

function calcPoints(isCorrect, timeMs) {
  if (!isCorrect) return 0;
  const clamped    = Math.min(Math.max(Number(timeMs) || 0, 0), RACE_QUESTION_TIME_MS);
  const speedRatio = 1 - (clamped / RACE_QUESTION_TIME_MS);
  return RACE_BASE_POINTS + Math.round(RACE_SPEED_BONUS_MAX * speedRatio);
}

// ─── In-memory live state ──────────────────────────────────────────────────
// Map<sessionId, RaceSession>
const raceSessions = new Map();
// Map<"classId:quizId", sessionId>  — fast lookup of the current live session
const activeByClassQuiz = new Map();

/**
 * RaceSession shape (server-side only fields are prefixed with an underscore
 * and are never sent to clients):
 * {
 *   id, classId, quizId, teacherId (UUID string), quizTitle,
 *   status: 'waiting' | 'active' | 'ended',
 *   startedAtMs: number | null,
 *   questionOrder: number[],              // quiz_question ids, in order
 *   _answerKey: Map<questionId, correctAnswerId>,
 *   participants: Map<studentId (UUID string), {
 *     dbId, studentId, name, score, correctCount, totalAnswered,
 *     answeredQuestionIds: Set<number>,
 *     finishedAt: number|null, totalTimeMs: number|null,
 *     online: boolean, socketId: string|null,
 *   }>,
 * }
 */

function keyOf(classId, quizId) { return `${classId}:${quizId}`; }

function verifyToken(token) {
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
}

async function getClassTeacher(classId) {
  const { rows } = await pool.query('SELECT teacher_id FROM classes WHERE id = $1', [classId]);
  return rows.length ? rows[0].teacher_id : null; // UUID string
}

async function isEnrolled(classId, studentId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2',
    [classId, studentId]
  );
  return rows.length > 0;
}

function requireTeacher(req, res, next) {
  if (!req.userId || String(req.userRoleId) !== '2') {
    return res.status(403).json({ success: false, message: 'Only teachers can do this.' });
  }
  next();
}

/** Build the client-safe leaderboard from a session, sorted and ranked. */
function buildLeaderboard(session) {
  const arr = Array.from(session.participants.values()).map(p => ({
    studentId:     p.studentId,
    name:          p.name,
    score:         p.score,
    correctCount:  p.correctCount,
    totalAnswered: p.totalAnswered,
    finished:      !!p.finishedAt,
    totalTimeMs:   p.totalTimeMs,
    online:        p.online,
  }));
  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.finished ? a.totalTimeMs : Infinity;
    const bt = b.finished ? b.totalTimeMs : Infinity;
    return at - bt;
  });
  arr.forEach((p, i) => { p.rank = i + 1; });
  return arr;
}

/** Client-safe session summary (never includes the answer key). */
function safeSession(session) {
  return {
    id:            session.id,
    classId:       session.classId,
    quizId:        session.quizId,
    teacherId:     session.teacherId,
    quizTitle:     session.quizTitle,
    status:        session.status,
    startedAt:     session.startedAtMs ? new Date(session.startedAtMs).toISOString() : null,
    questionCount: session.questionOrder.length,
    participantCount: session.participants.size,
  };
}

function broadcastState(io, sessionId) {
  const session = raceSessions.get(sessionId);
  if (!session) return;
  io.to(`race:${sessionId}`).emit('race_state', {
    session: safeSession(session),
    leaderboard: buildLeaderboard(session),
  });
}

function broadcastLeaderboard(io, sessionId) {
  const session = raceSessions.get(sessionId);
  if (!session) return;
  io.to(`race:${sessionId}`).emit('race_leaderboard_update', {
    leaderboard: buildLeaderboard(session),
  });
}

/** Ends a session: persists to DB, broadcasts final results, clears memory. */
async function endSession(io, session) {
  if (!session || session.status === 'ended') return;
  session.status = 'ended';

  try {
    await pool.query(
      `UPDATE quiz_race_sessions SET status = 'ended', ended_at = now() WHERE id = $1`,
      [session.id]
    );
  } catch (err) {
    console.error('End race session (DB) error:', err);
  }

  const leaderboard = buildLeaderboard(session);
  const podium = leaderboard.slice(0, 3);

  io.to(`race:${session.id}`).emit('race_ended', { leaderboard, podium });
  io.to(`class:${session.classId}`).emit('race_session_ended', {
    classId: session.classId,
    quizId:  session.quizId,
    sessionId: session.id,
  });

  raceSessions.delete(session.id);
  const k = keyOf(session.classId, session.quizId);
  if (activeByClassQuiz.get(k) === session.id) activeByClassQuiz.delete(k);
}

// ═══════════════════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/race/classes/:classId/quizzes/:quizId/start
router.post('/classes/:classId/quizzes/:quizId/start', authenticate, requireTeacher, async (req, res) => {
  const { classId, quizId } = req.params;
  const quizIdNum = Number(quizId);

  try {
    const teacherId = await getClassTeacher(classId);
    if (!teacherId) return res.status(404).json({ success: false, message: 'Class not found.' });
    if (teacherId !== req.userId) {
      return res.status(403).json({ success: false, message: 'You do not own this class.' });
    }

    const { rows: assignRows } = await pool.query(
      `SELECT mode FROM class_quiz_assignments WHERE class_id = $1 AND quiz_id = $2`,
      [classId, quizIdNum]
    );
    if (!assignRows.length) {
      return res.status(404).json({ success: false, message: 'This quiz is not exposed to this class.' });
    }
    if (assignRows[0].mode !== 'racing') {
      return res.status(400).json({ success: false, message: 'This quiz is exposed as a casual quiz, not a racing quiz.' });
    }

    // Reuse an already-running session instead of creating a duplicate.
    const existingId = activeByClassQuiz.get(keyOf(classId, quizIdNum));
    if (existingId && raceSessions.has(existingId)) {
      const existing = raceSessions.get(existingId);
      return res.status(200).json({ success: true, session: safeSession(existing) });
    }

    const { rows: quizRows } = await pool.query(
      `SELECT id, title FROM quizzes WHERE id = $1`, [quizIdNum]
    );
    if (!quizRows.length) return res.status(404).json({ success: false, message: 'Quiz not found.' });

    const { rows: questions } = await pool.query(
      `SELECT id, order_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
      [quizIdNum]
    );
    if (!questions.length) {
      return res.status(400).json({ success: false, message: 'This quiz has no questions yet.' });
    }

    const { rows: answers } = await pool.query(
      `SELECT id, question_id FROM quiz_answers WHERE question_id = ANY($1::int[]) AND is_correct = true`,
      [questions.map(q => q.id)]
    );
    const answerKey = new Map();
    for (const a of answers) answerKey.set(a.question_id, a.id);

    const sessionId = uuidv4();
    await pool.query(
      `INSERT INTO quiz_race_sessions (id, class_id, quiz_id, teacher_id, status)
       VALUES ($1, $2, $3, $4, 'waiting')`,
      [sessionId, classId, quizIdNum, req.userId]
    );

    const session = {
      id: sessionId,
      classId,
      quizId: quizIdNum,
      teacherId: req.userId,
      quizTitle: quizRows[0].title,
      status: 'waiting',
      startedAtMs: null,
      questionOrder: questions.map(q => q.id),
      _answerKey: answerKey,
      participants: new Map(),
    };
    raceSessions.set(sessionId, session);
    activeByClassQuiz.set(keyOf(classId, quizIdNum), sessionId);

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${classId}`).emit('race_started', {
        classId, quizId: quizIdNum, sessionId,
        quizTitle: session.quizTitle,
      });
    }

    return res.status(201).json({ success: true, session: safeSession(session) });
  } catch (err) {
    console.error('Start race error:', err);
    return res.status(500).json({ success: false, message: 'Could not start race.' });
  }
});

// GET /api/race/classes/:classId/quizzes/:quizId/session
router.get('/classes/:classId/quizzes/:quizId/session', authenticate, async (req, res) => {
  const { classId, quizId } = req.params;
  const quizIdNum = Number(quizId);

  try {
    if (String(req.userRoleId) === '2') {
      const teacherId = await getClassTeacher(classId);
      if (!teacherId || teacherId !== req.userId) {
        return res.status(403).json({ success: false, message: 'You do not own this class.' });
      }
    } else {
      if (!(await isEnrolled(classId, req.userId))) {
        return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
      }
    }

    const sessionId = activeByClassQuiz.get(keyOf(classId, quizIdNum));
    const session = sessionId ? raceSessions.get(sessionId) : null;
    if (!session) return res.json({ success: true, session: null });

    return res.json({ success: true, session: safeSession(session) });
  } catch (err) {
    console.error('Get race session error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch session.' });
  }
});

// GET /api/race/classes/:classId/quizzes/:quizId/my-result
router.get('/classes/:classId/quizzes/:quizId/my-result', authenticate, async (req, res) => {
  if (String(req.userRoleId) !== '1') {
    return res.status(403).json({ success: false, message: 'Only students have race results.' });
  }
  const { classId, quizId } = req.params;

  try {
    if (!(await isEnrolled(classId, req.userId))) {
      return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
    }

    // Only a session tied to the *current* exposure counts — if the teacher
    // removed and re-exposed this quiz, older sessions from before that
    // shouldn't keep blocking students as "already completed".
    const { rows } = await pool.query(
      `SELECT qrp.session_id, qrp.score, qrp.correct_count, qrp.total_answered,
              qrp.finished_at, qrp.total_time_ms
         FROM class_quiz_assignments cqa
         JOIN quiz_race_sessions qrs
           ON qrs.class_id = cqa.class_id AND qrs.quiz_id = cqa.quiz_id
          AND qrs.created_at >= cqa.assigned_at
         LEFT JOIN quiz_race_participants qrp
           ON qrp.session_id = qrs.id AND qrp.student_id = $3
        WHERE cqa.class_id = $1 AND cqa.quiz_id = $2
        ORDER BY qrs.created_at DESC
        LIMIT 1`,
      [classId, quizId, req.userId]
    );

    const finished = rows.length > 0 && rows[0].finished_at;
    if (!finished) return res.json({ success: true, hasPlayed: false, result: null });
    return res.json({ success: true, hasPlayed: true, result: rows[0] });
  } catch (err) {
    console.error('Get my race result error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch result.' });
  }
});

// DELETE /api/race/classes/:classId/quizzes/:quizId/session
router.delete('/classes/:classId/quizzes/:quizId/session', authenticate, requireTeacher, async (req, res) => {
  const { classId, quizId } = req.params;
  const quizIdNum = Number(quizId);

  const sessionId = activeByClassQuiz.get(keyOf(classId, quizIdNum));
  const session = sessionId ? raceSessions.get(sessionId) : null;
  if (!session) return res.status(404).json({ success: false, message: 'No active race session.' });
  if (session.teacherId !== req.userId) {
    return res.status(403).json({ success: false, message: 'You do not own this session.' });
  }

  const io = req.app.get('io');
  await endSession(io, session);
  return res.json({ success: true, message: 'Race ended.' });
});

// GET /api/race/sessions/:sessionId/results
router.get('/sessions/:sessionId/results', authenticate, async (req, res) => {
  const { sessionId } = req.params;

  try {
    const { rows: sessRows } = await pool.query(
      `SELECT qrs.*, q.title AS quiz_title
         FROM quiz_race_sessions qrs
         JOIN quizzes q ON q.id = qrs.quiz_id
        WHERE qrs.id = $1`,
      [sessionId]
    );
    if (!sessRows.length) return res.status(404).json({ success: false, message: 'Session not found.' });
    const dbSession = sessRows[0];

    if (String(req.userRoleId) === '2') {
      if (dbSession.teacher_id !== req.userId) {
        return res.status(403).json({ success: false, message: 'Not your session.' });
      }
    } else {
      if (!(await isEnrolled(dbSession.class_id, req.userId))) {
        return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
      }
    }

    // Prefer live in-memory state (has online flags, works before DB commit lag);
    // fall back to DB for sessions that have already ended / server restarted.
    const live = raceSessions.get(sessionId);
    let leaderboard;
    if (live) {
      leaderboard = buildLeaderboard(live);
    } else {
      const { rows: pRows } = await pool.query(
        `SELECT qrp.student_id, u.name, qrp.score, qrp.correct_count, qrp.total_answered,
                qrp.finished_at, qrp.total_time_ms
           FROM quiz_race_participants qrp
           JOIN users u ON u.id = qrp.student_id
          WHERE qrp.session_id = $1`,
        [sessionId]
      );
      leaderboard = pRows.map(p => ({
        studentId:     p.student_id,
        name:          p.name,
        score:         p.score,
        correctCount:  p.correct_count,
        totalAnswered: p.total_answered,
        finished:      !!p.finished_at,
        totalTimeMs:   p.total_time_ms,
        online:        false,
      })).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const at = a.finished ? a.totalTimeMs : Infinity;
        const bt = b.finished ? b.totalTimeMs : Infinity;
        return at - bt;
      });
      leaderboard.forEach((p, i) => { p.rank = i + 1; });
    }

    return res.json({
      success: true,
      session: {
        id: dbSession.id,
        classId: dbSession.class_id,
        quizId: dbSession.quiz_id,
        status: dbSession.status,
        quizTitle: dbSession.quiz_title,
      },
      leaderboard,
      podium: leaderboard.slice(0, 3),
    });
  } catch (err) {
    console.error('Get race results error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch results.' });
  }
});

// GET /api/race/classes/:classId/quizzes/:quizId/questions
// Race-safe quiz content for the play screen — deliberately omits is_correct
// (unlike GET /api/quizzes/:id, which casual/replayable quizzes rely on for
// client-side grading). Available once a session exists for this pairing.
router.get('/classes/:classId/quizzes/:quizId/questions', authenticate, async (req, res) => {
  const { classId, quizId } = req.params;
  const quizIdNum = Number(quizId);

  try {
    if (String(req.userRoleId) === '2') {
      const teacherId = await getClassTeacher(classId);
      if (!teacherId || teacherId !== req.userId) {
        return res.status(403).json({ success: false, message: 'You do not own this class.' });
      }
    } else {
      if (!(await isEnrolled(classId, req.userId))) {
        return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
      }
    }

    const { rows: assignRows } = await pool.query(
      `SELECT mode FROM class_quiz_assignments WHERE class_id = $1 AND quiz_id = $2`,
      [classId, quizIdNum]
    );
    if (!assignRows.length || assignRows[0].mode !== 'racing') {
      return res.status(404).json({ success: false, message: 'No racing quiz exposed here.' });
    }

    const { rows: quizRows } = await pool.query(`SELECT id, title FROM quizzes WHERE id = $1`, [quizIdNum]);
    if (!quizRows.length) return res.status(404).json({ success: false, message: 'Quiz not found.' });

    const { rows: questions } = await pool.query(
      `SELECT id, question_text, order_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
      [quizIdNum]
    );
    for (const q of questions) {
      const { rows: answers } = await pool.query(
        `SELECT id, answer_text, order_index FROM quiz_answers WHERE question_id = $1 ORDER BY order_index ASC`,
        [q.id]
      );
      q.answers = answers; // no is_correct — by design
    }

    return res.json({ success: true, title: quizRows[0].title, questions });
  } catch (err) {
    console.error('Get race questions error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch quiz content.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO HANDLER — call from server.js after creating the io instance
// ═══════════════════════════════════════════════════════════════════════════

function registerRaceSocketHandlers(io) {
  io.on('connection', (socket) => {

    // ── race_join ──────────────────────────────────────────────────────────
    socket.on('race_join', async ({ sessionId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const session = raceSessions.get(sessionId);
      if (!session) return socket.emit('error', { message: 'Race session not found or has ended.' });

      const userId = payload.sub; // UUID string
      const roleId = Number(payload.roleId);

      try {
        if (roleId === 2) {
          if (session.teacherId !== userId) {
            return socket.emit('error', { message: 'Not your session.' });
          }
        } else {
          if (!(await isEnrolled(session.classId, userId))) {
            return socket.emit('error', { message: 'Not enrolled in this class.' });
          }

          let participant = session.participants.get(userId);
          if (!participant) {
            // Block replay of THIS session only (covers server restarts losing
            // in-memory state). Finishing an earlier session does NOT block
            // joining a new one — when the teacher starts a fresh round, that's
            // a legitimate new attempt.
            const { rows: doneRows } = await pool.query(
              `SELECT 1 FROM quiz_race_participants
                WHERE session_id = $1 AND student_id = $2 AND finished_at IS NOT NULL`,
              [sessionId, userId]
            );
            if (doneRows.length) {
              return socket.emit('error', { message: 'You have already completed this race.' });
            }

            const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
            const name = userRows.length ? userRows[0].name : 'Student';

            const { rows: insRows } = await pool.query(
              `INSERT INTO quiz_race_participants (session_id, student_id)
               VALUES ($1, $2)
               ON CONFLICT (session_id, student_id) DO UPDATE SET student_id = EXCLUDED.student_id
               RETURNING id`,
              [sessionId, userId]
            );

            participant = {
              dbId: insRows[0].id,
              studentId: userId,
              name,
              score: 0,
              correctCount: 0,
              totalAnswered: 0,
              answeredQuestionIds: new Set(),
              finishedAt: null,
              totalTimeMs: null,
              online: true,
              socketId: socket.id,
            };
            session.participants.set(userId, participant);
          } else if (participant.finishedAt) {
            return socket.emit('error', { message: 'You have already completed this race.' });
          } else {
            participant.online = true;
            participant.socketId = socket.id;
          }
        }
      } catch (err) {
        console.error('race_join error:', err);
        return socket.emit('error', { message: 'Server error joining race.' });
      }

      socket.join(`race:${sessionId}`);
      socket.data = { sessionId, userId, roleId, classId: session.classId };

      socket.emit('race_state', { session: safeSession(session), leaderboard: buildLeaderboard(session) });
      io.to(`race:${sessionId}`).emit('race_participant_joined', { leaderboard: buildLeaderboard(session) });
    });

    // ── race_begin (teacher starts the actual round) ─────────────────────────
    socket.on('race_begin', async ({ sessionId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const session = raceSessions.get(sessionId);
      if (!session) return socket.emit('error', { message: 'Race session not found.' });

      if (Number(payload.roleId) !== 2 || session.teacherId !== payload.sub) {
        return socket.emit('error', { message: 'Only the teacher can start the race.' });
      }
      if (session.status !== 'waiting') return; // already started/ended — ignore

      session.status = 'active';
      session.startedAtMs = Date.now();

      try {
        await pool.query(
          `UPDATE quiz_race_sessions SET status = 'active', started_at = now() WHERE id = $1`,
          [sessionId]
        );
      } catch (err) {
        console.error('race_begin (DB) error:', err);
      }

      io.to(`race:${sessionId}`).emit('race_begin', {});
      broadcastState(io, sessionId);
    });

    // ── race_answer ────────────────────────────────────────────────────────
    socket.on('race_answer', async ({ sessionId, token, questionId, answerId, timeMs } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const session = raceSessions.get(sessionId);
      if (!session || session.status !== 'active') {
        return socket.emit('error', { message: 'Race is not active.' });
      }

      const userId = payload.sub; // UUID string
      const participant = session.participants.get(userId);
      if (!participant) return socket.emit('error', { message: 'You are not in this race.' });
      if (participant.finishedAt) return; // ignore stray answers after finishing
      if (participant.answeredQuestionIds.has(Number(questionId))) return; // already answered — ignore dup

      const qId = Number(questionId);
      const correctAnswerId = session._answerKey.get(qId);
      const isCorrect = correctAnswerId !== undefined && String(answerId) === String(correctAnswerId);
      const points = calcPoints(isCorrect, timeMs);

      participant.answeredQuestionIds.add(qId);
      participant.score += points;
      participant.totalAnswered += 1;
      if (isCorrect) participant.correctCount += 1;

      try {
        await pool.query(
          `INSERT INTO quiz_race_answers (participant_id, question_id, answer_id, is_correct, time_ms, points_awarded)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (participant_id, question_id) DO NOTHING`,
          [participant.dbId, qId, answerId || null, isCorrect, Math.round(Number(timeMs) || 0), points]
        );
        await pool.query(
          `UPDATE quiz_race_participants
              SET score = $1, correct_count = $2, total_answered = $3
            WHERE id = $4`,
          [participant.score, participant.correctCount, participant.totalAnswered, participant.dbId]
        );
      } catch (err) {
        console.error('race_answer (DB) error:', err);
      }

      socket.emit('race_answer_result', {
        questionId: qId, isCorrect, points, correctAnswerId, totalScore: participant.score,
      });
      broadcastLeaderboard(io, sessionId);
    });

    // ── race_finish ────────────────────────────────────────────────────────
    socket.on('race_finish', async ({ sessionId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const session = raceSessions.get(sessionId);
      if (!session) return;

      const userId = payload.sub; // UUID string
      const participant = session.participants.get(userId);
      if (!participant || participant.finishedAt) return;

      const totalTimeMs = session.startedAtMs ? (Date.now() - session.startedAtMs) : 0;
      participant.finishedAt  = Date.now();
      participant.totalTimeMs = totalTimeMs;

      try {
        await pool.query(
          `UPDATE quiz_race_participants SET finished_at = now(), total_time_ms = $1 WHERE id = $2`,
          [totalTimeMs, participant.dbId]
        );
      } catch (err) {
        console.error('race_finish (DB) error:', err);
      }

      const board = buildLeaderboard(session);
      const mine  = board.find(p => p.studentId === userId);

      io.to(`race:${sessionId}`).emit('race_participant_finished', {
        studentId: userId, name: participant.name,
        rank: mine ? mine.rank : null, score: participant.score,
      });
      io.to(`race:${sessionId}`).emit('race_leaderboard_update', { leaderboard: board });

      const allFinished = Array.from(session.participants.values()).every(p => !!p.finishedAt);
      if (allFinished && session.participants.size > 0) {
        await endSession(io, session);
      }
    });

    // ── race_end (teacher manual end) ─────────────────────────────────────
    socket.on('race_end', async ({ sessionId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const session = raceSessions.get(sessionId);
      if (!session) return;
      if (Number(payload.roleId) !== 2 || session.teacherId !== payload.sub) {
        return socket.emit('error', { message: 'Only the teacher can end the race.' });
      }
      await endSession(io, session);
    });

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { sessionId, userId, roleId } = socket.data || {};
      if (!sessionId || !userId || Number(roleId) !== 1) return;

      const session = raceSessions.get(sessionId);
      if (!session) return;
      const participant = session.participants.get(userId);
      if (participant) {
        participant.online = false;
        participant.socketId = null;
        broadcastLeaderboard(io, sessionId);
      }
    });
  });
}

/**
 * Ends whatever live race session exists for a class+quiz pair, if any.
 * Used by classRoutes.js when a teacher removes a racing quiz's exposure,
 * so a lingering session doesn't stay joinable after it's been un-exposed.
 */
async function endActiveRaceForClassQuiz(io, classId, quizId) {
  const sessionId = activeByClassQuiz.get(keyOf(classId, Number(quizId)));
  const session = sessionId ? raceSessions.get(sessionId) : null;
  if (session) await endSession(io, session);
}

module.exports = { router, registerRaceSocketHandlers, endActiveRaceForClassQuiz };