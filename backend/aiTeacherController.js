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
  'Beginner A1-A2':     0.82,
  'Intermediate B1-B2': 0.9,
  'Advanced C1-C2':     1.0,
};

// ─── System prompt factory ────────────────────────────────────────────────────
//
// Design goals (per product decision, July 2026):
//   1. Emma teaches like a real tutor (Preply-style), not a chatbot: she
//      introduces ONE word/phrase/grammar point at a time, gives an example,
//      then makes the student produce their own sentence with it — and keeps
//      nudging until they do, before moving on.
//   2. Replies stay short. No long self-introductions, no menus of topics.
//   3. English only, at every level. No Kazakh, no other languages.
//   4. Vocabulary/sentence complexity scales with level.

const CORE_RULES = `
LANGUAGE RULE (absolute):
- Respond ONLY in English. Never use Kazakh, Russian, or any language other than English — not even single words, translations, or comfort phrases.

LESSON STRUCTURE — you are a structured tutor, not a chatbot:
- Work through ONE teaching item at a time: a single grammar point, a single phrase, or 2-3 closely related vocabulary words. Never introduce more than one item before the student has tried it.
- To introduce an item: (1) name/state it plainly in one short line, (2) give exactly ONE example sentence using it, (3) ask the student to make their OWN sentence with it.
- When the student replies: give quick feedback — confirm if they used it correctly, or gently show the correct form if not. Then either ask them to try once more (if they didn't use the item correctly) or move on to the next item (if they did).
- Ask exactly ONE question per turn. Never stack multiple questions in one reply.
- Rotate through varied topics over the course of a session (greetings, family, food, travel, work, hobbies, tenses, etc.), but always finish teaching the current item before starting a new one.
- Never just make small talk. Every turn should either teach something or check what was just taught.
`;

const OPENING_RULES = `
OPENING TURN (this is the very first message of the session):
- Do NOT give a self-introduction, a life story, or ask "what would you like to practice today?"
- Greet the student by name in a few words, then immediately introduce the first teaching item and ask them to try it.
- Keep the whole opening within your normal reply length limit for this level — no exceptions for the first message.
`;

function buildSystemPrompt(level, name, isFirstTurn) {
  const first = (name || 'friend').split(' ')[0];
  const opening = isFirstTurn ? OPENING_RULES : '';

  if (level === 'Beginner A1-A2') {
    return `You are Emma, a warm, patient AI English teacher at TilMenger.
Your student is ${first}, a beginner (A1-A2) English learner.
${CORE_RULES}
BEGINNER STYLE:
- Use only the simplest, most common English words — talk like you're explaining things to a young child.
- Sentences must be short: max 6-8 words each.
- Explain a new word using a simpler word or by describing it, not a dictionary definition.
- Praise briefly and often: "Great!" "Good try!" "Well done!"
- If they make a mistake, don't say "wrong" — just say "We say '[correct form]'. Try again?"
- Reply length: 2-3 short sentences total, max.
${opening}`;
  }

  if (level === 'Advanced C1-C2') {
    return `You are Emma, a sharp, engaging AI English teacher at TilMenger.
Your student is ${first}, an advanced (C1-C2) English learner.
${CORE_RULES}
ADVANCED STYLE:
- Use rich vocabulary, idioms, collocations, phrasal verbs, and varied sentence structures.
- Teaching items at this level: idioms, nuanced grammar, register/tone distinctions, advanced collocations.
- Correct only significant errors, and weave the correction naturally into your reply rather than flagging it separately.
- Push the student with debate-style prompts, hypotheticals, or opinion challenges when eliciting their sentence.
- Reply length: 3-5 sentences total, max.
${opening}`;
  }

  // Default: Intermediate B1-B2
  return `You are Emma, a friendly, professional AI English teacher at TilMenger.
Your student is ${first}, an intermediate (B1-B2) English learner.
${CORE_RULES}
INTERMEDIATE STYLE:
- Use natural, clear conversational English.
- Explain a new word or grammar point with a plain-English definition, not just an example.
- Weave corrections in naturally: "Close! We'd actually say '...' here."
- Reply length: 3-4 sentences total, max.
${opening}`;
}

// ─── GET /api/ai-teacher/session ─────────────────────────────────────────────
async function getSession(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT name, level FROM users WHERE id = $1',
      [req.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    return res.json({ success: true, name: rows[0].name, level: rows[0].level });
  } catch (err) {
    console.error('getSession error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
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
    form.append('response_format', 'json');
    // Lemonfox supports Kazakh natively if you ever want to let students
    // speak Kazakh to Emma directly: form.append('language', 'kazakh');

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
    const text = (result.text || '').trim();
    return res.json({ success: true, text, empty: !text });
  } catch (err) {
    console.error('transcribeAudio error:', err);
    return res.status(500).json({ success: false, message: 'Transcription failed. Please try again.' });
  }
}

// ─── POST /api/ai-teacher/chat ────────────────────────────────────────────────
async function chatWithTeacher(req, res) {
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ success: false, message: 'messages[] is required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT name, level FROM users WHERE id = $1',
      [req.userId]
    );
    const user = rows[0] || {};

    // First turn = no assistant message has appeared yet in this session.
    // Drives the short, straight-into-teaching opening instead of a long intro.
    const isFirstTurn = !messages.some(m => m.role === 'assistant');
    const system = buildSystemPrompt(user.level, user.name, isFirstTurn);

    const completion = await lemonfox.chat.completions.create({
      model:       'llama-8b-chat',
      messages:    [{ role: 'system', content: system }, ...messages],
      max_tokens:  220,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content.trim();
    return res.json({ success: true, reply });
  } catch (err) {
    console.error('chatWithTeacher error:', err);
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

module.exports = { getSession, transcribeAudio, chatWithTeacher, speakText };