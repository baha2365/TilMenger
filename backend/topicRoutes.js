/**
 * topicRoutes.js
 *
 * "Topics & Homeworks" feature — a teacher posts a video link (YouTube,
 * Telegram, or any other platform — we only ever store the URL, never the
 * file itself) plus up to 4 comprehension questions. Students watch the
 * video and submit answers exactly ONCE — unlike the Reading feature,
 * there is no retake here.
 *
 * Endpoints:
 *   POST   /api/topics                 – teacher creates a topic/homework task
 *   GET    /api/topics                 – teacher lists their own tasks (+ counts)
 *   GET    /api/topics/:id             – teacher gets one full task (w/ correct answers)
 *   GET    /api/topics/:id/results     – teacher gets the student grade list for a task
 *   PATCH  /api/topics/:id             – teacher updates their own task
 *   DELETE /api/topics/:id             – teacher deletes their own task
 *   GET    /api/topics/:id/play        – student view (no correct-answer data)
 *   POST   /api/topics/:id/submit      – student submits answers (one attempt only)
 */

'use strict';

const express = require('express');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware');
const { authorizeRole, ROLE_IDS } = require('./roleMiddleware');

const router = express.Router();

const MAX_QUESTIONS = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLikelyUrl(str) {
  if (!str || typeof str !== 'string') return false;
  try {
    const u = new URL(str.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Fetch a full task (with questions + options, including is_correct). */
async function fetchFullTask(taskId) {
  const { rows: taskRows } = await pool.query(
    `SELECT tt.*, u.name AS teacher_name
       FROM topic_tasks tt
       JOIN users u ON u.id = tt.teacher_id
      WHERE tt.id = $1`,
    [taskId]
  );
  if (taskRows.length === 0) return null;
  const task = taskRows[0];

  const { rows: questions } = await pool.query(
    `SELECT tq.id, tq.sort_order, tq.question,
            json_agg(
              json_build_object(
                'id',          topt.id,
                'sort_order',  topt.sort_order,
                'option_text', topt.option_text,
                'is_correct',  topt.is_correct
              ) ORDER BY topt.sort_order
            ) AS options
       FROM topic_questions tq
       JOIN topic_options topt ON topt.question_id = tq.id
      WHERE tq.task_id = $1
      GROUP BY tq.id
      ORDER BY tq.sort_order`,
    [taskId]
  );

  task.questions = questions;
  return task;
}

/** Validate question/option arrays from request body. Returns error string or null. */
function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'At least one question is required.';
  }
  if (questions.length > MAX_QUESTIONS) {
    return `A topic/homework can have at most ${MAX_QUESTIONS} questions.`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.question || String(q.question).trim() === '') {
      return `Question ${i + 1} text is empty.`;
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return `Question ${i + 1} must have 2–4 answer options.`;
    }
    const correctOptions = q.options.filter((o) => o.is_correct === true);
    if (correctOptions.length !== 1) {
      return `Question ${i + 1} must have exactly one correct answer.`;
    }
    for (let j = 0; j < q.options.length; j++) {
      if (!q.options[j].option_text || String(q.options[j].option_text).trim() === '') {
        return `Question ${i + 1}, option ${j + 1} text is empty.`;
      }
    }
  }
  return null;
}

