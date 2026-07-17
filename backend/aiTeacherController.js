const OpenAI = require('openai');
const { pool } = require('./Db');

// Lemonfox's chat endpoint is OpenAI-compatible, so we just repoint the client.
const lemonfox = new OpenAI({
  apiKey:  process.env.LEMONFOX_API_KEY,
  baseURL: 'https://api.lemonfox.ai/v1',
});

// STT + TTS use plain fetch — Lemonfox's request shape differs slightly from
// OpenAI's here (no `model` field for transcription; `voice`/`language` for TTS),
// so routing them through the OpenAI SDK's stricter types isn't worth it.
const LEMONFOX_BASE = 'https://api.lemonfox.ai/v1';
const LEMONFOX_KEY  = process.env.LEMONFOX_API_KEY;

// Lemonfox voice for Emma. 'sarah' = warm American voice (closest to old 'nova').
// Swap to 'emma' + language 'en-gb' if you want the persona/voice name to match.
const TTS_VOICE = 'isabella';

// Slower speech for beginners — gives ears time to catch up
// (Lemonfox speed range is 0.5–4.0, same window we were already using)
const TTS_SPEED = {
  'Beginner A1-A2':     0.60,
  'Intermediate B1-B2': 0.9,
  'Advanced C1-C2':     1.0,
};

// ─── Turn limits (per product decision, July 2026) ───────────────────────────
// Emma is no longer a free-roaming chat — every conversation is scoped to ONE
// selected topic and ends automatically after a level-appropriate number of
// USER turns (the assistant's opening greeting doesn't count). This keeps
// conversations short and finishable, and gives the "X / Y turns" tracker on
// the frontend a real limit to count down against.
const TURN_LIMITS = {
  'Beginner A1-A2':     10,
  'Intermediate B1-B2': 12,
  'Advanced C1-C2':     15,
};
function turnLimitFor(level) {
  return TURN_LIMITS[level] ?? TURN_LIMITS['Intermediate B1-B2'];
}

// ─── System prompt factory ────────────────────────────────────────────────────
//
// Design goals (per product decision, July 2026):
//   1. Emma is a friendly conversation partner (LangAI-style), not a drill
//      sergeant — she teaches AS she chats instead of stopping to force
//      repetition or "make a sentence with X."
//   2. Every conversation is locked to ONE topic, chosen before the chat
//      starts. Emma never offers a menu of topics and never wanders off
//      the one she was given — she steers back to it if the student drifts.
//   3. Replies stay short. English only, at every level.
//   4. Vocabulary/sentence complexity scales with level.
//   5. Topics stay light and appropriate — no violent, adult, dangerous,
//      or otherwise unsuitable subject matter, even if the student raises it.
//   6. The conversation has a hard end: on the final allowed turn, Emma
//      wraps up warmly instead of asking another follow-up question.

const TOPIC_SAFETY = `
TOPIC BOUNDARIES (always apply):
- Never engage with violent, sexual, adult, drug-related, self-harm, or otherwise dangerous or inappropriate content, even if the student brings it up. If they do, respond briefly and kindly, then steer back to the conversation topic below.
- Keep the mood light, positive, and encouraging at all times.
`;

function topicFocusBlock(topicTitle) {
  return `
TOPIC FOCUS — this entire conversation is about ONE topic: "${topicTitle}".
- Every question you ask and every reply you give should stay on this topic, or a very close, natural extension of it.
- If the student wanders far off-topic, gently and warmly bring the conversation back to "${topicTitle}" within your reply — don't lecture them about it, just steer naturally.
- Never offer a menu of other topics or ask "what would you like to talk about" — the topic is already chosen.
`;
}

function openingRules(topicTitle) {
  return `
OPENING TURN (this is the very first message of the session):
- Do NOT give a self-introduction or a long lead-in.
- Greet the student by name in a few words, then ask one warm, casual opening question about "${topicTitle}" to kick off the chat.
- Keep the whole opening within your normal reply length limit for this level — no exceptions for the first message.
`;
}

function closingRules(topicTitle) {
  return `
CLOSING TURN (this is the LAST message you will send in this conversation — there will be no more replies after this one):
- Do NOT ask a new follow-up question.
- Give a short, warm wrap-up: acknowledge something specific the student said about "${topicTitle}", and end on an encouraging note.
- Keep it within your normal reply length limit for this level.
`;
}

