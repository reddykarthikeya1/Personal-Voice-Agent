import os
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants
import uvicorn
import asyncpg
from typing import List, Optional

from contextlib import asynccontextmanager

API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "devsecret")
DB_URL = os.environ.get("POSTGRES_URL", "postgresql://postgres:postgrespassword@db:5432/voice_agent")
TOKEN_SERVER_SECRET = os.environ.get("TOKEN_SERVER_SECRET")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create DB connection pool on startup with retries since Postgres might take a moment to be ready
    app.state.db_pool = None
    logger_print = lambda msg: print(f"Token Server: {msg}")
    for attempt in range(10):
        try:
            app.state.db_pool = await asyncpg.create_pool(DB_URL)
            logger_print("Successfully connected to PostgreSQL database pool.")
            break
        except Exception as e:
            logger_print(f"Failed to connect to PostgreSQL (attempt {attempt+1}/10): {e}")
            import asyncio
            await asyncio.sleep(2)
            
    yield
    
    if app.state.db_pool:
        await app.state.db_pool.close()
        logger_print("PostgreSQL connection pool closed.")

app = FastAPI(title="LiveKit Token & History Server", lifespan=lifespan)

# H13: Secure CORS configuration
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
allow_all_origins = "*" in CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=not allow_all_origins,  # Must be False if using "*" wildcard
    allow_methods=["*"],
    allow_headers=["*"],
)

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

# H11: Auth check on /token endpoint if secret is configured
from fastapi import Header

@app.get("/token", response_model=TokenResponse)
async def get_token(
    room: str = Query(default="default-room"),
    identity: str = Query(default="user"),
    voice: Optional[str] = Query(default=None),
    secret: Optional[str] = Query(default=None),
    x_secret: Optional[str] = Header(default=None, alias="X-Token-Server-Secret")
):
    if TOKEN_SERVER_SECRET:
        presented_secret = secret or x_secret
        if presented_secret != TOKEN_SERVER_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized: Invalid token server secret.")

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
        # X7: Map legacy role 'agent' to 'assistant' to remain completely consistent
        formatted_rows = []
        for row in rows:
            d = dict(row)
            if d.get("role") == "agent":
                d["role"] = "assistant"
            formatted_rows.append(d)
        return formatted_rows

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8081)
