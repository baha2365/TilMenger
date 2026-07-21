/**
 * classRoutes.js
 *
 * Sub-router mounted at /:courseId/classes inside courseRoutes.js.
 *
 *   POST   /api/courses/:courseId/classes          – create a class
 *   GET    /api/courses/:courseId/classes          – list classes in a course
 *   GET    /api/courses/:courseId/classes/:id      – get one class
 *   PATCH  /api/courses/:courseId/classes/:id      – update a class
 *   DELETE /api/courses/:courseId/classes/:id      – delete a class
 *
 * Auth: teacher must own the parent course.
 *
 * NOTE: student_id (and every other user id in this file) is a UUID
 * string as of the users-to-uuid migration — validated with UUID_RE,
 * never coerced with Number()/Number.isInteger().
 */

'use strict';

const express = require('express');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware');
const { v4: uuidv4 } = require('uuid');
const { endActiveRaceForClassQuiz } = require('./raceRoutes');

// mergeParams: true gives us access to :courseId set by the parent router
const router = express.Router({ mergeParams: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true only if the teacher owns the course. */
async function ownsCourse(courseId, teacherId) {
  const { rows } = await pool.query(
    'SELECT id FROM courses WHERE id = $1 AND teacher_id = $2',
    [courseId, teacherId]
  );
  return rows.length > 0;
}

function requireTeacher(req, res, next) {
  if (!req.userId || String(req.userRoleId) !== '2') {
    return res.status(403).json({
      success: false,
      message: 'Access denied: only teachers can manage classes.',
    });
  }
  next();
}

// ─── POST /api/courses/:courseId/classes ──────────────────────────────────────
router.post('/', authenticate, requireTeacher, async (req, res) => {
  const { courseId } = req.params;
  const { name, description, schedule } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Class name is required.' });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ success: false, message: 'Class name must be 200 characters or fewer.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO classes (id, course_id, teacher_id, name, description, schedule)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        uuidv4(),
        courseId,
        req.userId,            // teacher who created this class
        name.trim(),
        description ? description.trim() : null,
        schedule    ? schedule.trim()    : null,
      ]
    );
    return res.status(201).json({ success: true, message: 'Class created.', class: rows[0] });
  } catch (err) {
    console.error('Create class error:', err);
    return res.status(500).json({ success: false, message: 'Could not create class.' });
  }
});

// ─── GET /api/courses/:courseId/classes ───────────────────────────────────────
router.get('/', authenticate, requireTeacher, async (req, res) => {
  const { courseId } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `SELECT * FROM classes WHERE course_id = $1 ORDER BY created_at ASC`,
      [courseId]
    );
    return res.json({ success: true, classes: rows });
  } catch (err) {
    console.error('List classes error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch classes.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id ───────────────────────────────────
router.get('/:id', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `SELECT * FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }
    return res.json({ success: true, class: rows[0] });
  } catch (err) {
    console.error('Get class error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch class.' });
  }
});

// ─── PATCH /api/courses/:courseId/classes/:id ─────────────────────────────────
router.patch('/:id', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { name, description, schedule, is_active } = req.body;

  const updates = [];
  const values  = [];
  let idx = 1;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ success: false, message: 'Name cannot be empty.' });
    if (name.trim().length > 200) return res.status(400).json({ success: false, message: 'Name too long.' });
    updates.push(`name = $${idx++}`);
    values.push(name.trim());
  }
  if (description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(description ? description.trim() : null);
  }
  if (schedule !== undefined) {
    updates.push(`schedule = $${idx++}`);
    values.push(schedule ? schedule.trim() : null);
  }
  if (is_active !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(Boolean(is_active));
  }

  if (!updates.length) {
    return res.status(400).json({ success: false, message: 'No fields provided to update.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    values.push(id, courseId);
    const { rows } = await pool.query(
      `UPDATE classes SET ${updates.join(', ')}
       WHERE id = $${idx} AND course_id = $${idx + 1}
       RETURNING *`,
      values
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }
    return res.json({ success: true, message: 'Class updated.', class: rows[0] });
  } catch (err) {
    console.error('Update class error:', err);
    return res.status(500).json({ success: false, message: 'Could not update class.' });
  }
});

// ─── DELETE /api/courses/:courseId/classes/:id ────────────────────────────────
router.delete('/:id', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }
    return res.json({ success: true, message: 'Class deleted.' });
  } catch (err) {
    console.error('Delete class error:', err);
    return res.status(500).json({ success: false, message: 'Could not delete class.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id/lookup-student ───────────────────
// Find a student by email before enrolling. Returns student info + already_enrolled flag.
router.get('/:id/lookup-student', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { email } = req.query;

  if (!email || !email.trim()) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    // Find user by email who is a student (role_id = 1)
    const { rows: users } = await pool.query(
      `SELECT id, name, email, level FROM users WHERE LOWER(email) = LOWER($1) AND role_id = 1`,
      [email.trim()]
    );

    if (!users.length) {
      return res.status(404).json({ success: false, message: 'No student account found with that email.' });
    }

    const student = users[0]; // student.id is a UUID string

    // Check if already enrolled in this class
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`,
      [id, student.id]
    );

    return res.json({
      success:          true,
      student,
      already_enrolled: existing.length > 0,
    });
  } catch (err) {
    console.error('Lookup student error:', err);
    return res.status(500).json({ success: false, message: 'Could not look up student.' });
  }
});

