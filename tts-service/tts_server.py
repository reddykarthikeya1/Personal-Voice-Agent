import asyncio
import io
import uuid
import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Literal

app = FastAPI(title="Edge TTS Service (OpenAI-compatible)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Map OpenAI voice names to Edge TTS voices
VOICE_MAP = {
    "alloy": "en-US-AriaNeural",
    "echo": "en-US-GuyNeural",
    "fable": "en-GB-SoniaNeural",
    "onyx": "en-US-DavisNeural",
    "nova": "en-US-JennyNeural",
    "shimmer": "en-US-AmberNeural",
}


class TTSRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = "alloy"
    response_format: str = "mp3"
    speed: float = 1.0


@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    # Map voice name
    edge_voice = VOICE_MAP.get(request.voice, request.voice)

    # Build edge-tts rate string from speed
    rate_pct = int((request.speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    # Generate audio
    communicate = edge_tts.Communicate(
        text=request.input,
        voice=edge_voice,
        rate=rate_str,
    )

    audio_buffer = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_buffer.write(chunk["data"])

    audio_buffer.seek(0)

    # Determine content type
    content_types = {
        "mp3": "audio/mpeg",
        "opus": "audio/opus",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "wav": "audio/wav",
        "pcm": "audio/pcm",
    }
    content_type = content_types.get(request.response_format, "audio/mpeg")

    request_id = str(uuid.uuid4())
    return StreamingResponse(
        audio_buffer,
        media_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename=speech.{request.response_format}",
            "x-request-id": request_id,
        },
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models():
    return {
        "data": [
            {"id": "tts-1", "object": "model"},
            {"id": "tts-1-hd", "object": "model"},
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8082)
