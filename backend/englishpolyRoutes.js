/**
 * englishpolyRoutes.js
 *
 * Handles the Englishpoly GAME CREATOR — where teachers design reusable
 * custom boards (title, level, and a row of cells with questions/images).
 * This is separate from gameRoutes.js, which runs the LIVE multiplayer
 * session for a board once it's being played. Exposing a created poly to
 * a specific class ("play this board with my class") is future work — for
 * now teachers can only create, list, view, edit, and delete their own
 * poly designs.
 *
 * Mounted at /api/englishpoly in server.js.
 *
 *   POST   /api/englishpoly/games        – create a new poly
 *   GET    /api/englishpoly/games        – list the teacher's own polys (dashboard)
 *   GET    /api/englishpoly/games/:id    – get one poly + all its cells (review/edit)
 *   PATCH  /api/englishpoly/games/:id    – update a poly's info and/or cells
 *   DELETE /api/englishpoly/games/:id    – delete a poly
 *
 * CELL-COUNT / FINISH LOGIC (must match games_dashboard.html,
 * englishpoly_creator.html, and englishpoly_review.html exactly):
 *
 *   `cell_count` is the total number of cells a teacher "creates", not
 *   counting the fixed START cell. The LAST position (position ===
 *   cell_count) is always automatically the FINISH cell — it is never
 *   submitted by the client and is inserted server-side. So a teacher who
 *   sets cell_count = 10 is really authoring 9 real cells (positions 1-9)
 *   plus an automatic finish at position 10.
 *
 *   Bounds: 10 (minimum) to 32 (maximum — mirrors the fixed board's 31
 *   real cells + 1 finish cell in gameRoutes.js's BOARD_LENGTH = 33).
 *
 * CORNER LOGIC:
 *   Exactly 3 positions along the path are designated "corners" (roughly
 *   the 25%/50%/75% marks, mirroring the 3 non-start/finish corners of
 *   the original fixed board). Only corner positions may be turned into
 *   'bonus' or 'paf' cells; every other position must be 'question' or
 *   'picture'. computeCornerPositions() is the single source of truth for
 *   this and MUST be kept in sync with the identical helper duplicated in
 *   englishpoly_creator.html (browser code can't import this file
 *   directly, so the logic is intentionally small and pure).
 *
 * IMPORTANT — user ids:
 *   teacher_id is a UUID string (users.id is a uuid column as of the
 *   users-to-uuid migration) — never passed through Number().
 */

'use strict';

const express       = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool }      = require('./Db');
const { authenticate } = require('./authMiddleware');

const router = express.Router();

// ─── Constants ──────────────────────────────────────────────────────────────
const LEVELS          = ['beginner', 'elementary', 'intermediate', 'upper_intermediate', 'advanced'];
const CELL_TYPES       = ['question', 'picture', 'bonus', 'paf'];
const CORNER_ONLY_TYPES = new Set(['bonus', 'paf']);
const MIN_CELL_COUNT   = 10;
const MAX_CELL_COUNT   = 32;
const QUESTION_MIN_LEN = 3;
const QUESTION_MAX_LEN = 300;
const TITLE_MAX_LEN    = 200;
const DESC_MAX_LEN     = 2000;
const IMAGE_URL_RE     = /^https?:\/\/.+/i;

// ─── Helper: only teachers may use these routes ────────────────────────────
function requireTeacher(req, res, next) {
  if (!req.userId || String(req.userRoleId) !== '2') {
    return res.status(403).json({ success: false, message: 'Only teachers can do this.' });
  }
  next();
}

// ─── Helper: which positions along the path are "corners"? ────────────────
// Pure function — kept deliberately tiny so it can be mirrored exactly in
// englishpoly_creator.html's browser-side JS. See file header comment.
function computeCornerPositions(cellCount) {
  const lastRealPosition = cellCount - 1; // position `cellCount` is FINISH
  const raw = [
    Math.round(cellCount * 0.25),
    Math.round(cellCount * 0.5),
    Math.round(cellCount * 0.75),
  ];
  const used = new Set();
  const corners = [];
  for (let c of raw) {
    c = Math.max(1, Math.min(lastRealPosition, c));
    while (used.has(c) && c < lastRealPosition) c++;
    while (used.has(c) && c > 1) c--;
    used.add(c);
    corners.push(c);
  }
  return [...new Set(corners)].sort((a, b) => a - b);
}

