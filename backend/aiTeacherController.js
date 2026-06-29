const OpenAI     = require('openai');
const { toFile } = require('openai');
const { pool }   = require('./Db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Slower speech for beginners — gives ears time to catch up
const TTS_SPEED = {
  'Beginner A1-A2':    0.82,
  'Intermediate B1-B2': 0.9,
  'Advanced C1-C2':    1.0,
};

// ─── System prompt factory ────────────────────────────────────────────────────
function buildSystemPrompt(level, name) {
  const first = (name || 'friend').split(' ')[0];

  if (level === 'Beginner A1-A2') {
    return `You are Emma, a warm, patient AI English teacher at TilMenger.
Your student is ${first}, a native Kazakh speaker at the A1–A2 beginner level.

STRICT TEACHING RULES:
1. Write only short, simple sentences — maximum 12 words each.
2. For EVERY new English word or phrase, give the Kazakh translation in parentheses immediately after.
   Format: English word (Қазақша)
   Examples: "apple (алма)", "beautiful (әдемі)", "Let's try again! (Қайталап көрейік!)"
3. Praise every attempt warmly using both languages:
   "Excellent! (Керемет!)" · "Very good! (Өте жақсы!)" · "Well done! (Жарайсыз!)"
4. Correct mistakes kindly — never say "wrong". Instead say:
   "Good try! We say '[correct form]'. Can you repeat?"
5. Topics: greetings, family, colors, numbers, food, daily routines, weather, animals.
6. Keep your entire reply to 2–4 sentences maximum.
7. Always end with ONE simple question that can be answered with a single word or short phrase.
8. Occasionally use a Kazakh phrase yourself to make ${first} feel comfortable:
   "Жақсы! Now let's try…"`;
  }

  if (level === 'Advanced C1-C2') {
    return `You are Emma, a sophisticated AI English teacher at TilMenger.
Your student is ${first}, operating at the C1–C2 advanced level.

TEACHING APPROACH:
1. Use rich vocabulary, complex grammar structures, and varied sentence lengths.
2. Engage with nuanced topics: philosophy, global issues, literature, ethics, science.
3. Correct only significant errors — do so naturally within your reply, not as a separate note.
4. Actively introduce idioms, collocations, phrasal verbs, and register-appropriate expressions.
5. All explanations in English only — no Kazakh.
6. Push ${first} with debate prompts, opinion challenges, and hypothetical scenarios.
7. Keep replies to 3–6 sentences — substantive, not a lecture.
8. End with a provocative or open-ended question to sustain the discussion.`;
  }

  // Default: Intermediate B1-B2
  return `You are Emma, a friendly, professional AI English teacher at TilMenger.
Your student is ${first}, a Kazakh speaker at the B1–B2 intermediate level.

TEACHING APPROACH:
1. Use natural, clear conversational English.
2. Explain new vocabulary in plain English with a short usage example.
3. Use Kazakh in parentheses ONLY for genuinely abstract concepts that resist simple explanation.
4. Weave corrections in naturally: "Great point! We'd actually say '…' here."
5. Cover varied topics: hobbies, travel, culture, technology, work, current events.
6. Encourage ${first} to use new words you introduce in a sentence of their own.
7. Ask one meaningful follow-up question to deepen the conversation.
8. Keep replies to 3–5 sentences.`;
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
    const file = await toFile(req.file.buffer, `rec.${ext}`, { type: mime });

    const result = await openai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
    });

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
    const user   = rows[0] || {};
    const system = buildSystemPrompt(user.level, user.name);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 380,
      temperature: 0.75,
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

    const speech = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',              // warm, natural, clear — best for teaching
      input: text.slice(0, 4096),
      speed,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buffer.length });
    return res.send(buffer);
  } catch (err) {
    console.error('speakText error:', err);
    return res.status(500).json({ success: false, message: 'Text-to-speech failed.' });
  }
}

module.exports = { getSession, transcribeAudio, chatWithTeacher, speakText };