// ─── POST /api/courses/:courseId/classes/:id/enroll ──────────────────────────
// Enroll a student (student_id from body) into this class.
// Only the teacher who owns the course can do this.
router.post('/:id/enroll', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { student_id } = req.body;

  if (!student_id || !UUID_RE.test(student_id)) {
    return res.status(400).json({ success: false, message: 'A valid student_id (UUID) is required.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    // Confirm target user exists and is a student (role_id = 1)
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role_id = 1`,
      [student_id]
    );
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    // Confirm class exists in this course
    const { rows: classRows } = await pool.query(
      `SELECT id FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!classRows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    await pool.query(
      `INSERT INTO class_enrollments (class_id, student_id)
       VALUES ($1, $2)
       ON CONFLICT (class_id, student_id) DO NOTHING`,
      [id, student_id]
    );
    return res.status(201).json({ success: true, message: 'Student enrolled.' });
  } catch (err) {
    console.error('Enroll student error:', err);
    return res.status(500).json({ success: false, message: 'Could not enroll student.' });
  }
});

// ─── DELETE /api/courses/:courseId/classes/:id/enroll/:studentId ──────────────
// Remove a student from this class.
router.delete('/:id/enroll/:studentId', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id, studentId } = req.params;

  if (!UUID_RE.test(studentId)) {
    return res.status(400).json({ success: false, message: 'Invalid student id.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM class_enrollments WHERE class_id = $1 AND student_id = $2`,
      [id, studentId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Enrollment not found.' });
    }
    return res.json({ success: true, message: 'Student removed from class.' });
  } catch (err) {
    console.error('Remove student error:', err);
    return res.status(500).json({ success: false, message: 'Could not remove student.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id/students ─────────────────────────
// List all students enrolled in a class.
router.get('/:id/students', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.level, ce.enrolled_at
       FROM class_enrollments ce
       JOIN users u ON u.id = ce.student_id
       WHERE ce.class_id = $1
       ORDER BY ce.enrolled_at ASC`,
      [id]
    );
    return res.json({ success: true, students: rows });
  } catch (err) {
    console.error('List students error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch students.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id/reading-tasks ────────────────────
// List reading tasks currently exposed to this class.
router.get('/:id/reading-tasks', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `SELECT rt.id, rt.title, rt.level, cra.assigned_at,
              COUNT(rq.id)::int AS question_count
         FROM class_reading_assignments cra
         JOIN reading_tasks rt ON rt.id = cra.task_id
         LEFT JOIN reading_questions rq ON rq.task_id = rt.id
        WHERE cra.class_id = $1
        GROUP BY rt.id, cra.assigned_at
        ORDER BY cra.assigned_at DESC`,
      [id]
    );
    return res.json({ success: true, tasks: rows });
  } catch (err) {
    console.error('List class reading tasks error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch reading tasks.' });
  }
});

// ─── POST /api/courses/:courseId/classes/:id/reading-tasks ───────────────────
// Body: { task_ids: [1, 2, 3] } — expose one or more of the teacher's own tasks.
router.post('/:id/reading-tasks', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { task_ids } = req.body;

  if (!Array.isArray(task_ids) || !task_ids.length) {
    return res.status(400).json({ success: false, message: 'task_ids (non-empty array) is required.' });
  }
  const cleanIds = [...new Set(task_ids.map(Number).filter(Number.isInteger))];
  if (!cleanIds.length) {
    return res.status(400).json({ success: false, message: 'task_ids must contain valid integers.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows: classRows } = await pool.query(
      `SELECT id FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!classRows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    // Confirm every task belongs to this teacher before exposing any of them
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM reading_tasks WHERE id = ANY($1::int[]) AND teacher_id = $2`,
      [cleanIds, req.userId]
    );
    if (ownedRows.length !== cleanIds.length) {
      return res.status(403).json({ success: false, message: 'One or more tasks are not yours.' });
    }

    for (const taskId of cleanIds) {
      await pool.query(
        `INSERT INTO class_reading_assignments (class_id, task_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (class_id, task_id) DO NOTHING`,
        [id, taskId, req.userId]
      );
    }

    const { rows: tasks } = await pool.query(
      `SELECT rt.id, rt.title, rt.level, cra.assigned_at,
              COUNT(rq.id)::int AS question_count
         FROM class_reading_assignments cra
         JOIN reading_tasks rt ON rt.id = cra.task_id
         LEFT JOIN reading_questions rq ON rq.task_id = rt.id
        WHERE cra.class_id = $1
        GROUP BY rt.id, cra.assigned_at
        ORDER BY cra.assigned_at DESC`,
      [id]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('reading_assigned', {
        classId: id,
        tasks: tasks.filter(t => cleanIds.includes(t.id)),
      });
    }

    return res.status(201).json({ success: true, message: 'Reading task(s) exposed.', tasks });
  } catch (err) {
    console.error('Expose reading tasks error:', err);
    return res.status(500).json({ success: false, message: 'Could not expose reading tasks.' });
  }
});

// ─── DELETE /api/courses/:courseId/classes/:id/reading-tasks/:taskId ─────────
router.delete('/:id/reading-tasks/:taskId', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id, taskId } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM class_reading_assignments WHERE class_id = $1 AND task_id = $2`,
      [id, taskId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('reading_unassigned', { classId: id, taskId: Number(taskId) });
    }

    return res.json({ success: true, message: 'Reading task removed from class.' });
  } catch (err) {
    console.error('Remove class reading task error:', err);
    return res.status(500).json({ success: false, message: 'Could not remove reading task.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id/quizzes ───────────────────────────
// List quizzes currently exposed to this class.
router.get('/:id/quizzes', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows } = await pool.query(
      `SELECT q.id, q.title, q.description, cqa.assigned_at, cqa.mode,
              COUNT(qq.id)::int AS question_count
         FROM class_quiz_assignments cqa
         JOIN quizzes q ON q.id = cqa.quiz_id
         LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
        WHERE cqa.class_id = $1
        GROUP BY q.id, cqa.assigned_at, cqa.mode
        ORDER BY cqa.assigned_at DESC`,
      [id]
    );
    return res.json({ success: true, quizzes: rows });
  } catch (err) {
    console.error('List class quizzes error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch quizzes.' });
  }
});

// ─── POST /api/courses/:courseId/classes/:id/quizzes ──────────────────────────
// Body: { quiz_ids: [1, 2, 3], mode: 'casual' | 'racing' } — expose one or more
// of the teacher's own quizzes, either as replayable casual quizzes or as a
// single-attempt live racing round.
router.post('/:id/quizzes', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { quiz_ids, mode = 'casual' } = req.body;

  if (!Array.isArray(quiz_ids) || !quiz_ids.length) {
    return res.status(400).json({ success: false, message: 'quiz_ids (non-empty array) is required.' });
  }
  const cleanIds = [...new Set(quiz_ids.map(Number).filter(Number.isInteger))];
  if (!cleanIds.length) {
    return res.status(400).json({ success: false, message: 'quiz_ids must contain valid integers.' });
  }
  if (!['casual', 'racing'].includes(mode)) {
    return res.status(400).json({ success: false, message: "mode must be 'casual' or 'racing'." });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rows: classRows } = await pool.query(
      `SELECT id FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!classRows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    // Confirm every quiz belongs to this teacher before exposing any of them
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM quizzes WHERE id = ANY($1::int[]) AND created_by = $2`,
      [cleanIds, req.userId]
    );
    if (ownedRows.length !== cleanIds.length) {
      return res.status(403).json({ success: false, message: 'One or more quizzes are not yours.' });
    }

    for (const quizId of cleanIds) {
      await pool.query(
        `INSERT INTO class_quiz_assignments (class_id, quiz_id, assigned_by, mode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (class_id, quiz_id) DO UPDATE SET mode = EXCLUDED.mode`,
        [id, quizId, req.userId, mode]
      );
    }

    const { rows: quizzes } = await pool.query(
      `SELECT q.id, q.title, q.description, cqa.assigned_at, cqa.mode,
              COUNT(qq.id)::int AS question_count
         FROM class_quiz_assignments cqa
         JOIN quizzes q ON q.id = cqa.quiz_id
         LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
        WHERE cqa.class_id = $1
        GROUP BY q.id, cqa.assigned_at, cqa.mode
        ORDER BY cqa.assigned_at DESC`,
      [id]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('quiz_assigned', {
        classId: id,
        quizzes: quizzes.filter(q => cleanIds.includes(q.id)),
      });
    }

    return res.status(201).json({ success: true, message: 'Quiz(zes) exposed.', quizzes });
  } catch (err) {
    console.error('Expose quizzes error:', err);
    return res.status(500).json({ success: false, message: 'Could not expose quizzes.' });
  }
});

// ─── DELETE /api/courses/:courseId/classes/:id/quizzes/:quizId ────────────────
router.delete('/:id/quizzes/:quizId', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id, quizId } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM class_quiz_assignments WHERE class_id = $1 AND quiz_id = $2`,
      [id, quizId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('quiz_unassigned', { classId: id, quizId: Number(quizId) });
      // If this was a racing quiz with a live session, close it out so nobody
      // is left in a joinable-but-invisible race.
      await endActiveRaceForClassQuiz(io, id, quizId);
    }

    return res.json({ success: true, message: 'Quiz removed from class.' });
  } catch (err) {
    console.error('Remove class quiz error:', err);
    return res.status(500).json({ success: false, message: 'Could not remove quiz.' });
  }
});

// ─── GET /api/courses/:courseId/classes/:id/topics ───────────────────────────
// List topics/homeworks currently exposed to this class.
router.get('/:id/topics', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    const { rows } = await pool.query(
      `SELECT tt.id, tt.title, tt.video_url, cta.assigned_at,
              COUNT(tq.id)::int AS question_count
         FROM class_topic_assignments cta
         JOIN topic_tasks tt ON tt.id = cta.task_id
         LEFT JOIN topic_questions tq ON tq.task_id = tt.id
        WHERE cta.class_id = $1
        GROUP BY tt.id, cta.assigned_at
        ORDER BY cta.assigned_at DESC`,
      [id]
    );
    return res.json({ success: true, tasks: rows });
  } catch (err) {
    console.error('List class topics error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch topics.' });
  }
});

// ─── POST /api/courses/:courseId/classes/:id/topics ──────────────────────────
// Body: { task_ids: [1, 2, 3] } — expose one or more of the teacher's own topics.
router.post('/:id/topics', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id } = req.params;
  const { task_ids } = req.body;

  if (!Array.isArray(task_ids) || !task_ids.length) {
    return res.status(400).json({ success: false, message: 'task_ids (non-empty array) is required.' });
  }
  const cleanIds = [...new Set(task_ids.map(Number).filter(Number.isInteger))];
  if (!cleanIds.length) {
    return res.status(400).json({ success: false, message: 'task_ids must contain valid integers.' });
  }

  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    const { rows: classRows } = await pool.query(
      `SELECT id FROM classes WHERE id = $1 AND course_id = $2`,
      [id, courseId]
    );
    if (!classRows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM topic_tasks WHERE id = ANY($1::int[]) AND teacher_id = $2`,
      [cleanIds, req.userId]
    );
    if (ownedRows.length !== cleanIds.length) {
      return res.status(403).json({ success: false, message: 'One or more topics are not yours.' });
    }

    for (const taskId of cleanIds) {
      await pool.query(
        `INSERT INTO class_topic_assignments (class_id, task_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (class_id, task_id) DO NOTHING`,
        [id, taskId, req.userId]
      );
    }

    const { rows: tasks } = await pool.query(
      `SELECT tt.id, tt.title, tt.video_url, cta.assigned_at,
              COUNT(tq.id)::int AS question_count
         FROM class_topic_assignments cta
         JOIN topic_tasks tt ON tt.id = cta.task_id
         LEFT JOIN topic_questions tq ON tq.task_id = tt.id
        WHERE cta.class_id = $1
        GROUP BY tt.id, cta.assigned_at
        ORDER BY cta.assigned_at DESC`,
      [id]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('topic_assigned', {
        classId: id,
        tasks: tasks.filter(t => cleanIds.includes(t.id)),
      });
    }

    return res.status(201).json({ success: true, message: 'Topic(s) exposed.', tasks });
  } catch (err) {
    console.error('Expose topics error:', err);
    return res.status(500).json({ success: false, message: 'Could not expose topics.' });
  }
});

// ─── DELETE /api/courses/:courseId/classes/:id/topics/:taskId ────────────────
router.delete('/:id/topics/:taskId', authenticate, requireTeacher, async (req, res) => {
  const { courseId, id, taskId } = req.params;
  try {
    if (!(await ownsCourse(courseId, req.userId))) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM class_topic_assignments WHERE class_id = $1 AND task_id = $2`,
      [id, taskId]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`class:${id}`).emit('topic_unassigned', { classId: id, taskId: Number(taskId) });
    }

    return res.json({ success: true, message: 'Topic removed from class.' });
  } catch (err) {
    console.error('Remove class topic error:', err);
    return res.status(500).json({ success: false, message: 'Could not remove topic.' });
  }
});

module.exports = router;