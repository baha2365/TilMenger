# app.py
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
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
VIBEVOICE_STEPS = 3          # 5→3: жылдамдық үшін (сапа аздап төмендейді)
SAMPLE_RATE     = 24_000

app = FastAPI()

# ── SYSTEM PROMPT ──────────────────────────────────────────────────────────────
# Маңызды: "plain sentences only" — LLM markdown/bullet шығармайды
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

conversation = [{"role": "system", "content": SYSTEM_PROMPT}]


def clean_for_tts(text: str) -> str:
    """Markdown/bullet белгілерін TTS үшін тазалайды."""
    # Bullet белгілері: *, -, • → бос орын
    text = re.sub(r"^\s*[\*\-•]\s+", " ", text, flags=re.MULTILINE)
    # Markdown bold/italic: **text** / *text* → text
    text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)
    # Артық жол аралықтарын бір бос орынға
    text = re.sub(r"\n+", " ", text)
    # Қос бос орындарды тазалау
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


async def speak(text: str) -> None:
    """Тазаланған мәтінді VibeVoice-қа жіберіп аудиосын ойнатады."""
    text = clean_for_tts(text)
    if not text:
        return

    print(f"[TTS] {len(text)} символ → VibeVoice")

    encoded = urllib.parse.quote(text)
    url = (
        f"ws://{VIBEVOICE_HOST}:{VIBEVOICE_PORT}/stream"
        f"?text={encoded}&voice={VIBEVOICE_VOICE}&steps={VIBEVOICE_STEPS}"
    )

    pcm_chunks: list[bytes] = []

    try:
        async with websockets.connect(url, max_size=None) as ws:
            async for message in ws:
                if isinstance(message, bytes):
                    pcm_chunks.append(message)
    except Exception as e:
        print(f"[VibeVoice] қате: {e}")
        return

    if not pcm_chunks:
        return

    raw   = b"".join(pcm_chunks)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    sd.play(audio, samplerate=SAMPLE_RATE, blocking=True)


@app.post("/chat")
async def chat(request: Request):
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
            "num_predict": 80,   # 100→80: жауап қысқарады → TTS жылдамдайды
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

        # LLM бітті → TTS фонда іске қосу
        asyncio.create_task(speak(assistant_reply))

    return StreamingResponse(generate(), media_type="text/event-stream")