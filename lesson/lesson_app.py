from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
import asyncio
import json
import urllib.parse
import re
import numpy as np
import sounddevice as sd
import websockets

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "llama3.1:8b"

VIBEVOICE_HOST  = "localhost"
VIBEVOICE_PORT  = 3003
VIBEVOICE_VOICE = "en-Emma_woman"
VIBEVOICE_STEPS = 3
SAMPLE_RATE     = 24_000

app = FastAPI()

# ── System prompts ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """
You are Emma, a 20-year-old friendly, cheerful, and polite English teacher.

STRICT RULES:
- You ONLY talk about English learning topics.
- You ONLY respond in English.
- You teach grammar, vocabulary, pronunciation, speaking, writing, and reading.
- If the user asks about anything unrelated to English learning, you MUST NOT answer.
- If the user is rude, offensive, or inappropriate, you MUST NOT respond at all.
- You must always be polite, kind, and professional.
- Keep explanations clear and suitable for young adult learners.
- Encourage students positively and gently correct their mistakes.

FORMAT RULES (very important):
- Write in plain sentences only. NO bullet points, NO asterisks, NO markdown.
- NO lists with dashes or stars. Use commas or "and" to join items instead.
- Keep your answer under 3 sentences. Be concise.

If the user message violates the rules, return an empty response.
"""

TRANSLATE_SYSTEM_PROMPT = """
You are a translation assistant. When given a single English word and a target language,
respond with ONLY a JSON object in this exact format, no extra text:
{"word": "the_english_word", "translation": "translated_word", "part_of_speech": "noun/verb/adj/etc", "example": "short example sentence in English"}
"""

SUGGEST_SYSTEM_PROMPT = """
You are an English grammar correction assistant.

Your job:
- Check the user's English sentence for grammar, spelling, or word-choice mistakes.
- If there are mistakes, return a corrected version of the sentence.
- Wrap ONLY the corrected words/phrases in <b>bold</b> HTML tags so the user can see what changed.
- If the sentence is already correct, return exactly: {"correct": true}
- Otherwise return ONLY a JSON object in this exact format, no extra text:
  {"correct": false, "corrected": "The corrected sentence with <b>fixed parts</b> in bold"}

Do NOT explain anything. Do NOT add any extra text outside the JSON.
"""

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rolling conversation for the default 3D chat page
conversation = [{"role": "system", "content": SYSTEM_PROMPT}]


# ── Helpers ───────────────────────────────────────────────────────────────────

def build_vocab_system_prompt(level: str, words: list) -> str:
    """
    Dynamically build a level-aware system prompt that instructs Emma
    to practice the given vocabulary words with the student.

    words: [{"english": "apple", "kazakh": "алма"}, ...]
    level: "beginner" | "intermediate" | "advanced"
    """
    level_lower = level.lower()

    word_lines = "\n".join(
        f'  - "{w["english"]}" (Kazakh: {w["kazakh"]})'
        for w in words
    )
    word_list_str = ", ".join(f'"{w["english"]}"' for w in words)

    # ── Level-specific language style ─────────────────────────────────────────
    if level_lower == "beginner":
        style = (
            "- Use VERY simple, short sentences. Maximum 8 words per sentence.\n"
            "- Use only present simple tense (I eat, She goes, etc.).\n"
            "- Avoid difficult words. Speak like you are talking to a child.\n"
            "- Give ONE very short example sentence for each vocabulary word.\n"
            "- Always cheer the student on. Be very encouraging.\n"
            "- Ask only one simple yes/no or one-word-answer question at a time."
        )
        opener_instruction = (
            "Greet the student warmly with very simple words. "
            "Tell them today's new words one by one, each with a very short example. "
            "Then ask them one very easy question about one of the words."
        )
    elif level_lower == "intermediate":
        style = (
            "- Use clear, everyday English with varied sentence lengths.\n"
            "- Use present, past, and future tenses naturally.\n"
            "- Give 1-2 example sentences per vocabulary word when relevant.\n"
            "- Gently point out grammar mistakes in the student's replies.\n"
            "- Ask follow-up questions to keep the conversation going.\n"
            "- Briefly explain word meanings if the student seems confused."
        )
        opener_instruction = (
            "Greet the student warmly. Mention the words they just learned. "
            "Use one word in a natural example sentence. "
            "Ask an open question to start a short conversation using the words."
        )
    else:  # advanced
        style = (
            "- Use rich, natural English including idioms and collocations.\n"
            "- All tenses and complex grammar structures are fine.\n"
            "- Show different contexts or nuances for each vocabulary word.\n"
            "- Challenge the student with thought-provoking, open-ended questions.\n"
            "- Offer detailed grammar feedback when you notice errors.\n"
            "- Discuss subtle differences in meaning between related words."
        )
        opener_instruction = (
            "Greet the student professionally. Reference the vocabulary words and explore their "
            "nuances in your opening. Use at least one word naturally. "
            "Ask a challenging, open-ended question that requires the student to use the new vocabulary."
        )

    return f"""You are Emma, a friendly and enthusiastic English teacher.

