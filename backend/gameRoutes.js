/**
 * gameRoutes.js
 *
 * Handles Englishpoly multiplayer game sessions.
 *
 * REST endpoints (mounted at /api/game in server.js):
 *   POST   /api/game/classes/:classId/start    – teacher starts a new game session
 *   GET    /api/game/classes/:classId/session  – get active session for a class
 *   DELETE /api/game/classes/:classId/session  – teacher ends the session
 *
 * Socket.io events (all rooms keyed by classId):
 *   Client → Server:
 *     join_game      { classId, token }              – join room & get state
 *     roll_dice      { classId, token }              – current player rolls
 *     challenge_done { classId, token, points }      – award points after challenge
 *     challenge_skip { classId, token }              – skip (−1 pt)
 *     end_game       { classId, token }              – teacher force-ends
 *
 *   Server → Client:
 *     game_state     { session }                     – full state broadcast
 *     game_started   { classId, sessionId }          – teacher started
 *     game_ended     { leaderboard }                 – game over — final standings
 *     error          { message }
 *
 * IMPORTANT — player membership:
 *   Players are NOT pre-populated from the class roster when the teacher
 *   starts a game. A student only becomes a `player` (enters the turn
 *   rotation) the moment their client actually connects via `join_game`.
 *   This means students who never open the game room are never part of
 *   the session, are never shown in the turn order, and can never be
 *   rolled for (by themselves or by the teacher's "Force Roll").
 *
 * IMPORTANT — finishing:
 *   The board has one FINISH cell at the very end (index BOARD_LENGTH-1).
 *   Landing on or past it marks a player `finished`. A finished player
 *   stays parked on FINISH and is skipped in the turn rotation — they
 *   don't roll again. The game itself doesn't end until EVERY player has
 *   finished (who finishes first doesn't matter). At that point (or if
 *   the teacher force-ends the game early), final standings are computed
 *   purely from score — highest score wins, and players with an equal
 *   score share the same place. That result set is what powers the
 *   post-game "stage" (podium) shown in game_room.html.
 */

'use strict';

const express    = require('express');
const jwt        = require('jsonwebtoken');
const { pool }   = require('./Db');
const { authenticate } = require('./authMiddleware');

const router = express.Router({ mergeParams: true });

// ─── In-memory game state ──────────────────────────────────────────────────────
// Map<classId, GameSession>
const gameSessions = new Map();

/**
 * GameSession shape:
 * {
 *   id:            string (uuid-like),
 *   classId:       string,
 *   teacherId:     number,
 *   players:       Player[],    // ordered; ONLY students who have joined the
 *                                // game room via join_game. Teacher is never
 *                                // a player.
 *   currentIdx:    number,      // index into players[]
 *   round:         number,
 *   status:        'waiting' | 'playing' | 'ended',
 *   diceRolled:    boolean,
 *   lastDice:      number,
 *   startedAt:     Date,
 * }
 *
 * Player shape:
 * {
 *   userId:   number,
 *   name:     string,
 *   pos:      number,   // board square index 0..BOARD_LENGTH-1
 *   score:    number,
 *   color:    string,
 *   emoji:    string,
 *   online:   boolean,
 *   socketId: string | null,
 *   finished: boolean,  // true once they've reached the FINISH cell
 * }
 */

const PLAYER_COLORS = ['#e03232','#2574c0','#2e9e4f','#8b35b0','#e07820','#f5c518'];
const PLAYER_EMOJIS = ['😀','😎','🦊','🐼','🦋','🚀'];
const BOARD_LENGTH  = 33; // squares 0-32; square 32 is the FINISH cell.

// ─── Helper: verify JWT from socket handshake ──────────────────────────────────
function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Helper: get teacher_id of a class ────────────────────────────────────────
async function getClassTeacher(classId) {
  const { rows } = await pool.query(
    'SELECT teacher_id FROM classes WHERE id = $1',
    [classId]
  );
  return rows.length ? rows[0].teacher_id : null;
}

