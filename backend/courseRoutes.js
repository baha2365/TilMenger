/**
 * courseRoutes.js
 *
 * Mounted at /api/courses in server.js
 *
 * Routes:
 *   POST   /api/courses              – create a course (teacher only)
 *   GET    /api/courses              – list my courses (teacher only)
 *   GET    /api/courses/:id          – get one course  (teacher only, must own it)
 *   PATCH  /api/courses/:id          – update a course (teacher only, must own it)
 *   DELETE /api/courses/:id          – delete a course (teacher only, must own it)
 *   POST   /api/courses/:id/regen    – regenerate invitation code (teacher only)
 */

'use strict';

const express = require('express');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware'); // ← FIX 1: was 'verifyToken'
const { v4: uuidv4 } = require('uuid');
const classRoutes = require('./classRoutes');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateInviteCode() {
  const { randomBytes } = require('crypto');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code.slice(0, 4) + '-' + code.slice(4);
}

async function insertCourseWithRetry(client, { teacherId, name, description, level }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const courseId   = uuidv4();
    const inviteCode = generateInviteCode();
    try {
      const { rows } = await client.query(
        `INSERT INTO courses (id, teacher_id, name, description, level, invitation_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [courseId, teacherId, name, description || null, level, inviteCode]
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505' && attempt < 4) continue;
      throw err;
    }
  }
}

// ─── Middleware: teacher-only guard ───────────────────────────────────────────

function requireTeacher(req, res, next) {
  // ← FIX 2: authMiddleware sets req.userId and req.userRoleId (not req.user)
  if (!req.userId || String(req.userRoleId) !== '2') {
    return res.status(403).json({
      success: false,
      message: 'Access denied: only teachers can manage courses.',
    });
  }
  next();
}

// ─── POST /api/courses ────────────────────────────────────────────────────────
router.post('/', authenticate, requireTeacher, async (req, res) => {
  const { name, description, level } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Course name is required.' });
  }
  const VALID_LEVELS = ['A1-A2', 'B1-B2', 'C1-C2'];
  if (!VALID_LEVELS.includes(level)) {
    return res.status(400).json({
      success: false,
      message: `Level must be one of: ${VALID_LEVELS.join(', ')}.`,
    });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ success: false, message: 'Course name must be 200 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    const course = await insertCourseWithRetry(client, {
      teacherId:   req.userId,          // ← FIX 2
      name:        name.trim(),
      description: description ? description.trim() : null,
      level,
    });
    return res.status(201).json({ success: true, message: 'Course created successfully.', course });
  } catch (err) {
    console.error('Create course error:', err);
    return res.status(500).json({ success: false, message: 'Could not create course.' });
  } finally {
    client.release();
  }
});

// ─── GET /api/courses ─────────────────────────────────────────────────────────
router.get('/', authenticate, requireTeacher, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM courses WHERE teacher_id = $1 ORDER BY created_at DESC`,
      [req.userId]                        // ← FIX 2
    );
    return res.json({ success: true, courses: rows });
  } catch (err) {
    console.error('List courses error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch courses.' });
  }
});

// ─── GET /api/courses/:id ─────────────────────────────────────────────────────
router.get('/:id', authenticate, requireTeacher, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM courses WHERE id = $1 AND teacher_id = $2`,
      [req.params.id, req.userId]         // ← FIX 2
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    return res.json({ success: true, course: rows[0] });
  } catch (err) {
    console.error('Get course error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch course.' });
  }
});

// ─── PATCH /api/courses/:id ───────────────────────────────────────────────────
router.patch('/:id', authenticate, requireTeacher, async (req, res) => {
  const { name, description, level, is_active } = req.body;

  const updates = [];
  const values  = [];
  let   idx     = 1;

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
  if (level !== undefined) {
    const VALID_LEVELS = ['A1-A2', 'B1-B2', 'C1-C2'];
    if (!VALID_LEVELS.includes(level)) {
      return res.status(400).json({ success: false, message: `Level must be one of: ${VALID_LEVELS.join(', ')}.` });
    }
    updates.push(`level = $${idx++}`);
    values.push(level);
  }
  if (is_active !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(Boolean(is_active));
  }

  if (!updates.length) {
    return res.status(400).json({ success: false, message: 'No fields provided to update.' });
  }

  values.push(req.params.id, req.userId); // ← FIX 2

  try {
    const { rows } = await pool.query(
      `UPDATE courses SET ${updates.join(', ')}
       WHERE id = $${idx} AND teacher_id = $${idx + 1}
       RETURNING *`,
      values
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    return res.json({ success: true, message: 'Course updated.', course: rows[0] });
  } catch (err) {
    console.error('Update course error:', err);
    return res.status(500).json({ success: false, message: 'Could not update course.' });
  }
});

// ─── DELETE /api/courses/:id ──────────────────────────────────────────────────
router.delete('/:id', authenticate, requireTeacher, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM courses WHERE id = $1 AND teacher_id = $2`,
      [req.params.id, req.userId]         // ← FIX 2
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }
    return res.json({ success: true, message: 'Course deleted.' });
  } catch (err) {
    console.error('Delete course error:', err);
    return res.status(500).json({ success: false, message: 'Could not delete course.' });
  }
});

// ─── POST /api/courses/:id/regen ──────────────────────────────────────────────
router.post('/:id/regen', authenticate, requireTeacher, async (req, res) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const newCode = generateInviteCode();
    try {
      const { rows } = await pool.query(
        `UPDATE courses SET invitation_code = $1
         WHERE id = $2 AND teacher_id = $3
         RETURNING *`,
        [newCode, req.params.id, req.userId] // ← FIX 2
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Course not found.' });
      }
      return res.json({ success: true, message: 'Invitation code regenerated.', course: rows[0] });
    } catch (err) {
      if (err.code === '23505' && attempt < 4) continue;
      console.error('Regen invite code error:', err);
      return res.status(500).json({ success: false, message: 'Could not regenerate code.' });
    }
  }
});

router.use('/:courseId/classes', classRoutes);

module.exports = router;