function buildSystemPrompt(level, name, topicTitle, { isFirstTurn = false, isFinalTurn = false } = {}) {
  const first = (name || 'friend').split(' ')[0];
  const extra = isFirstTurn ? openingRules(topicTitle) : isFinalTurn ? closingRules(topicTitle) : '';

  const CONVERSATION_STYLE = `
CONVERSATION STYLE — you are a friendly conversation partner, not a grammar teacher:
- Talk the way a friendly person would — a natural back-and-forth, like chatting with a friend.
- CRITICAL RULE: NEVER correct the student's grammar, spelling, or word choice. NEVER say things like "we'd usually say" or offer better ways to phrase things. Ignore all mistakes and just keep the conversation going naturally.
- Ask at most ONE natural follow-up question per turn to keep the chat flowing (skip this on the closing turn — see below).
${topicFocusBlock(topicTitle)}${TOPIC_SAFETY}`;

  if (level === 'Beginner A1-A2') {
    return `You are Emma, a warm, patient AI English conversation partner at TilMenger.
Your student is ${first}, a beginner (A1-A2) English learner.
${CONVERSATION_STYLE}
BEGINNER STYLE:
- Use only the simplest, most common English words — talk like you're chatting with a young child.
- Sentences must be short: max 6-8 words each.
- Be warm and encouraging: "Nice!" "That's fun!" "Me too!"
- Reply length: 2-3 short sentences total, max.
${extra}`;
  }

  if (level === 'Advanced C1-C2') {
    return `You are Emma, a sharp, engaging AI English conversation partner at TilMenger.
Your student is ${first}, an advanced (C1-C2) English learner.
${CONVERSATION_STYLE}
ADVANCED STYLE:
- Use rich vocabulary, idioms, collocations, and varied sentence structures, the way an articulate friend would.
- Reply length: 3-5 sentences total, max.
${extra}`;
  }

  // Default: Intermediate B1-B2
  return `You are Emma, a friendly AI English conversation partner at TilMenger.
Your student is ${first}, an intermediate (B1-B2) English learner.
${CONVERSATION_STYLE}
INTERMEDIATE STYLE:
- Use natural, clear conversational English.
- Reply length: 3-4 sentences total, max.
${extra}`;
}

