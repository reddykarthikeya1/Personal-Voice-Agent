import os
import logging
import asyncio
import asyncpg

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    RoomInputOptions,
    WorkerOptions,
    cli,
)
from livekit.plugins import openai, silero

load_dotenv()

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("voice-agent")
logger.setLevel(logging.DEBUG)


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext) -> None:
    logger.info("Agent joining room: %s", ctx.room.name)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Initialize PostgreSQL connection and tables
    db_url = os.getenv("POSTGRES_URL", "postgresql://postgres:postgrespassword@db:5432/voice_agent")
    
    # Establish connection with retry logic since DB might take a second to boot up
    conn = None
    for attempt in range(10):
        try:
            conn = await asyncpg.connect(db_url)
            logger.info("Successfully connected to PostgreSQL database.")
            break
        except Exception as e:
            logger.warning(f"Failed to connect to PostgreSQL (attempt {attempt+1}/10): {e}")
            await asyncio.sleep(2)
            
    db_conv_id = None
    if conn:
        try:
            # Create tables
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id SERIAL PRIMARY KEY,
                    room_name VARCHAR(255) UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
                    role VARCHAR(50),
                    content TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            """)
            
            # Insert current room
            await conn.execute(
                "INSERT INTO conversations (room_name) VALUES ($1) ON CONFLICT (room_name) DO NOTHING",
                ctx.room.name
            )
            
            # Fetch conversation ID
            row = await conn.fetchrow("SELECT id FROM conversations WHERE room_name = $1", ctx.room.name)
            if row:
                db_conv_id = row['id']
                logger.info(f"Initialized persistent conversation log in DB. Conv ID: {db_conv_id}")
            
            await conn.close()
        except Exception as e:
            logger.error(f"Error initializing database schema: {e}")

    # LLM
    llm_instance = openai.LLM(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        api_key=os.getenv("OPENAI_API_KEY"),
    )

    # STT
    stt_base_url = os.getenv("OPENAI_STT_BASE_URL", "http://whisper:8000/v1")
    stt_instance = openai.STT(
        model=os.getenv("OPENAI_STT_MODEL", "Systran/faster-whisper-base"),
        base_url=stt_base_url,
        api_key="not-needed",
    )

    # TTS
    tts_base_url = os.getenv("OPENAI_TTS_BASE_URL", "http://tts:8082/v1")
    tts_instance = openai.TTS(
        model=os.getenv("OPENAI_TTS_MODEL", "tts-1"),
        voice=os.getenv("OPENAI_TTS_VOICE", "alloy"),
        base_url=tts_base_url,
        api_key="not-needed",
    )

    # Create agent
    agent = Agent(
        instructions="You are a helpful voice assistant. Keep responses concise and conversational.",
        vad=ctx.proc.userdata["vad"],
        stt=stt_instance,
        llm=llm_instance,
        tts=tts_instance,
        use_tts_aligned_transcript=True,
    )

    # Start session - don't close on disconnect
    session = AgentSession()

    @session.on("user_input_transcribed")
    def on_user_input(event) -> None:
        logger.info(f"--- USER INPUT TRANSCRIBED: '{event.transcript}' (is_final={event.is_final})")

    @session.on("agent_state_changed")
    def on_agent_state(event) -> None:
        logger.info(f"--- AGENT STATE CHANGED: {event.old_state} -> {event.new_state}")

    @session.on("conversation_item_added")
    def on_conversation_item(event) -> None:
        item = event.item
        if hasattr(item, 'role') and hasattr(item, 'content') and item.content and db_conv_id:
            role = 'agent' if item.role == 'assistant' else 'user'
            content = item.content
            
            # Save message asynchronously
            async def save_to_db():
                try:
                    c = await asyncpg.connect(db_url)
                    await c.execute(
                        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
                        db_conv_id, role, content
                    )
                    await c.close()
                    logger.info(f"Saved message to DB: {role}: '{content[:30]}...'")
                except Exception as ex:
                    logger.error(f"Error saving message to DB: {ex}")
            
            asyncio.create_task(save_to_db())

    @session.on("error")
    def on_session_error(event) -> None:
        logger.error(f"--- SESSION ERROR: source={event.source}, error={event.error}")

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )

    logger.info("Agent session started, waiting for user speech...")
    session.generate_reply(instructions="Greet the user warmly and introduce yourself as a helpful voice assistant.")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        )
    )