// ─── Helper: look up an enrolled student's name (used when they join a room) ──
// Returns the student's name if they're enrolled in the class, otherwise null.
async function getEnrolledStudentName(classId, userId) {
  const { rows } = await pool.query(
    `SELECT u.name
       FROM class_enrollments ce
       JOIN users u ON u.id = ce.student_id
      WHERE ce.class_id = $1 AND ce.student_id = $2`,
    [classId, userId]
  );
  return rows.length ? rows[0].name : null;
}

// ─── Helper: broadcast game state to the room ─────────────────────────────────
function broadcastState(io, classId) {
  const session = gameSessions.get(classId);
  if (!session) return;
  io.to(`class:${classId}`).emit('game_state', { session });
}

// ─── Helper: generate a simple session ID ─────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Helper: has every player reached the FINISH cell? ────────────────────────
function allPlayersFinished(session) {
  return session.players.length > 0 && session.players.every(p => p.finished);
}

// ─── Helper: rank players by score, descending — ties share the same place ────
// This is the only ranking rule for Englishpoly: reaching FINISH first has
// no bearing on standings, only the final score does.
function computeStandings(session) {
  const sorted = [...session.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name).localeCompare(String(b.name));
  });

  const leaderboard = [];
  let rank = 0;
  let prevScore = null;
  for (const p of sorted) {
    if (prevScore === null || p.score !== prevScore) {
      rank += 1;
      prevScore = p.score;
    }
    leaderboard.push({ studentId: p.userId, name: p.name, score: p.score, rank });
  }
  return leaderboard;
}

