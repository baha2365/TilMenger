const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { pool } = require('./Db');

const SALT_ROUNDS = 12;

// ─── Helper: sign a JWT ───────────────────────────────────────────────────────
function signToken(userId, roleId) {
  return jwt.sign(
    { sub: userId, roleId },          // roleId embedded in every token
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ─── Helper: safe user object (no password) ───────────────────────────────────
function safeUser(row) {
  return {
    id:        row.id,
    name:      row.name,
    email:     row.email,
    level:     row.level,
    roleId:    row.role_id,           // exposed so the frontend knows the role
    createdAt: row.created_at,
  };
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
async function register(req, res) {
  const { name, email, password, level } = req.body;

  try {
    // 1. Check uniqueness
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({
        success: false,
        errors: [{ field: 'email', message: 'An account with this email already exists.' }],
      });
    }

    // 2. Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // 3. Insert user — role_id defaults to 1 (student) via the DB column default
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password, level)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.trim(), email, hashedPassword, level]
    );

    const user  = rows[0];
    const token = signToken(user.id, user.role_id);   // pass role_id

    return res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password } = req.body;

  try {
    // 1. Find user
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const user = rows[0];

    // 2. Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // 3. Issue token — include role_id in the payload
    const token = signToken(user.id, user.role_id);   // pass role_id

    return res.status(200).json({
      success: true,
      message: 'Login successful!',
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// ─── GET /api/auth/me  (protected) ───────────────────────────────────────────
async function getMe(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, level, role_id, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    return res.status(200).json({ success: true, user: safeUser(rows[0]) });
  } catch (err) {
    console.error('getMe error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

module.exports = { register, login, getMe };