// ─── Helper: validate + normalize a create/update payload ─────────────────
// Returns { errors: string[] } on failure, or { data } on success, where
// data.cells is the clean array ready for insertion (finish cell excluded
// — callers append it themselves).
function validateGamePayload(body) {
  const errors = [];

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('Title is required.');
  if (title.length > TITLE_MAX_LEN) errors.push(`Title must be ${TITLE_MAX_LEN} characters or fewer.`);

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > DESC_MAX_LEN) errors.push(`Description must be ${DESC_MAX_LEN} characters or fewer.`);

  const level = body.level;
  if (!LEVELS.includes(level)) errors.push('A valid level is required.');

  const cellCount = Number(body.cell_count);
  if (!Number.isInteger(cellCount) || cellCount < MIN_CELL_COUNT || cellCount > MAX_CELL_COUNT) {
    errors.push(`cell_count must be a whole number between ${MIN_CELL_COUNT} and ${MAX_CELL_COUNT}.`);
  }

  const cells = Array.isArray(body.cells) ? body.cells : null;
  if (!cells) errors.push('cells (array) is required.');

  if (errors.length) return { errors };

  const expectedLength = cellCount - 1; // finish is auto-appended, never submitted
  if (cells.length !== expectedLength) {
    errors.push(
      `Expected ${expectedLength} cell(s) for a ${cellCount}-cell board ` +
      `(position ${cellCount} is always the automatic FINISH cell), but received ${cells.length}.`
    );
    return { errors };
  }

  const corners = new Set(computeCornerPositions(cellCount));
  const seenPositions = new Set();
  const cleanCells = [];

  cells.forEach((c, idx) => {
    const position = Number(c && c.position);
    if (!Number.isInteger(position) || position < 1 || position > expectedLength) {
      errors.push(`Cell at index ${idx} has an invalid position.`);
      return;
    }
    if (seenPositions.has(position)) {
      errors.push(`Duplicate cell position ${position}.`);
      return;
    }
    seenPositions.add(position);

    const isCorner = corners.has(position);
    const cellType = c.cell_type;
    if (!CELL_TYPES.includes(cellType)) {
      errors.push(`Cell ${position}: invalid cell type.`);
      return;
    }
    if (CORNER_ONLY_TYPES.has(cellType) && !isCorner) {
      errors.push(`Cell ${position}: only a corner cell can be "bonus" or "go back 4".`);
      return;
    }
    if (cellType === 'picture' && isCorner) {
      errors.push(`Cell ${position}: a corner can only be "question", "bonus", or "go back 4".`);
      return;
    }

    let question = typeof c.question === 'string' ? c.question.trim() : '';
    let imageUrl = typeof c.image_url === 'string' ? c.image_url.trim() : '';
    let color    = typeof c.color === 'string' ? c.color.trim() : '';

    if (cellType === 'question') {
      if (question.length < QUESTION_MIN_LEN || question.length > QUESTION_MAX_LEN) {
        errors.push(`Cell ${position}: question text must be ${QUESTION_MIN_LEN}-${QUESTION_MAX_LEN} characters.`);
      }
      imageUrl = '';
    } else if (cellType === 'picture') {
      if (question.length < QUESTION_MIN_LEN || question.length > QUESTION_MAX_LEN) {
        errors.push(`Cell ${position}: question text must be ${QUESTION_MIN_LEN}-${QUESTION_MAX_LEN} characters.`);
      }
      if (!imageUrl || !IMAGE_URL_RE.test(imageUrl)) {
        errors.push(`Cell ${position}: a valid image URL (http/https) is required for a picture cell.`);
      }
    } else {
      // bonus / paf — no teacher-authored text
      question = '';
      imageUrl = '';
      color = '';
    }

    cleanCells.push({
      position,
      cell_type: cellType,
      is_corner: isCorner,
      question:  question || null,
      image_url: imageUrl || null,
      color:     color || null,
    });
  });

  if (errors.length) return { errors };

  return {
    data: {
      title,
      description: description || null,
      level,
      cell_count: cellCount,
      cells: cleanCells,
    },
  };
}

