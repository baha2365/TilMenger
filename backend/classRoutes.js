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
 */

'use strict';

const express = require('express');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware');
const { v4: uuidv4 } = require('uuid');

// mergeParams: true gives us access to :courseId set by the parent router
const router = express.Router({ mergeParams: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
      `INSERT INTO classes (id, course_id, name, description, schedule)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        uuidv4(),
        courseId,
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

module.exports = router;