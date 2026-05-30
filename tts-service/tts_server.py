import asyncio
import io
import os
import uuid
import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional, Literal

app = FastAPI(title="Edge TTS Service (OpenAI-compatible)")

# H13: Secure CORS configuration
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
allow_all_origins = "*" in CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=not allow_all_origins,
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


# M5: Add strict schema bounds for input validation
class TTSRequest(BaseModel):
    model: str = "tts-1"
    input: str = Field(..., max_length=5000)  # Bound characters to prevent memory exhaustion
    voice: str = "alloy"
    response_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = "mp3"
    speed: float = Field(1.0, ge=0.25, le=4.0)  # Bound speed to valid range


# H4: High-performance async FFmpeg transcoder
async def convert_audio(mp3_bytes: bytes, target_format: str) -> bytes:
    if target_format == "mp3":
        return mp3_bytes

    # Map target formats to FFmpeg output format names & codecs
    format_mapping = {
        "wav": ("wav", ["-acodec", "pcm_s16le"]),
        "opus": ("opus", ["-acodec", "libopus"]),
        "aac": ("adts", ["-acodec", "aac"]),
        "flac": ("flac", ["-acodec", "flac"]),
        "pcm": ("s16le", ["-f", "s16le", "-acodec", "pcm_s16le"]),
    }

    mapping = format_mapping.get(target_format)
    if not mapping:
        return mp3_bytes

    out_fmt, extra_args = mapping
    cmd = ["ffmpeg", "-y", "-i", "pipe:0", "-f", out_fmt] + extra_args + ["pipe:1"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate(input=mp3_bytes)
        
        if proc.returncode != 0:
            err_msg = stderr.decode()
            print(f"TTS Server: FFmpeg transcoding failed: {err_msg}")
            raise HTTPException(status_code=500, detail=f"Audio transcoding failed: {err_msg}")
            
        return stdout
    except HTTPException:
        raise
    except Exception as e:
        print(f"TTS Server: FFmpeg execution error: {e}")
        # Fallback to returning the raw MP3 bytes if FFmpeg is unavailable or crashes
        return mp3_bytes


@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    # Map voice name
    edge_voice = VOICE_MAP.get(request.voice, request.voice)

    # Build edge-tts rate string from speed
    rate_pct = int((request.speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    try:
        # Generate audio using Microsoft Edge Neural TTS
        communicate = edge_tts.Communicate(
            text=request.input,
            voice=edge_voice,
            rate=rate_str,
        )

        audio_buffer = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buffer.write(chunk["data"])

        mp3_bytes = audio_buffer.getvalue()
        if not mp3_bytes:
            raise HTTPException(status_code=500, detail="TTS generation yielded empty audio.")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Edge-TTS synthesis failed: {e}")

    # H4: Convert MP3 to the requested target format dynamically
    final_audio_bytes = await convert_audio(mp3_bytes, request.response_format)
    final_buffer = io.BytesIO(final_audio_bytes)

    # Determine standard MIME content type
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
        final_buffer,
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