TODAY'S VOCABULARY WORDS — use these in your replies with natural example sentences:
{word_lines}

STUDENT LEVEL: {level.upper()}

LANGUAGE STYLE FOR THIS LEVEL:
{style}

YOUR GOALS IN THIS CONVERSATION:
1. Help the student practice the vocabulary words: {word_list_str}.
2. Use each word naturally in at least one example sentence across the conversation.
3. Encourage the student to use the words in their own replies.
4. Gently correct grammar mistakes without discouraging the student.

STRICT RULES:
- ONLY discuss English learning, the vocabulary words, grammar, or pronunciation.
- ONLY respond in English.
- If asked about anything off-topic, say: "Let's stay focused on English practice!"
- Be warm, encouraging, and positive at all times.
- Write in plain sentences ONLY. NO bullet points, NO asterisks, NO markdown symbols.
- Keep answers under 4 sentences. Be concise and conversational.

OPENER INSTRUCTION (apply only to your very first message):
{opener_instruction}
"""


def clean_for_tts(text: str) -> str:
    text = re.sub(r"^\s*[\*\-•]\s+", " ", text, flags=re.MULTILINE)
    text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)
    text = re.sub(r"\n+", " ", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


async def speak(text: str) -> None:
    text = clean_for_tts(text)
    if not text:
        return

    print(f"[TTS] {len(text)} chars → VibeVoice")

    encoded = urllib.parse.quote(text)
    url = (
        f"ws://{VIBEVOICE_HOST}:{VIBEVOICE_PORT}/stream"
        f"?text={encoded}&voice={VIBEVOICE_VOICE}&steps={VIBEVOICE_STEPS}"
    )

    pcm_chunks: list = []

    try:
        async with websockets.connect(url, max_size=None) as ws:
            async for message in ws:
                if isinstance(message, bytes):
                    pcm_chunks.append(message)
    except Exception as e:
        print(f"[VibeVoice] error: {e}")
        return

    if not pcm_chunks:
        return

    raw   = b"".join(pcm_chunks)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    sd.play(audio, samplerate=SAMPLE_RATE, blocking=True)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/chat")
async def chat(request: Request):
    """
    Default chat endpoint — used by the 3D conversation page (conversation.html).
    Body: { "message": "..." }
    """
    global conversation
    data       = await request.json()
    user_input = data.get("message", "")

    conversation.append({"role": "user", "content": user_input})

    system_message = conversation[0]
    chat_history   = conversation[1:][-6:]
    conversation   = [system_message] + chat_history

    payload = {
        "model":    MODEL_NAME,
        "messages": conversation,
        "stream":   True,
        "options": {
            "num_predict": 80,
            "temperature": 0.3,
        },
    }

    async def generate():
        global conversation
        assistant_reply = ""

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", OLLAMA_URL, json=payload) as r:
                async for line in r.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if "message" not in chunk:
                            continue
                        assistant_reply += chunk["message"]["content"]
                        yield line + "\n"

        conversation.append({"role": "assistant", "content": assistant_reply})
        asyncio.create_task(speak(assistant_reply))

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/chat/vocab")
async def chat_vocab(request: Request):
    """
    Vocabulary practice chat endpoint — used by the lesson's conversation flow.

    Body:
    {
        "message": "user reply text"  |  "__opener__" (triggers Emma's first message),
        "level":   "beginner" | "intermediate" | "advanced",
        "words":   [{"english": "apple", "kazakh": "алма"}, ...],
        "history": [{"role": "user"|"assistant", "content": "..."}]   (optional, max 6 turns)
    }

    When message == "__opener__":
        The frontend sends this on page load so Emma speaks first.
        Emma generates her opening greeting using today's words and the student's level.

    Streaming response: Ollama NDJSON lines (same format as /chat).
    """
    data       = await request.json()
    user_input = data.get("message", "").strip()
    level      = data.get("level", "beginner").strip()
    words      = data.get("words", [])      # [{"english": ..., "kazakh": ...}]
    history    = data.get("history", [])    # prior conversation turns

    if not words:
        return JSONResponse({"error": "No vocabulary words provided."}, status_code=400)

    # Build the dynamic, level-aware system prompt with today's words baked in
    system_prompt = build_vocab_system_prompt(level, words)

    # Special opener: tell Emma to generate her first message unprompted
    if user_input == "__opener__":
        effective_message = (
            "Please start our conversation now by sending your opening message. "
            "Follow the OPENER INSTRUCTION in your system prompt exactly."
        )
    else:
        effective_message = user_input

    # Compose the full message list
    messages = [{"role": "system", "content": system_prompt}]

    # Append previous turns (up to 6) for conversational context
    for turn in history[-6:]:
        role    = turn.get("role", "")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": effective_message})

    payload = {
        "model":    MODEL_NAME,
        "messages": messages,
        "stream":   True,
        "options": {
            "num_predict": 120,
            "temperature": 0.5,
        },
    }

    async def generate():
        assistant_reply = ""

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", OLLAMA_URL, json=payload) as r:
                async for line in r.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if "message" not in chunk:
                            continue
                        assistant_reply += chunk["message"]["content"]
                        yield line + "\n"

        asyncio.create_task(speak(assistant_reply))

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/suggest")
async def suggest(request: Request):
    """
    Grammar correction suggestion.
    Body: { "message": "What is snacks?" }
    Returns:
      { "correct": true }
      { "correct": false, "corrected": "What <b>are</b> snacks?" }
    """
    data    = await request.json()
    message = data.get("message", "").strip()

    if not message:
        return JSONResponse({"correct": True})

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SUGGEST_SYSTEM_PROMPT},
            {"role": "user",   "content": message},
        ],
        "stream": False,
        "options": {
            "num_predict": 120,
            "temperature": 0.1,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(OLLAMA_URL, json=payload)
            result   = response.json()

        raw_text = result["message"]["content"].strip()

        json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group())
        else:
            return JSONResponse({"correct": True})

        return JSONResponse(parsed)

    except Exception as e:
        print(f"[Suggest] error: {e}")
        return JSONResponse({"correct": True})


@app.post("/translate")
async def translate(request: Request):
    """
    Translate a single English word using the local LLM.
    Body: { "word": "apple", "target_language": "Russian" }
    Returns: { "word": "apple", "translation": "яблоко", "part_of_speech": "noun", "example": "..." }
    """
    data            = await request.json()
    word            = data.get("word", "").strip()
    target_language = data.get("target_language", "Russian")

    if not word:
        return JSONResponse({"error": "No word provided"}, status_code=400)

    prompt = f'Translate the English word "{word}" to {target_language}.'

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": TRANSLATE_SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "stream": False,
        "options": {
            "num_predict": 120,
            "temperature": 0.1,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(OLLAMA_URL, json=payload)
            result   = response.json()

        raw_text = result["message"]["content"].strip()

        json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if json_match:
            translation_data = json.loads(json_match.group())
        else:
            translation_data = {"word": word, "translation": raw_text, "part_of_speech": "", "example": ""}

        return JSONResponse(translation_data)

    except Exception as e:
        print(f"[Translate] error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)