// ─── Post-conversation analysis ──────────────────────────────────────────────
async function analyzeConversation(level, topicTitle, userMessages) {
  if (!userMessages.length) return null;

  const numbered = userMessages
    .map((m, i) => `${i + 1}: "${m.replace(/"/g, "'")}"`)
    .join('\n');

  const system = `You are a lenient and encouraging English evaluator for a conversational language-learning app.
You will be given a numbered list of a student's messages and their CEFR level.

For EACH message, produce TWO segment arrays:

1. "originalSegments" — the student's message, split into segments that reconstruct it EXACTLY when concatenated (same spacing, punctuation, emojis, everything). Mark ONLY the specific words/phrases that are genuine grammar or spelling mistakes with "wrong": true. Everything else is a plain segment with no "wrong" key.
   - {"text":"..."} — unchanged, correct text
   - {"text":"...", "wrong": true} — a mistake, written exactly as the student wrote it (do NOT correct it here)

2. "correctedSegments" — a fully rewritten, fluent, natural version of the same sentence, preserving the student's intended meaning and emojis wherever possible. Mark ONLY the specific word(s) that changed from the original with "highlight": true. Everything else is a plain segment with no "highlight" key.
   - {"text":"..."} — unchanged text
   - {"text":"...", "highlight": true} — a corrected word/phrase

CRITICAL RULES:
1. Do NOT flag informal, natural, conversational English as wrong (e.g., "me and my parents", "gonna").
2. Do NOT remove or alter emojis in originalSegments — reproduce them exactly. Preserve them in correctedSegments whenever possible.
3. originalSegments text, concatenated in order, MUST equal the original message EXACTLY, character for character.
4. Only flag genuine grammar errors, spelling mistakes, or completely incomprehensible phrasing — nothing else.
5. If a message has no errors: originalSegments is a single {"text": "<full message>"} segment, and correctedSegments is also a single {"text": "<same message>"} segment (no highlights).
6. Keep highlighted spans in correctedSegments as short as possible — highlight only the word(s) that actually changed, not the whole surrounding clause.

Then give ONE overall score from 0 to 100 for grammatical accuracy and fluency, calibrated to the student's level.

Respond with STRICT JSON ONLY. No markdown, no commentary.
Format:
{"scorePercent": <integer>, "corrections": [ {"originalSegments":[...], "correctedSegments":[...]}, ... ]}

EXAMPLE INPUT:
1: "Them memories is make me feel happy every times 😊"

EXAMPLE OUTPUT:
{
  "scorePercent": 78,
  "corrections": [
    {
      "originalSegments": [
        {"text":"Them", "wrong":true},
        {"text":" memories "},
        {"text":"is make", "wrong":true},
        {"text":" me feel happy every "},
        {"text":"times", "wrong":true},
        {"text":" 😊"}
      ],
      "correctedSegments": [
        {"text":"Those", "highlight":true},
        {"text":" memories "},
        {"text":"make", "highlight":true},
        {"text":" me feel happy every "},
        {"text":"time", "highlight":true},
        {"text":" 😊"}
      ]
    }
  ]
}`;

  const userPrompt = `Student level: ${level}\nTopic: ${topicTitle}\n\nMessages:\n${numbered}`;

  try {
    const completion = await lemonfox.chat.completions.create({
      model:       'llama-8b-chat',
      messages:    [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
      max_tokens:  2600,
      temperature: 0.2,
    });

    let raw = completion.choices[0].message.content.trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    const parsed = JSON.parse(raw);
    if (typeof parsed.scorePercent !== 'number' || !Array.isArray(parsed.corrections)) {
      throw new Error('Malformed analysis response');
    }

    const scorePercent = Math.max(0, Math.min(100, Math.round(parsed.scorePercent)));

    // Defensive pass, per message: originalSegments must reconstruct the
    // student's text EXACTLY, or we fall back to a plain, unhighlighted
    // original. The yellow card can never show anything other than what
    // the student actually wrote — this is the backstop for that, since a
    // bad model reconstruction would otherwise silently rewrite it.
    const corrections = parsed.corrections.map((entry, i) => {
      const sourceText = userMessages[i] ?? '';

      let originalSegments = Array.isArray(entry?.originalSegments) ? entry.originalSegments : [];
      const rebuilt = originalSegments.map((s) => s?.text ?? '').join('');

      originalSegments = rebuilt === sourceText
        ? originalSegments.map((s) => ({ text: s.text ?? '', ...(s.wrong ? { wrong: true } : {}) }))
        : [{ text: sourceText }];

      let correctedSegments = Array.isArray(entry?.correctedSegments) ? entry.correctedSegments : [];
      correctedSegments = correctedSegments.length
        ? correctedSegments.map((s) => ({ text: s.text ?? '', ...(s.highlight ? { highlight: true } : {}) }))
        : [{ text: sourceText }];

      return { originalSegments, correctedSegments };
    });

    return { scorePercent, corrections };
  } catch (err) {
    console.error('analyzeConversation error:', err);
    return null;
  }
}

// ─── Topic conversation row helper ───────────────────────────────────────────
// One row per (user, topic). Created lazily on first visit to a topic.
// Requires the `topic_conversations` table — see migration note at bottom
// of this file.
async function getOrCreateTopicRow(userId, slug, title) {
  const { rows } = await pool.query(
    'SELECT * FROM topic_conversations WHERE user_id = $1 AND topic_slug = $2',
    [userId, slug]
  );
  if (rows.length) return rows[0];

  const { rows: created } = await pool.query(
    `INSERT INTO topic_conversations (user_id, topic_slug, topic_title, history, turn_count, completed)
     VALUES ($1, $2, $3, '[]'::jsonb, 0, false)
     RETURNING *`,
    [userId, slug, title || slug]
  );
  return created[0];
}

// ─── GET /api/ai-teacher/session?topic=<slug>&title=<name> ──────────────────
// Fast metadata lookup — level, turn limit/progress, and any existing
// transcript for this topic. No LLM call here; the opening line (if the
// topic is brand new) is fetched separately via /greet so the UI can render
// immediately, same pattern as before.
async function getSession(req, res) {
  const { topic, title } = req.query;
  if (!topic) {
    return res.status(400).json({ success: false, message: 'topic is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT name, level FROM users WHERE id = $1',
      [req.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const { name, level } = rows[0];
    const row = await getOrCreateTopicRow(req.userId, topic, title);

    return res.json({
      success:    true,
      name,
      level,
      topicTitle: row.topic_title,
      turnLimit:  turnLimitFor(level),
      turnsUsed:  row.turn_count,
      completed:  row.completed,
      history:    row.history || [],
    });
  } catch (err) {
    console.error('getSession error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// ─── POST /api/ai-teacher/greet ───────────────────────────────────────────────
// Generates Emma's topic-opening line for a brand-new conversation. Idempotent:
// if the conversation already has history, just hands back the first message
// instead of generating a new one.
async function greetTopic(req, res) {
  const { topic, title } = req.body;
  if (!topic) {
    return res.status(400).json({ success: false, message: 'topic is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT name, level FROM users WHERE id = $1',
      [req.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const { name, level } = rows[0];
    const row = await getOrCreateTopicRow(req.userId, topic, title);

    if (row.history && row.history.length) {
      return res.json({ success: true, reply: row.history[0].content });
    }

    const first  = (name || 'friend').split(' ')[0];
    const system = buildSystemPrompt(level, name, row.topic_title, { isFirstTurn: true });

    const completion = await lemonfox.chat.completions.create({
      model:    'llama-8b-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `My name is ${first}. Greet me and start our chat about ${row.topic_title}.` },
      ],
      max_tokens:  220,
      temperature: 0.8,
    });

    const reply   = completion.choices[0].message.content.trim();
    const history = [{ role: 'assistant', content: reply }];

    await pool.query(
      `UPDATE topic_conversations SET history = $1::jsonb, updated_at = NOW()
       WHERE user_id = $2 AND topic_slug = $3`,
      [JSON.stringify(history), req.userId, topic]
    );

    return res.json({ success: true, reply });
  } catch (err) {
    console.error('greetTopic error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start conversation.' });
  }
}

// ─── Script guard ─────────────────────────────────────────────────────────
// Even with language forced to English, a bad enough accent can still make
// Whisper fall back to another script. If that happens, treat it as "didn't
// catch that" rather than feeding Cyrillic/CJK/etc. into the chat model.
const NON_LATIN_RE = /[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
function isNonLatinScript(text) {
  return NON_LATIN_RE.test(text);
}

// ─── POST /api/ai-teacher/transcribe ─────────────────────────────────────────
async function transcribeAudio(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No audio file uploaded.' });
  }

  try {
    const mime = req.file.mimetype || 'audio/webm';
    const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: mime }), `rec.${ext}`);
    form.append('language', 'english');   // ← force English decoding, don't auto-detect
    form.append('response_format', 'json');

    const lfRes = await fetch(`${LEMONFOX_BASE}/audio/transcriptions`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${LEMONFOX_KEY}` },
      body:    form,
    });

    if (!lfRes.ok) {
      console.error('Lemonfox STT error:', lfRes.status, await lfRes.text());
      throw new Error('Transcription request failed.');
    }

    const result = await lfRes.json();
    let text = (result.text || '').trim();

    const nonEnglish = text && isNonLatinScript(text);
    if (nonEnglish) text = '';

    return res.json({ success: true, text, empty: !text, nonEnglish });
  } catch (err) {
    console.error('transcribeAudio error:', err);
    return res.status(500).json({ success: false, message: 'Transcription failed. Please try again.' });
  }
}

// ─── POST /api/ai-teacher/chat ────────────────────────────────────────────────
// Body: { topic, title, text }. The backend owns the conversation history and
// the turn count now — the frontend only ever sends the newest user message.
async function chatWithTopic(req, res) {
  const { topic, title, text } = req.body;
  if (!topic || !text || !text.trim()) {
    return res.status(400).json({ success: false, message: 'topic and text are required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT name, level FROM users WHERE id = $1',
      [req.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const { name, level } = rows[0];
    const row = await getOrCreateTopicRow(req.userId, topic, title);

    if (row.completed) {
      return res.status(403).json({ success: false, message: 'This topic conversation has already finished.' });
    }

    const turnLimit    = turnLimitFor(level);
    const newTurnCount = row.turn_count + 1;
    const isFinalTurn  = newTurnCount >= turnLimit;

    const system        = buildSystemPrompt(level, name, row.topic_title, { isFinalTurn });
    const priorHistory  = row.history || [];
    const messages      = [...priorHistory, { role: 'user', content: text.trim() }];

    const completion = await lemonfox.chat.completions.create({
      model:       'llama-8b-chat',
      messages:    [{ role: 'system', content: system }, ...messages],
      max_tokens:  220,
      temperature: 0.8,
    });

    const reply      = completion.choices[0].message.content.trim();
    // Keep a generous cap so a long-running topic can never grow unbounded —
    // turn limits already keep this well under the cap in normal use.
    const newHistory = [...messages, { role: 'assistant', content: reply }].slice(-40);

    // On the turn that finishes the topic, grade every message the student
    // sent and store the result. This is the only place scorePercent/analysis
    // ever get written — a later /restart deliberately leaves them alone (see
    // restartTopic) so the OLD score stays visible while a redo is underway,
    // right up until the redo itself finishes and overwrites it here again.
    let scorePercent = null;
    let analysisJson = null;
    if (isFinalTurn) {
      const userMessages = newHistory.filter((m) => m.role === 'user').map((m) => m.content);
      const result = await analyzeConversation(level, row.topic_title, userMessages);
      if (result) {
        scorePercent = result.scorePercent;
        analysisJson = JSON.stringify({ corrections: result.corrections });
      }
    }

    // ever_completed is a one-way flag — it's what the chain-unlock logic
    // reads, so restarting a finished topic later (which resets `completed`
    // back to false) never re-locks whatever came after it.
    await pool.query(
      `UPDATE topic_conversations
          SET history = $1::jsonb, turn_count = $2, completed = $3,
              ever_completed = ever_completed OR $3,
              score_percent = COALESCE($6, score_percent),
              analysis = COALESCE($7::jsonb, analysis),
              updated_at = NOW()
        WHERE user_id = $4 AND topic_slug = $5`,
      [JSON.stringify(newHistory), newTurnCount, isFinalTurn, req.userId, topic, scorePercent, analysisJson]
    );

    return res.json({
      success:   true,
      reply,
      turnsUsed: newTurnCount,
      turnLimit,
      completed: isFinalTurn,
    });
  } catch (err) {
    console.error('chatWithTopic error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate response.' });
  }
}

// ─── POST /api/ai-teacher/speak ───────────────────────────────────────────────
async function speakText(req, res) {
  const { text } = req.body;
  if (!text?.trim()) {
    return res.status(400).json({ success: false, message: 'text is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT level FROM users WHERE id = $1',
      [req.userId]
    );
    const level = rows[0]?.level || 'Intermediate B1-B2';
    const speed = TTS_SPEED[level] ?? 0.9;

    const lfRes = await fetch(`${LEMONFOX_BASE}/audio/speech`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${LEMONFOX_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input:           text.slice(0, 4096),
        voice:           TTS_VOICE,
        language:        'en-us',
        response_format: 'mp3',
        speed,
      }),
    });

    if (!lfRes.ok) {
      console.error('Lemonfox TTS error:', lfRes.status, await lfRes.text());
      throw new Error('TTS request failed.');
    }

    const buffer = Buffer.from(await lfRes.arrayBuffer());
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buffer.length });
    return res.send(buffer);
  } catch (err) {
    console.error('speakText error:', err);
    return res.status(500).json({ success: false, message: 'Text-to-speech failed.' });
  }
}

// ─── GET /api/ai-teacher/topics/progress ─────────────────────────────────────
// Drives the topic-select page: which topics are done (unlocks the next one),
// and which are merely started-but-abandoned (has a transcript, hasn't hit
// the turn limit) — that second set is what shows the Continue/Restart
// buttons instead of a plain circle.
async function getTopicsProgress(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT topic_slug, completed, ever_completed, score_percent, jsonb_array_length(history) AS history_len
         FROM topic_conversations
        WHERE user_id = $1`,
      [req.userId]
    );

    // `completed` here is the PERMANENT unlock record (ever_completed) — a
    // topic that was finished once and later restarted still counts, so
    // redoing it never re-locks anything after it in the chain.
    const completed  = rows.filter((r) => r.ever_completed).map((r) => r.topic_slug);
    // `inProgress` is the CURRENT live session — true both for a topic
    // that's never been finished yet and for one that's mid-redo after a
    // restart. The frontend tells these apart using `completed` (chain
    // status), not this flag.
    const inProgress = rows
      .filter((r) => !r.completed && r.history_len > 0)
      .map((r) => r.topic_slug);
    // Score from the most recently FINISHED attempt — stays visible through
    // a redo-in-progress (restart never clears it) so the student has
    // something to compare their new attempt against.
    const scores = {};
    rows.forEach((r) => {
      if (r.score_percent !== null && r.score_percent !== undefined) {
        scores[r.topic_slug] = r.score_percent;
      }
    });

    return res.json({ success: true, completed, inProgress, scores });
  } catch (err) {
    console.error('getTopicsProgress error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch topic progress.' });
  }
}

// ─── POST /api/ai-teacher/restart ────────────────────────────────────────────
// Body: { topic }. Wipes the stored conversation for this topic IN PLACE —
// same row (the user_id + topic_slug unique constraint means there's only
// ever one row per topic per user), history reset to empty, turn_count back
// to 0, completed back to false. The old transcript is gone, not archived;
// the next /session call for this topic will look exactly like a first visit.
async function restartTopic(req, res) {
  const { topic } = req.body;
  if (!topic) {
    return res.status(400).json({ success: false, message: 'topic is required.' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE topic_conversations
          SET history = '[]'::jsonb, turn_count = 0, completed = false, updated_at = NOW()
        WHERE user_id = $1 AND topic_slug = $2
        RETURNING id`,
      [req.userId, topic]
    );

    // No row yet means the topic was never actually started — nothing to
    // wipe, and the next /session call will create a fresh row anyway.
    return res.json({ success: true, restarted: rows.length > 0 });
  } catch (err) {
    console.error('restartTopic error:', err);
    return res.status(500).json({ success: false, message: 'Could not restart this topic.' });
  }
}

// ─── GET /api/ai-teacher/results?topic=<slug> ────────────────────────────────
// Gated on `completed === true` — the CURRENT live session, not the
// permanent ever_completed record. If the student restarted and is mid-redo,
// results aren't available again until they finish that redo, per product
// requirement: no results page until the conversation is actually finished.
async function getResults(req, res) {
  const { topic } = req.query;
  if (!topic) {
    return res.status(400).json({ success: false, message: 'topic is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM topic_conversations WHERE user_id = $1 AND topic_slug = $2',
      [req.userId, topic]
    );

    if (!rows.length || !rows[0].completed) {
      return res.status(403).json({
        success: false,
        message: 'Finish this topic to see your results.',
      });
    }

    const row         = rows[0];
    const history      = row.history || [];
    const corrections = row.analysis?.corrections || [];

    // Zip the raw history with the stored per-message correction segments —
    // history stays clean/unannotated on disk, this view is built on demand.
    let userIdx = 0;
    const turns = history.map((m) => {
      if (m.role === 'user') {
        const segments = corrections[userIdx] || [{ type: 'text', text: m.content }];
        userIdx += 1;
        return { role: 'user', segments };
      }
      return { role: 'assistant', text: m.content };
    });

    return res.json({
      success:      true,
      topicTitle:   row.topic_title,
      scorePercent: row.score_percent,
      turns,
    });
  } catch (err) {
    console.error('getResults error:', err);
    return res.status(500).json({ success: false, message: 'Could not load results.' });
  }
}

module.exports = {
  getSession,
  greetTopic,
  chatWithTopic,
  transcribeAudio,
  speakText,
  getTopicsProgress,
  restartTopic,
  getResults,
};

// ─── Migration note ───────────────────────────────────────────────────────────
// This controller expects a `topic_conversations` table. Run once in Neon:
//
// CREATE TABLE IF NOT EXISTS topic_conversations (
//   id             SERIAL PRIMARY KEY,
//   user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//   topic_slug     VARCHAR(100) NOT NULL,
//   topic_title    VARCHAR(150) NOT NULL,
//   history        JSONB NOT NULL DEFAULT '[]'::jsonb,
//   turn_count     INTEGER NOT NULL DEFAULT 0,
//   completed      BOOLEAN NOT NULL DEFAULT false,  -- current session finished
//   ever_completed BOOLEAN NOT NULL DEFAULT false,  -- permanent unlock record, never reset by /restart
//   score_percent  INTEGER,                         -- 0-100, set once per completed attempt
//   analysis       JSONB,                           -- { corrections: [ [segments], [segments], ... ] }
//   created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
//   updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
//   UNIQUE (user_id, topic_slug)
// );
//
// CREATE INDEX IF NOT EXISTS idx_topic_conversations_user_completed
//   ON topic_conversations (user_id, completed);
//
// If topic_conversations already exists from before this change, run this
// too — it adds the new columns (both nullable, no backfill needed):
//
// ALTER TABLE topic_conversations
//   ADD COLUMN IF NOT EXISTS ever_completed BOOLEAN NOT NULL DEFAULT false,
//   ADD COLUMN IF NOT EXISTS score_percent INTEGER,
//   ADD COLUMN IF NOT EXISTS analysis JSONB;
// UPDATE topic_conversations SET ever_completed = true WHERE completed = true;