// ─── Helper: end the session (naturally or teacher-forced) and broadcast the
//     final standings. Used by every code path that can end a game so the
//     stage/podium always has real data to show. ────────────────────────────
function finalizeSession(io, classId, session) {
  session.status     = 'ended';
  session.diceRolled = false;
  const leaderboard = computeStandings(session);
  broadcastState(io, classId);
  io.to(`class:${classId}`).emit('game_ended', { leaderboard });
  gameSessions.delete(classId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

function requireTeacher(req, res, next) {
  if (!req.userId || String(req.userRoleId) !== '2') {
    return res.status(403).json({ success: false, message: 'Only teachers can do this.' });
  }
  next();
}

// POST /api/game/classes/:classId/start
router.post('/classes/:classId/start', authenticate, requireTeacher, async (req, res) => {
  const { classId } = req.params;

  try {
    const teacherId = await getClassTeacher(classId);
    if (!teacherId) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }
    if (Number(teacherId) !== Number(req.userId)) {
      return res.status(403).json({ success: false, message: 'You do not own this class.' });
    }

    // End any existing session
    gameSessions.delete(classId);

    // Players start empty. A student only enters the game (and the turn
    // rotation) the moment they connect via join_game — see the socket
    // handler below. This keeps unjoined students out of the session
    // entirely, so a teacher's "Force Roll" can never roll for someone
    // who never opened the game room.
    const session = {
      id:          makeId(),
      classId,
      teacherId:   Number(teacherId),
      players:     [],
      currentIdx:  0,
      round:       1,
      status:      'waiting',
      diceRolled:  false,
      lastDice:    1,
      startedAt:   new Date().toISOString(),
    };

    gameSessions.set(classId, session);

    // Notify everyone already in the socket room
    const io = req.app.get('io');
    if (io) {
      io.to(`class:${classId}`).emit('game_started', {
        classId,
        sessionId: session.id,
      });
      broadcastState(io, classId);
    }

    return res.status(201).json({ success: true, session });
  } catch (err) {
    console.error('Start game error:', err);
    return res.status(500).json({ success: false, message: 'Could not start game.' });
  }
});

// GET /api/game/classes/:classId/session
router.get('/classes/:classId/session', authenticate, async (req, res) => {
  const { classId } = req.params;
  const session = gameSessions.get(classId);
  if (!session || session.status === 'ended') {
    return res.json({ success: true, session: null });
  }
  return res.json({ success: true, session });
});

// DELETE /api/game/classes/:classId/session
router.delete('/classes/:classId/session', authenticate, requireTeacher, async (req, res) => {
  const { classId } = req.params;
  const session = gameSessions.get(classId);
  if (!session) {
    return res.status(404).json({ success: false, message: 'No active session.' });
  }
  if (Number(session.teacherId) !== Number(req.userId)) {
    return res.status(403).json({ success: false, message: 'You do not own this session.' });
  }

  const io = req.app.get('io');
  if (io) {
    // Even a manual/early stop should show students a real stage with
    // whatever standings exist at that moment, rather than a blank screen.
    finalizeSession(io, classId, session);
  } else {
    gameSessions.delete(classId);
  }

  return res.json({ success: true, message: 'Game ended.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO HANDLER — call this from server.js after creating the io instance
// ═══════════════════════════════════════════════════════════════════════════════

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {

    // ── join_game ────────────────────────────────────────────────────────────
    socket.on('join_game', async ({ classId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const userId = Number(payload.sub);
      const roleId = Number(payload.roleId);

      // Verify the user belongs to this class (student enrolled or teacher owns it)
      let studentName = null;
      try {
        if (roleId === 2) {
          // teacher
          const teacherId = await getClassTeacher(classId);
          if (Number(teacherId) !== userId) {
            return socket.emit('error', { message: 'Not your class.' });
          }
        } else {
          // student — must be enrolled
          studentName = await getEnrolledStudentName(classId, userId);
          if (studentName === null) {
            return socket.emit('error', { message: 'Not enrolled in this class.' });
          }
        }
      } catch (err) {
        console.error('join_game auth error:', err);
        return socket.emit('error', { message: 'Server error.' });
      }

      socket.join(`class:${classId}`);
      socket.data = { classId, userId, roleId };

      const session = gameSessions.get(classId);
      if (!session) return;

      if (roleId !== 2) {
        // Student — add them as a player the first time they actually join
        // the game room. Students who never open the room never appear
        // here and are never part of the turn rotation.
        let player = session.players.find(p => p.userId === userId);

        if (!player) {
          const idx = session.players.length;
          player = {
            userId,
            name:     studentName,
            pos:      0,
            score:    0,
            color:    PLAYER_COLORS[idx % PLAYER_COLORS.length],
            emoji:    PLAYER_EMOJIS[idx % PLAYER_EMOJIS.length],
            online:   true,
            socketId: socket.id,
            finished: false,
          };
          session.players.push(player);
        } else {
          // Reconnecting — just mark them back online.
          player.online   = true;
          player.socketId = socket.id;
        }

        if (session.status === 'waiting') {
          session.status = 'playing';
        }
      }
      // Teachers joining don't affect players — they just get a state resync.

      broadcastState(io, classId);
    });

    // ── roll_dice ────────────────────────────────────────────────────────────
    socket.on('roll_dice', ({ classId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const userId = Number(payload.sub);
      const session = gameSessions.get(classId);
      if (!session || session.status !== 'playing') {
        return socket.emit('error', { message: 'No active game.' });
      }

      if (!session.players.length) {
        return socket.emit('error', { message: 'No students have joined the game yet.' });
      }

      const currentPlayer = session.players[session.currentIdx];
      if (!currentPlayer || currentPlayer.finished) {
        return socket.emit('error', { message: 'No active player to roll for right now.' });
      }

      // Only the current player (or teacher) can roll
      const isTeacher = Number(payload.roleId) === 2 && Number(session.teacherId) === userId;
      const isCurrentPlayer = currentPlayer.userId === userId;

      if (!isTeacher && !isCurrentPlayer) {
        return socket.emit('error', { message: 'Not your turn.' });
      }

      if (session.diceRolled) {
        return socket.emit('error', { message: 'Already rolled this turn.' });
      }

      const dice = Math.ceil(Math.random() * 6);
      session.lastDice   = dice;
      session.diceRolled = true;

      const newPos = currentPlayer.pos + dice;

      if (newPos >= BOARD_LENGTH - 1) {
        // Reached (or overshot) the FINISH cell. The player stops exactly
        // on FINISH and is marked finished — no challenge triggers there,
        // they simply wait for everyone else. Their turn resolves
        // immediately (no grading step needed), so we advance the turn
        // right here instead of waiting for a challenge_done from the
        // client.
        currentPlayer.pos      = BOARD_LENGTH - 1;
        currentPlayer.finished = true;

        if (allPlayersFinished(session)) {
          finalizeSession(io, classId, session);
          return;
        }

        advanceTurn(session);
        broadcastState(io, classId);
        return;
      }

      currentPlayer.pos = newPos;
      broadcastState(io, classId);
    });

    // ── challenge_done ───────────────────────────────────────────────────────
    // Only the teacher is expected to call this now (the frontend no longer
    // exposes grading controls to students), but we keep the "current
    // player can also call it" allowance server-side as a harmless no-op
    // safety net rather than a trust boundary — the UI is what enforces
    // "students can't grade themselves".
    socket.on('challenge_done', ({ classId, token, points } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const userId  = Number(payload.sub);
      const session = gameSessions.get(classId);
      if (!session) return;

      const currentPlayer = session.players[session.currentIdx];
      const isTeacher     = Number(payload.roleId) === 2 && Number(session.teacherId) === userId;
      const isCurrentPlayer = currentPlayer && currentPlayer.userId === userId;

      if (!isTeacher && !isCurrentPlayer) return;

      if (currentPlayer) {
        currentPlayer.score = Math.max(0, (currentPlayer.score || 0) + (Number(points) || 0));
      }

      // Advance turn
      advanceTurn(session);
      broadcastState(io, classId);
    });

    // ── challenge_skip ───────────────────────────────────────────────────────
    socket.on('challenge_skip', ({ classId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const userId  = Number(payload.sub);
      const session = gameSessions.get(classId);
      if (!session) return;

      const currentPlayer = session.players[session.currentIdx];
      const isTeacher     = Number(payload.roleId) === 2 && Number(session.teacherId) === userId;
      const isCurrentPlayer = currentPlayer && currentPlayer.userId === userId;

      if (!isTeacher && !isCurrentPlayer) return;

      if (currentPlayer) {
        currentPlayer.score = Math.max(0, (currentPlayer.score || 0) - 1);
      }

      advanceTurn(session);
      broadcastState(io, classId);
    });

    // ── end_game ─────────────────────────────────────────────────────────────
    socket.on('end_game', ({ classId, token } = {}) => {
      const payload = verifyToken(token);
      if (!payload) return socket.emit('error', { message: 'Invalid token.' });

      const userId  = Number(payload.sub);
      const roleId  = Number(payload.roleId);
      const session = gameSessions.get(classId);
      if (!session) return;

      if (roleId !== 2 || Number(session.teacherId) !== userId) {
        return socket.emit('error', { message: 'Only the teacher can end the game.' });
      }

      finalizeSession(io, classId, session);
    });

    // ── disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { classId, userId } = socket.data || {};
      if (!classId || !userId) return;

      const session = gameSessions.get(classId);
      if (!session) return;

      const player = session.players.find(p => p.userId === userId);
      if (player) {
        player.online   = false;
        player.socketId = null;
        broadcastState(io, classId);
      }
    });
  });
}

// ─── Advance to next player's turn, skipping anyone already finished ─────────
function advanceTurn(session) {
  session.diceRolled = false;
  const n = session.players.length;
  if (!n) return;

  let next = session.currentIdx;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (!session.players[next].finished) {
      if (next <= session.currentIdx) session.round++;
      session.currentIdx = next;
      return;
    }
  }
  // Everyone left is finished — nothing to advance to. Callers are expected
  // to have already checked allPlayersFinished() before reaching this
  // point, so this is just a safe fallback that leaves currentIdx as-is.
}

module.exports = { router, registerSocketHandlers };