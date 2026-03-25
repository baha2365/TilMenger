"""
tts_client.py — VibeVoice WebSocket клиенті.
asyncio.Queue арқылы сөйлемдерді алып, VibeVoice /stream эндпойнтіне жібереді.
"""

import asyncio
import logging
import urllib.parse
import numpy as np
import sounddevice as sd
import websockets

logger = logging.getLogger("tts_client")

SAMPLE_RATE = 24_000
CHANNELS = 1
DTYPE = "int16"

VIBEVOICE_HOST = "localhost"
VIBEVOICE_PORT = 3003
VIBEVOICE_VOICE = "en-Emma_woman"


async def _speak_sentence(sentence: str, cfg_scale: float = 1.5) -> None:
    """Бір сөйлемді VibeVoice-қа жіберіп, аудиосын ойнатады."""
    encoded = urllib.parse.quote(sentence)
    url = (
        f"ws://{VIBEVOICE_HOST}:{VIBEVOICE_PORT}/stream"
        f"?text={encoded}&cfg={cfg_scale}&voice={VIBEVOICE_VOICE}"
    )

    pcm_buffer: list[bytes] = []

    try:
        async with websockets.connect(url) as ws:
            async for message in ws:
                if isinstance(message, bytes):
                    pcm_buffer.append(message)
                # текстік хабарламалар (логтар) — елемейміз
    except Exception as exc:
        logger.error("VibeVoice WebSocket қатесі: %s", exc)
        return

    if not pcm_buffer:
        return

    raw = b"".join(pcm_buffer)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # sounddevice арқылы синхронды ойнату (бітіп кетпейді)
    sd.play(audio, samplerate=SAMPLE_RATE, blocking=True)


async def tts_worker(queue: asyncio.Queue) -> None:
    """
    Queue-дан сөйлемдерді оқып, бір-бірлеп VibeVoice-қа жібереді.
    None сентинел алса — тоқтайды.
    """
    while True:
        sentence = await queue.get()
        if sentence is None:
            queue.task_done()
            break
        sentence = sentence.strip()
        if sentence:
            logger.info("TTS: %r", sentence)
            await _speak_sentence(sentence)
        queue.task_done()