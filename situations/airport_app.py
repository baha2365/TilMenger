# app.py
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
import asyncio
import json


OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "llama3.1:8b"
MAX_HISTORY = 3  # соңғы 3 сұрақ-жауап сақталады

app = FastAPI()

SYSTEM_PROMPT = """
You are Emma, a 25-year-old professional airport passport control receptionist.

STRICT RULES:
- You ONLY roleplay as an airport passport control officer.
- You ONLY respond in English.
- You help passengers with passport control, visas, and airport entry procedures.
- You ask relevant questions such as:
  - "May I see your passport?"
  - "What is the purpose of your visit?"
  - "How long will you stay?"
- You can guide users through airport procedures clearly and politely.
- You must remain formal, calm, and professional at all times.
- Keep responses short and realistic, like a real officer.

RESTRICTIONS:
- Do NOT discuss unrelated topics.
- Do NOT answer questions outside airport, travel, or passport control context.
- Do NOT discuss politics, religion, or personal opinions.
- Do NOT be rude or emotional.

BEHAVIOR:
- If the user says something unrelated, redirect them back to passport control conversation.
- If the user provides information, respond like a real officer (ask next question or give instructions).
- Use simple, clear English.

GOAL:
Simulate a realistic airport passport control interaction to help the user practice English in travel situations.
"""

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Conversation storage per session
conversation = [
    {"role": "system", "content": SYSTEM_PROMPT}
]

@app.post("/chat")
async def chat(request: Request):
    global conversation
    data = await request.json()
    user_input = data.get("message")

    conversation.append({"role": "user", "content": user_input})

    system_message = conversation[0]
    chat_history = conversation[1:]
    chat_history = chat_history[-6:]
    conversation = [system_message] + chat_history

    payload = {
        "model": MODEL_NAME,
        "messages": conversation,
        "stream": True,
        "options": {
            "num_predict": 100,   # limit response length
            "temperature": 0.3
        }
    }

    async def generate():
        global conversation
        assistant_reply = ""

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", OLLAMA_URL, json=payload) as r:
                async for line in r.aiter_lines():
                    if line.strip():
                        data = json.loads(line)
                        text = data["message"]["content"]

                        assistant_reply += text
                        yield line + "\n"

        conversation.append({
            "role": "assistant",
            "content": assistant_reply
        })
        # clear_file()
        # write_text(assistant_reply)

    return StreamingResponse(generate(), media_type="text/event-stream")

    