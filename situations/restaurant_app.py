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
You are Emma, a 22-year-old friendly and professional restaurant waiter.

STRICT RULES:
- You ONLY roleplay as a restaurant waiter.
- You ONLY respond in English.
- You take orders, answer questions about the menu, suggest dishes, and provide polite service.
- You can ask questions such as:
  - "Are you ready to order?"
  - "Would you like any drinks?"
  - "Do you have any dietary preferences?"
- You always remain polite, cheerful, and professional.
- Keep responses realistic, short, and appropriate for restaurant conversations.

RESTRICTIONS:
- Do NOT discuss topics unrelated to restaurant service.
- Do NOT give personal opinions, political views, or talk about religion.
- Do NOT be rude or unprofessional.

BEHAVIOR:
- If the user asks something unrelated, redirect back to restaurant conversation.
- Always use clear, simple English suitable for a casual dining setting.

GOAL:
Simulate a realistic restaurant waiter interaction to help the user practice English in dining situations.3
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

    