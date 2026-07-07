const OpenAI     = require('openai');
const { toFile } = require('openai');
const { pool }   = require('./Db');
const { awardPronunciationXp } = require('./xpService');


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Word-level similarity ────────────────────────────────────────────────────
// Strips punctuation, lower-cases, then computes multiset word intersection
// divided by the max of the two lengths.  Handles repeated words correctly.
function normalizeWords(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordSimilarity(expected, actual) {
  const expWords = normalizeWords(expected);
  const actWords = normalizeWords(actual);

  if (!expWords.length) return 0;

  // Build a frequency map for the expected words
  const freq = new Map();
  expWords.forEach(w => freq.set(w, (freq.get(w) || 0) + 1));

  // Count how many actual words appear in the expected set
  let matches = 0;
  actWords.forEach(w => {
    if (freq.has(w) && freq.get(w) > 0) {
      matches++;
      freq.set(w, freq.get(w) - 1);
    }
  });

  return matches / Math.max(expWords.length, actWords.length);
}

// ─── GET /api/pronunciation/sentences/:partId ─────────────────────────────────
async function getSentences(req, res) {
  const partId = parseInt(req.params.partId, 10);
  if (isNaN(partId)) {
    return res.status(400).json({ success: false, message: 'Invalid part ID.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, correct_sentence, kazakh_sentence, audio_url
       FROM sentences
       WHERE part_id = $1
       ORDER BY id ASC`,
      [partId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'No sentences found for this part.',
      });
    }

    const { rows: partRows } = await pool.query(
      'SELECT part_number FROM parts WHERE id = $1',
      [partId]
    );
    const part_number = partRows[0]?.part_number ?? partId;

    return res.json({ success: true, part_number, sentences: rows });
  } catch (err) {
    console.error('getSentences error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// ─── POST /api/pronunciation/check ────────────────────────────────────────────
async function checkPronunciation(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No audio file uploaded.' });
  }

  const sentenceId = parseInt(req.body.sentence_id, 10);
  if (isNaN(sentenceId)) {
    return res.status(400).json({ success: false, message: 'sentence_id is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT correct_sentence FROM sentences WHERE id = $1',
      [sentenceId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Sentence not found.' });
    }

    const expected = rows[0].correct_sentence.trim();

    // Transcribe with gpt-4o-mini-transcribe only — no LLM, no TTS
    const mime = req.file.mimetype || 'audio/webm';
    const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
    const file = await toFile(req.file.buffer, `rec.${ext}`, { type: mime });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
      language: "en",
    });

    const actual = (transcription.text || '').trim();

    if (!actual) {
      return res.json({
        success: true,
        expected,
        actual: '',
        score: 0,
        passed: false,
        empty: true,
      });
    }

      const rawScore = wordSimilarity(expected, actual);
      const score    = Math.round(rawScore * 100);
      const passed   = rawScore >= 0.8;

      let xpAwarded = false;
      let xp;
      if (passed && String(req.userRoleId) === '1') {
        const result = await awardPronunciationXp(req.userId, sentenceId);
        xpAwarded = result.awarded;
        xp = result.xp;
      }

      return res.json({ success: true, expected, actual, score, passed, empty: false, xpAwarded, xp });
  } catch (err) {
    console.error('checkPronunciation error:', err);
    return res.status(500).json({
      success: false,
      message: 'Transcription failed. Please try again.',
    });
  }
}

module.exports = { getSentences, checkPronunciation };