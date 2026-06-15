/**
 * studentRoutes.js
 *
 * Student-facing endpoints for viewing classes they're enrolled in.
 * Mounted at /api/student in server.js.
 *
 *   GET /api/student/classes                 – list classes the student is enrolled in
 *   GET /api/student/classes/:id             – get details of one enrolled class
 *   GET /api/student/classes/:id/classmates  – read-only roster of a class
 *
 * Auth: every route requires the caller to be a student (role_id = 1) and,
 * for the :id routes, to actually be enrolled in that class.
 */

'use strict';

const express = require('express');
const { pool } = require('./Db');
const { authenticate } = require('./authMiddleware');
const { authorizeRole, ROLE_IDS } = require('./roleMiddleware');

const router = express.Router();

// ─── GET /api/student/classes ─────────────────────────────────────────────────
// List every class the logged-in student is enrolled in, newest enrollment first.
router.get('/classes', authenticate, authorizeRole(ROLE_IDS.student), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id, c.name, c.description, c.schedule, c.is_active, c.created_at,
         co.id   AS course_id,
         co.name AS course_name,
         t.name  AS teacher_name,
         ce.enrolled_at,
         (SELECT COUNT(*)::int FROM class_enrollments WHERE class_id = c.id) AS student_count
       FROM class_enrollments ce
       JOIN classes c  ON c.id  = ce.class_id
       JOIN courses co ON co.id = c.course_id
       JOIN users   t  ON t.id  = c.teacher_id
       WHERE ce.student_id = $1
       ORDER BY ce.enrolled_at DESC`,
      [req.userId]
    );
    return res.json({ success: true, classes: rows });
  } catch (err) {
    console.error('List student classes error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch your classes.' });
  }
});

// ─── GET /api/student/classes/:id ──────────────────────────────────────────────
// Get details of one class — only if the student is enrolled in it.
router.get('/classes/:id', authenticate, authorizeRole(ROLE_IDS.student), async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: enrolled } = await pool.query(
      `SELECT enrolled_at FROM class_enrollments WHERE class_id = $1 AND student_id = $2`,
      [id, req.userId]
    );
    if (!enrolled.length) {
      return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
    }

    const { rows } = await pool.query(
      `SELECT
         c.id, c.name, c.description, c.schedule, c.is_active, c.created_at,
         co.id   AS course_id,
         co.name AS course_name,
         t.name  AS teacher_name,
         t.email AS teacher_email,
         (SELECT COUNT(*)::int FROM class_enrollments WHERE class_id = c.id) AS student_count
       FROM classes c
       JOIN courses co ON co.id = c.course_id
       JOIN users   t  ON t.id  = c.teacher_id
       WHERE c.id = $1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    return res.json({
      success: true,
      class: { ...rows[0], enrolled_at: enrolled[0].enrolled_at },
    });
  } catch (err) {
    console.error('Get student class details error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch class details.' });
  }
});

// ─── GET /api/student/classes/:id/classmates ───────────────────────────────────
// Read-only roster — everyone enrolled in the class, including the caller.
router.get('/classes/:id/classmates', authenticate, authorizeRole(ROLE_IDS.student), async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: enrolled } = await pool.query(
      `SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`,
      [id, req.userId]
    );
    if (!enrolled.length) {
      return res.status(403).json({ success: false, message: 'You are not enrolled in this class.' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.level, ce.enrolled_at
       FROM class_enrollments ce
       JOIN users u ON u.id = ce.student_id
       WHERE ce.class_id = $1
       ORDER BY ce.enrolled_at ASC`,
      [id]
    );
    return res.json({ success: true, classmates: rows });
  } catch (err) {
    console.error('List classmates error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch classmates.' });
  }
});

module.exports = router;