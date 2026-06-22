const express  = require('express');
const { authenticate } = require('./authMiddleware');
const { pool } = require('./Db');

const router = express.Router();

// All vocab routes are protected
router.use(authenticate);

// ─── Level code → level name mapping ─────────────────────────────────────────
function extractLevelCode(userLevel) {
  if (!userLevel) return null;
  const match = userLevel.match(/([ABC][12]-[ABC][12])/);
  return match ? match[1] : null;
}

// ─── GET /api/vocab/parts ─────────────────────────────────────────────────────
router.get('/parts', async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT level FROM users WHERE id = $1',
      [req.userId]
    );
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const levelCode = extractLevelCode(userRows[0].level);
    if (!levelCode) {
      return res.status(400).json({ success: false, message: 'Invalid user level.' });
    }

    const { rows: levelRows } = await pool.query(
      'SELECT id FROM levels WHERE code = $1',
      [levelCode]
    );
    if (!levelRows.length) {
      return res.status(404).json({ success: false, message: `Level "${levelCode}" not found in DB.` });
    }

    const levelId = levelRows[0].id;

    const { rows: parts } = await pool.query(
      `SELECT id, part_number
       FROM parts
       WHERE level_id = $1
       ORDER BY part_number ASC`,
      [levelId]
    );

    return res.json({ success: true, parts });
  } catch (err) {
    console.error('GET /vocab/parts error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// ─── GET /api/vocab/words/:partId ─────────────────────────────────────────────
router.get('/words/:partId', async (req, res) => {
  const partId = parseInt(req.params.partId, 10);
  if (isNaN(partId)) {
    return res.status(400).json({ success: false, message: 'Invalid part ID.' });
  }

  try {
    const { rows: words } = await pool.query(
      `SELECT id, english, kazakh, image, audio
       FROM words
       WHERE part_id = $1
       ORDER BY id ASC`,
      [partId]
    );

    return res.json({ success: true, words });
  } catch (err) {
    console.error('GET /vocab/words error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// ─── GET /api/vocab/sentences/:partId ────────────────────────────────────────
// Returns all sentences for a specific part, along with the part_number.
// Used by sentence_builder.html for the drag-and-drop exercise.
router.get('/sentences/:partId', async (req, res) => {
  const partId = parseInt(req.params.partId, 10);
  if (isNaN(partId)) {
    return res.status(400).json({ success: false, message: 'Invalid part ID.' });
  }

  try {
    // Fetch sentences for this part
    const { rows: sentences } = await pool.query(
      `SELECT id, part_id, correct_sentence, kazakh_sentence
       FROM sentences
       WHERE part_id = $1
       ORDER BY id ASC`,
      [partId]
    );

    if (!sentences.length) {
      return res.status(404).json({
        success: false,
        message: `No sentences found for part ${partId}.`,
      });
    }

    // Also return part_number so the frontend can display "Part X"
    const { rows: partRows } = await pool.query(
      'SELECT part_number FROM parts WHERE id = $1',
      [partId]
    );
    const part_number = partRows.length ? partRows[0].part_number : partId;

    return res.json({ success: true, part_number, sentences });
  } catch (err) {
    console.error('GET /vocab/sentences error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// ─── GET /api/vocab/progress ──────────────────────────────────────────────────
router.get('/progress', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT part_id FROM progress
       WHERE user_id = $1 AND is_completed = TRUE`,
      [req.userId]
    );
    const completed = rows.map(r => r.part_id);
    return res.json({ success: true, completed });
  } catch (err) {
    console.error('GET /vocab/progress error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// ─── POST /api/vocab/progress/complete ───────────────────────────────────────
router.post('/progress/complete', async (req, res) => {
  const { part_id } = req.body;
  if (!part_id) {
    return res.status(400).json({ success: false, message: 'part_id is required.' });
  }

  try {
    await pool.query(
      `INSERT INTO progress (user_id, part_id, is_completed, completed_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id, part_id)
       DO UPDATE SET is_completed = TRUE, completed_at = NOW()`,
      [req.userId, part_id]
    );
    return res.json({ success: true, message: 'Part marked as complete.' });
  } catch (err) {
    console.error('POST /vocab/progress/complete error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

module.exports = router;