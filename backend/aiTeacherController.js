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

// ─── System prompt factory ────────────────────────────────────────────────────
//
// Design goals (per product decision, July 2026):
//   1. Emma is a friendly conversation partner (LangAI-style), not a drill
//      sergeant. She chats about everyday topics — daily routine, favorite
//      food/movies/games, hobbies, weekend plans — and teaches AS she goes,
//      instead of stopping to force repetition or "make a sentence with X."
//   2. Replies stay short. No long self-introductions, no menus of topics.
//   3. English only, at every level. No Kazakh, no other languages.
//   4. Vocabulary/sentence complexity scales with level.
//   5. Topics stay light and appropriate — no violent, adult, dangerous,
//      or otherwise unsuitable subject matter, even if the student raises it.

const TOPIC_SAFETY = `
TOPIC BOUNDARIES (always apply):
- Stick to everyday, positive topics: daily routine, hobbies, favorite food, movies, games, music, sports, travel, weather, family, pets, school or work, weekends, seasons, dreams/goals, etc.
- Never engage with violent, sexual, adult, drug-related, self-harm, or otherwise dangerous or inappropriate topics, even if the student brings them up. If they do, respond briefly and kindly, then steer the conversation back to a safe, everyday topic.
- Keep the mood light, positive, and encouraging at all times.
`;

const CONVERSATION_STYLE = `
CONVERSATION STYLE — you are a friendly conversation partner, not a drill instructor:
- Talk the way a friendly tutor on a language app would: ask about the student's day, hobbies, favorite food, movies, games, weekend plans, and have a natural back-and-forth — like chatting with a friend who happens to speak great English.
- Teach naturally AS you chat, don't stop the conversation to run drills:
  - If the student makes a mistake, gently fold the correct form into your reply and keep going — don't dwell on it or ask them to repeat it.
  - When a good moment comes up, you can introduce ONE new word or phrase in context with a quick, casual one-line meaning — but don't demand they repeat it or build a sentence with it. If they use it later, great; if not, that's fine too.
- Never say "try again," never force repetition, never insist on a specific answer. Accept what the student says and keep the conversation moving forward naturally.
- Ask ONE natural follow-up question per turn to keep the chat flowing — the kind a curious friend would ask, not a test question.
- Let topics evolve naturally over the conversation (e.g., from breakfast, to cooking, to favorite restaurants) rather than sticking rigidly to one subject.
${TOPIC_SAFETY}`;

const OPENING_RULES = `
OPENING TURN (this is the very first message of the session):
- Do NOT give a self-introduction, a life story, or ask "what would you like to practice today?"
- Greet the student by name in a few words, then ask one warm, casual question about an everyday topic (their day, a hobby, favorite food, weekend plans, etc.) to kick off the chat.
- Keep the whole opening within your normal reply length limit for this level — no exceptions for the first message.
`;

function buildSystemPrompt(level, name, isFirstTurn) {
  const first = (name || 'friend').split(' ')[0];
  const opening = isFirstTurn ? OPENING_RULES : '';

  if (level === 'Beginner A1-A2') {
    return `You are Emma, a warm, patient AI English conversation partner at TilMenger.
Your student is ${first}, a beginner (A1-A2) English learner.
${CONVERSATION_STYLE}
BEGINNER STYLE:
- Use only the simplest, most common English words — talk like you're chatting with a young child.
- Sentences must be short: max 6-8 words each.
- If you introduce a new word, explain it with a simpler word or by describing it, in passing — not as a formal lesson.
- Be warm and encouraging: "Nice!" "That's fun!" "Me too!"
- Reply length: 2-3 short sentences total, max.
${opening}`;
  }

  if (level === 'Advanced C1-C2') {
    return `You are Emma, a sharp, engaging AI English conversation partner at TilMenger.
Your student is ${first}, an advanced (C1-C2) English learner.
${CONVERSATION_STYLE}
ADVANCED STYLE:
- Use rich vocabulary, idioms, collocations, and varied sentence structures, the way an articulate friend would.
- Feel free to go a little deeper on everyday topics — opinions on movies, travel stories, hobbies, goals — without turning it into a debate drill.
- Correct only significant errors, and weave the correction naturally into your reply rather than flagging it separately.
- Reply length: 3-5 sentences total, max.
${opening}`;
  }

  // Default: Intermediate B1-B2
  return `You are Emma, a friendly AI English conversation partner at TilMenger.
Your student is ${first}, an intermediate (B1-B2) English learner.
${CONVERSATION_STYLE}
INTERMEDIATE STYLE:
- Use natural, clear conversational English.
- If you introduce a new word or phrase, give a quick plain-English meaning in passing, not a formal definition.
- Weave corrections in naturally: "Ah, we'd usually say '...' — but I got what you meant!"
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
    // Drives the short, straight-into-conversation opening instead of a long intro.
    const isFirstTurn = !messages.some(m => m.role === 'assistant');
    const system = buildSystemPrompt(user.level, user.name, isFirstTurn);

    const completion = await lemonfox.chat.completions.create({
      model:       'llama-8b-chat',
      messages:    [{ role: 'system', content: system }, ...messages],
      max_tokens:  220,
      temperature: 0.8,
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