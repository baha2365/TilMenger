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
You are an IELTS speaking coach helping a student practice English conversation.

Given the teacher's last message (a question or prompt), generate ONE natural, fluent,
and well-structured sample answer the student could say.

RULES:
- Write only the sample answer — no labels, no explanations, no preamble.
- The answer must be 2-3 sentences, natural and conversational.
- Use clear, correct English suitable for IELTS speaking practice.
- Do NOT add phrases like "Here is a suggestion:" or "You could say:".
- Just output the sample answer sentence(s) directly.
"""

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

conversation = [{"role": "system", "content": SYSTEM_PROMPT}]


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


@app.post("/suggest")
async def suggest(request: Request):
    """
    Generate a sample answer suggestion for the student based on
    the teacher's last message.
    Body: { "last_message": "What do you enjoy doing in your free time?" }
    Returns streaming text of the suggested answer.
    """
    data         = await request.json()
    last_message = data.get("last_message", "").strip()

    if not last_message:
        return JSONResponse({"error": "No last_message provided"}, status_code=400)

    prompt = f'The teacher just said: "{last_message}"\n\nWrite a sample student answer.'

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SUGGEST_SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "stream":  True,
        "options": {
            "num_predict": 80,
            "temperature": 0.5,
        },
    }

    async def generate():
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", OLLAMA_URL, json=payload) as r:
                async for line in r.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if "message" in chunk:
                            yield line + "\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


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

        # Extract JSON from response (model may wrap it in backticks)
        json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if json_match:
            translation_data = json.loads(json_match.group())
        else:
            translation_data = {"word": word, "translation": raw_text, "part_of_speech": "", "example": ""}

        return JSONResponse(translation_data)

    except Exception as e:
        print(f"[Translate] error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)