// ─── Helper: does this teacher own this poly? ──────────────────────────────
async function loadOwnedGame(gameId, teacherId) {
  const { rows } = await pool.query(
    'SELECT * FROM englishpoly_games WHERE id = $1 AND teacher_id = $2',
    [gameId, teacherId]
  );
  return rows.length ? rows[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/englishpoly/games — create a poly
// ═══════════════════════════════════════════════════════════════════════════
router.post('/games', authenticate, requireTeacher, async (req, res) => {
  const { errors, data } = validateGamePayload(req.body);
  if (errors) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gameId = uuidv4();
    const { rows } = await client.query(
      `INSERT INTO englishpoly_games (id, teacher_id, title, description, level, cell_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [gameId, req.userId, data.title, data.description, data.level, data.cell_count]
    );

    for (const cell of data.cells) {
      await client.query(
        `INSERT INTO englishpoly_cells (id, game_id, position, cell_type, is_corner, question, image_url, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv4(), gameId, cell.position, cell.cell_type, cell.is_corner, cell.question, cell.image_url, cell.color]
      );
    }
    // The automatic FINISH cell — always the last position, no teacher content.
    await client.query(
      `INSERT INTO englishpoly_cells (id, game_id, position, cell_type, is_corner)
       VALUES ($1, $2, $3, 'finish', false)`,
      [uuidv4(), gameId, data.cell_count]
    );

    await client.query('COMMIT');

    const { rows: cellRows } = await pool.query(
      'SELECT * FROM englishpoly_cells WHERE game_id = $1 ORDER BY position ASC',
      [gameId]
    );

    return res.status(201).json({ success: true, message: 'Poly created.', game: rows[0], cells: cellRows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create poly error:', err);
    return res.status(500).json({ success: false, message: 'Could not create poly.' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/englishpoly/games — list the teacher's own polys (dashboard)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/games', authenticate, requireTeacher, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*,
              (SELECT COUNT(*)::int FROM englishpoly_cells c WHERE c.game_id = g.id AND c.cell_type = 'question') AS question_cell_count,
              (SELECT COUNT(*)::int FROM englishpoly_cells c WHERE c.game_id = g.id AND c.cell_type = 'picture') AS picture_cell_count,
              (SELECT COUNT(*)::int FROM englishpoly_cells c WHERE c.game_id = g.id AND c.cell_type IN ('bonus','paf')) AS special_cell_count
         FROM englishpoly_games g
        WHERE g.teacher_id = $1
        ORDER BY g.created_at DESC`,
      [req.userId]
    );
    return res.json({ success: true, games: rows });
  } catch (err) {
    console.error('List polys error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch your polys.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/englishpoly/games/:id — one poly + all its cells (review/edit)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/games/:id', authenticate, requireTeacher, async (req, res) => {
  try {
    const game = await loadOwnedGame(req.params.id, req.userId);
    if (!game) return res.status(404).json({ success: false, message: 'Poly not found.' });

    const { rows: cells } = await pool.query(
      'SELECT * FROM englishpoly_cells WHERE game_id = $1 ORDER BY position ASC',
      [game.id]
    );
    return res.json({ success: true, game, cells });
  } catch (err) {
    console.error('Get poly error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch poly.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/englishpoly/games/:id — update a poly's info and/or cells
// Full replace of cells (simplest correct semantics — a board's cell count
// and corner layout can change between edits, so partial cell patches would
// be error-prone). The client always resends the complete cells array.
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/games/:id', authenticate, requireTeacher, async (req, res) => {
  const { errors, data } = validateGamePayload(req.body);
  if (errors) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const client = await pool.connect();
  try {
    const existing = await loadOwnedGame(req.params.id, req.userId);
    if (!existing) {
      client.release();
      return res.status(404).json({ success: false, message: 'Poly not found.' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE englishpoly_games
          SET title = $1, description = $2, level = $3, cell_count = $4, updated_at = NOW()
        WHERE id = $5
        RETURNING *`,
      [data.title, data.description, data.level, data.cell_count, existing.id]
    );

    await client.query('DELETE FROM englishpoly_cells WHERE game_id = $1', [existing.id]);

    for (const cell of data.cells) {
      await client.query(
        `INSERT INTO englishpoly_cells (id, game_id, position, cell_type, is_corner, question, image_url, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv4(), existing.id, cell.position, cell.cell_type, cell.is_corner, cell.question, cell.image_url, cell.color]
      );
    }
    await client.query(
      `INSERT INTO englishpoly_cells (id, game_id, position, cell_type, is_corner)
       VALUES ($1, $2, $3, 'finish', false)`,
      [uuidv4(), existing.id, data.cell_count]
    );

    await client.query('COMMIT');

    const { rows: cellRows } = await pool.query(
      'SELECT * FROM englishpoly_cells WHERE game_id = $1 ORDER BY position ASC',
      [existing.id]
    );

    return res.json({ success: true, message: 'Poly updated.', game: rows[0], cells: cellRows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update poly error:', err);
    return res.status(500).json({ success: false, message: 'Could not update poly.' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/englishpoly/games/:id — delete a poly
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/games/:id', authenticate, requireTeacher, async (req, res) => {
  try {
    const existing = await loadOwnedGame(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ success: false, message: 'Poly not found.' });

    await pool.query('DELETE FROM englishpoly_games WHERE id = $1', [existing.id]);
    return res.json({ success: true, message: 'Poly deleted.' });
  } catch (err) {
    console.error('Delete poly error:', err);
    return res.status(500).json({ success: false, message: 'Could not delete poly.' });
  }
});

module.exports = { router, computeCornerPositions, LEVELS, MIN_CELL_COUNT, MAX_CELL_COUNT };