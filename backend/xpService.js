/**
 * xpService.js
 *
 * Shared logic for awarding XP exactly once per (user, item) pair.
 * Each award*Xp function wraps the insert-into-award-table + xp-increment
 * in a single transaction, so a student either gets the XP award row AND
 * the xp bump, or neither — never a partial state.
 *
 * The UNIQUE constraint on each award table is the actual source of truth:
 * if a row already exists, the INSERT ... ON CONFLICT DO NOTHING affects
 * zero rows, and we simply report awarded: false without touching xp.
 */

'use strict';

const { pool } = require('./Db');

async function runAward(insertQuery, insertParams, userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertRes = await client.query(insertQuery, insertParams);
    const awarded = insertRes.rowCount > 0;

    let xp;
    if (awarded) {
      const { rows } = await client.query(
        `UPDATE users SET xp = xp + $1 WHERE id = $2 RETURNING xp`,
        [amount, userId]
      );
      xp = rows[0].xp;
    } else {
      const { rows } = await client.query(`SELECT xp FROM users WHERE id = $1`, [userId]);
      xp = rows[0].xp;
    }

    await client.query('COMMIT');
    return { awarded, xp };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Vocabulary — 1 XP per newly-learned word ────────────────────────────────
async function awardWordXp(userId, wordId, amount = 1) {
  return runAward(
    `INSERT INTO word_xp_awards (user_id, word_id) VALUES ($1, $2)
     ON CONFLICT (user_id, word_id) DO NOTHING RETURNING id`,
    [userId, wordId],
    userId,
    amount
  );
}

// ─── Sentence Builder — 1 XP per newly-built-correctly sentence ──────────────
async function awardSentenceBuildXp(userId, sentenceId, amount = 1) {
  return runAward(
    `INSERT INTO sentence_build_xp_awards (user_id, sentence_id) VALUES ($1, $2)
     ON CONFLICT (user_id, sentence_id) DO NOTHING RETURNING id`,
    [userId, sentenceId],
    userId,
    amount
  );
}

// ─── Pronunciation — 1 XP per newly-passed sentence ──────────────────────────
async function awardPronunciationXp(userId, sentenceId, amount = 1) {
  return runAward(
    `INSERT INTO pronunciation_xp_awards (user_id, sentence_id) VALUES ($1, $2)
     ON CONFLICT (user_id, sentence_id) DO NOTHING RETURNING id`,
    [userId, sentenceId],
    userId,
    amount
  );
}

module.exports = { awardWordXp, awardSentenceBuildXp, awardPronunciationXp };