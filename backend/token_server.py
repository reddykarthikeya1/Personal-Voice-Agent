import os
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants
import uvicorn

app = FastAPI(title="LiveKit Token Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "devsecret")


class TokenResponse(BaseModel):
    token: str


@app.get("/token", response_model=TokenResponse)
async def get_token(
    room: str = Query(default="default-room"),
    identity: str = Query(default="user"),
):
    token = (
        AccessToken(api_key=API_KEY, api_secret=API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(VideoGrants(room_join=True, room=room))
    )

    return TokenResponse(token=token.to_jwt())


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8081)