// ─── POST /api/topics  (teacher only) ────────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    const { title, description, video_url, questions } = req.body;

    if (!title || String(title).trim() === '') {
      return res.status(422).json({ success: false, message: 'Title is required.' });
    }
    if (!isLikelyUrl(video_url)) {
      return res.status(422).json({ success: false, message: 'A valid video URL (http/https) is required.' });
    }
    const qError = validateQuestions(questions);
    if (qError) return res.status(422).json({ success: false, message: qError });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: taskRows } = await client.query(
        `INSERT INTO topic_tasks (teacher_id, title, description, video_url)
           VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.userId, title.trim(), description ? description.trim() : null, video_url.trim()]
      );
      const taskId = taskRows[0].id;

      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        const { rows: qRows } = await client.query(
          `INSERT INTO topic_questions (task_id, sort_order, question)
             VALUES ($1, $2, $3) RETURNING id`,
          [taskId, qi, q.question.trim()]
        );
        const questionId = qRows[0].id;

        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          await client.query(
            `INSERT INTO topic_options (question_id, sort_order, option_text, is_correct)
               VALUES ($1, $2, $3, $4)`,
            [questionId, oi, opt.option_text.trim(), !!opt.is_correct]
          );
        }
      }

      await client.query('COMMIT');

      const task = await fetchFullTask(taskId);
      return res.status(201).json({ success: true, task });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/topics error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    } finally {
      client.release();
    }
  }
);

// ─── GET /api/topics  (teacher sees their own tasks, with counts) ────────────
router.get(
  '/',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT tt.id, tt.title, tt.description, tt.video_url, tt.created_at, tt.updated_at,
                COUNT(DISTINCT tq.id)::int AS question_count,
                COUNT(DISTINCT ts.id)::int AS submission_count,
                ROUND(AVG(CASE WHEN ts.id IS NOT NULL
                               THEN (ts.score::decimal / NULLIF(ts.total, 0)) * 100 END)) AS avg_score_pct
           FROM topic_tasks tt
           LEFT JOIN topic_questions tq   ON tq.task_id = tt.id
           LEFT JOIN topic_submissions ts ON ts.task_id = tt.id
          WHERE tt.teacher_id = $1
          GROUP BY tt.id
          ORDER BY tt.created_at DESC`,
        [req.userId]
      );
      const tasks = rows.map(r => ({ ...r, avg_score_pct: r.avg_score_pct === null ? null : Number(r.avg_score_pct) }));
      return res.json({ success: true, tasks });
    } catch (err) {
      console.error('GET /api/topics error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

// ─── GET /api/topics/:id  (full task with correct answers — teacher/admin) ───
router.get(
  '/:id',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    try {
      const task = await fetchFullTask(req.params.id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

      if (req.userRoleId === ROLE_IDS.teacher && task.teacher_id !== req.userId) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      return res.json({ success: true, task });
    } catch (err) {
      console.error('GET /api/topics/:id error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

// ─── GET /api/topics/:id/results  (teacher — grade list for a task) ──────────
router.get(
  '/:id/results',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    try {
      const { rows: taskRows } = await pool.query(
        'SELECT teacher_id FROM topic_tasks WHERE id = $1',
        [req.params.id]
      );
      if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found.' });
      if (req.userRoleId === ROLE_IDS.teacher && taskRows[0].teacher_id !== req.userId) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      const { rows } = await pool.query(
        `SELECT u.id AS student_id, u.name, u.email, ts.score, ts.total, ts.submitted_at
           FROM topic_submissions ts
           JOIN users u ON u.id = ts.student_id
          WHERE ts.task_id = $1
          ORDER BY ts.submitted_at DESC`,
        [req.params.id]
      );
      return res.json({ success: true, submissions: rows });
    } catch (err) {
      console.error('GET /api/topics/:id/results error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

// ─── GET /api/topics/:id/play  (student view — no is_correct) ────────────────
router.get(
  '/:id/play',
  authenticate,
  authorizeRole(ROLE_IDS.student),
  async (req, res) => {
    try {
      const { rows: taskRows } = await pool.query(
        `SELECT tt.id, tt.title, tt.description, tt.video_url, u.name AS teacher_name
           FROM topic_tasks tt
           JOIN users u ON u.id = tt.teacher_id
          WHERE tt.id = $1`,
        [req.params.id]
      );
      if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found.' });
      const task = taskRows[0];

      // One-attempt gate: has this student already submitted?
      const { rows: subRows } = await pool.query(
        `SELECT id, score, total, submitted_at
           FROM topic_submissions WHERE task_id = $1 AND student_id = $2`,
        [req.params.id, req.userId]
      );
      const submission = subRows[0] || null;

      const { rows: questions } = await pool.query(
        `SELECT tq.id, tq.sort_order, tq.question,
                json_agg(
                  json_build_object('id', topt.id, 'sort_order', topt.sort_order, 'option_text', topt.option_text)
                  ORDER BY topt.sort_order
                ) AS options
           FROM topic_questions tq
           JOIN topic_options topt ON topt.question_id = tq.id
          WHERE tq.task_id = $1
          GROUP BY tq.id
          ORDER BY tq.sort_order`,
        [req.params.id]
      );
      task.questions = questions;

      // Already submitted -> also hand back a read-only review (their picks +
      // the correct answers) so the frontend can render results instead of
      // letting them attempt it again.
      let review = null;
      if (submission) {
        const { rows: answerRows } = await pool.query(
          `SELECT tsa.question_id, tsa.option_id, tsa.is_correct,
                  (SELECT id FROM topic_options WHERE question_id = tsa.question_id AND is_correct = TRUE) AS correct_option_id
             FROM topic_submission_answers tsa
            WHERE tsa.submission_id = $1`,
          [submission.id]
        );
        review = { answers: answerRows };
      }

      return res.json({ success: true, task, submission, review });
    } catch (err) {
      console.error('GET /api/topics/:id/play error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

// ─── POST /api/topics/:id/submit  (student submits — ONE attempt only) ───────
// Body: { answers: { [questionId]: optionId } }
router.post(
  '/:id/submit',
  authenticate,
  authorizeRole(ROLE_IDS.student),
  async (req, res) => {
    const { answers } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(422).json({ success: false, message: 'answers object is required.' });
    }

    const client = await pool.connect();
    try {
      const { rows: taskRows } = await client.query('SELECT id FROM topic_tasks WHERE id = $1', [req.params.id]);
      if (!taskRows.length) {
        client.release();
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      const { rows: existing } = await client.query(
        'SELECT id FROM topic_submissions WHERE task_id = $1 AND student_id = $2',
        [req.params.id, req.userId]
      );
      if (existing.length) {
        client.release();
        return res.status(409).json({
          success: false,
          message: 'You have already submitted this task. Only one attempt is allowed.',
        });
      }

      const { rows: correctRows } = await client.query(
        `SELECT tq.id AS question_id, topt.id AS correct_option_id
           FROM topic_questions tq
           JOIN topic_options topt ON topt.question_id = tq.id AND topt.is_correct = TRUE
          WHERE tq.task_id = $1`,
        [req.params.id]
      );
      if (!correctRows.length) {
        client.release();
        return res.status(404).json({ success: false, message: 'Task has no questions.' });
      }

      await client.query('BEGIN');

      const total = correctRows.length;
      const { rows: subRows } = await client.query(
        `INSERT INTO topic_submissions (task_id, student_id, score, total)
           VALUES ($1, $2, 0, $3) RETURNING id`,
        [req.params.id, req.userId, total]
      );
      const submissionId = subRows[0].id;

      let score = 0;
      const results = {};
      for (const row of correctRows) {
        const qId = String(row.question_id);
        const submittedOptionId = answers[qId] != null ? Number(answers[qId]) : null;
        const isCorrect = submittedOptionId === row.correct_option_id;
        if (isCorrect) score++;

        await client.query(
          `INSERT INTO topic_submission_answers (submission_id, question_id, option_id, is_correct)
             VALUES ($1, $2, $3, $4)`,
          [submissionId, row.question_id, submittedOptionId, isCorrect]
        );
        results[qId] = { correct: isCorrect, correct_option_id: row.correct_option_id };
      }

      await client.query('UPDATE topic_submissions SET score = $1 WHERE id = $2', [score, submissionId]);
      await client.query('COMMIT');

      return res.json({ success: true, score, total, results });
    } catch (err) {
      await client.query('ROLLBACK');
      // Unique-constraint race: two near-simultaneous submits from the same student.
      if (err && err.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'You have already submitted this task. Only one attempt is allowed.',
        });
      }
      console.error('POST /api/topics/:id/submit error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    } finally {
      client.release();
    }
  }
);

// ─── PATCH /api/topics/:id  (teacher updates their own task) ─────────────────
router.patch(
  '/:id',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    const { title, description, video_url, questions } = req.body;

    if (video_url !== undefined && !isLikelyUrl(video_url)) {
      return res.status(422).json({ success: false, message: 'A valid video URL (http/https) is required.' });
    }

    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT teacher_id FROM topic_tasks WHERE id = $1', [req.params.id]);
      if (rows.length === 0) {
        client.release();
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }
      if (req.userRoleId === ROLE_IDS.teacher && rows[0].teacher_id !== req.userId) {
        client.release();
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      await client.query('BEGIN');

      await client.query(
        `UPDATE topic_tasks
            SET title       = COALESCE($1, title),
                description = COALESCE($2, description),
                video_url   = COALESCE($3, video_url),
                updated_at  = NOW()
          WHERE id = $4`,
        [
          title ? title.trim() : null,
          description !== undefined ? (description ? description.trim() : null) : null,
          video_url ? video_url.trim() : null,
          req.params.id,
        ]
      );

      if (questions) {
        const qError = validateQuestions(questions);
        if (qError) {
          await client.query('ROLLBACK');
          return res.status(422).json({ success: false, message: qError });
        }

        // NOTE: replacing questions after students have already submitted
        // will orphan their historical answer review — that's an accepted
        // tradeoff, same as the Reading feature's PATCH behavior.
        await client.query('DELETE FROM topic_questions WHERE task_id = $1', [req.params.id]);

        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi];
          const { rows: qRows } = await client.query(
            `INSERT INTO topic_questions (task_id, sort_order, question)
               VALUES ($1, $2, $3) RETURNING id`,
            [req.params.id, qi, q.question.trim()]
          );
          const questionId = qRows[0].id;
          for (let oi = 0; oi < q.options.length; oi++) {
            const opt = q.options[oi];
            await client.query(
              `INSERT INTO topic_options (question_id, sort_order, option_text, is_correct)
                 VALUES ($1, $2, $3, $4)`,
              [questionId, oi, opt.option_text.trim(), !!opt.is_correct]
            );
          }
        }
      }

      await client.query('COMMIT');

      const task = await fetchFullTask(req.params.id);
      return res.json({ success: true, task });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /api/topics/:id error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    } finally {
      client.release();
    }
  }
);

// ─── DELETE /api/topics/:id ───────────────────────────────────────────────────
router.delete(
  '/:id',
  authenticate,
  authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin),
  async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT teacher_id FROM topic_tasks WHERE id = $1', [req.params.id]);
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }
      if (req.userRoleId === ROLE_IDS.teacher && rows[0].teacher_id !== req.userId) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      await pool.query('DELETE FROM topic_tasks WHERE id = $1', [req.params.id]);
      return res.json({ success: true, message: 'Topic/homework deleted.' });
    } catch (err) {
      console.error('DELETE /api/topics/:id error:', err);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

module.exports = router;