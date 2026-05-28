import os
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants
import uvicorn
import asyncpg
from typing import List, Optional

app = FastAPI(title="LiveKit Token & History Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "devsecret")
DB_URL = os.environ.get("POSTGRES_URL", "postgresql://postgres:postgrespassword@db:5432/voice_agent")

class TokenResponse(BaseModel):
    token: str

class MessageItem(BaseModel):
    role: str
    content: str
    created_at: str

class ConversationItem(BaseModel):
    id: int
    room_name: str
    title: Optional[str] = None
    created_at: str

@app.on_event("startup")
async def startup():
    # Create DB connection pool on startup with retries since Postgres might take a moment to be ready
    app.state.db_pool = None
    for attempt in range(10):
        try:
            app.state.db_pool = await asyncpg.create_pool(DB_URL)
            print("Token Server: Successfully connected to PostgreSQL database pool.")
            break
        except Exception as e:
            print(f"Token Server: Failed to connect to PostgreSQL (attempt {attempt+1}/10): {e}")
            import asyncio
            await asyncio.sleep(2)

@app.on_event("shutdown")
async def shutdown():
    if app.state.db_pool:
        await app.state.db_pool.close()

@app.get("/token", response_model=TokenResponse)
async def get_token(
    room: str = Query(default="default-room"),
    identity: str = Query(default="user"),
    voice: Optional[str] = Query(default=None),
):
    token = (
        AccessToken(api_key=API_KEY, api_secret=API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(VideoGrants(room_join=True, room=room))
    )
    if voice:
        token.with_attributes({"voice": voice})

    return TokenResponse(token=token.to_jwt())

@app.get("/conversations", response_model=List[ConversationItem])
async def list_conversations():
    if not app.state.db_pool:
        raise HTTPException(status_code=503, detail="Database connection is not available")
    
    async with app.state.db_pool.acquire() as conn:
        try:
            rows = await conn.fetch("SELECT id, room_name, title, created_at::text FROM conversations ORDER BY created_at DESC")
            return [dict(row) for row in rows]
        except Exception as e:
            # Table might not exist yet if agent hasn't booted
            return []

@app.get("/conversations/{room_name}/messages", response_model=List[MessageItem])
async def get_messages(room_name: str):
    if not app.state.db_pool:
        raise HTTPException(status_code=503, detail="Database connection is not available")
    
    async with app.state.db_pool.acquire() as conn:
        # Check if conversation exists
        conv = await conn.fetchrow("SELECT id FROM conversations WHERE room_name = $1", room_name)
        if not conv:
            return []
        
        rows = await conn.fetch(
            "SELECT role, content, created_at::text FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
            conv['id']
        )
        return [dict(row) for row in rows]

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8081)
