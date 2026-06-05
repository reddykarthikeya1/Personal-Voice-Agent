import os
import logging
import asyncio
import asyncpg
import json

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
    llm,
    TurnHandlingOptions,
    function_tool,
)
from livekit.plugins import openai, silero
from tavily import AsyncTavilyClient

load_dotenv()

# L2: Dynamic log level with INFO default in production
log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, log_level_str, logging.INFO)

logging.basicConfig(level=log_level)
logger = logging.getLogger("voice-agent")
logger.setLevel(log_level)

# H1: Global DB connection pool & Lock for concurrent-safe initialization
db_pool = None
db_pool_lock = asyncio.Lock()


async def get_db_pool(db_url: str) -> asyncpg.Pool:
    global db_pool
    async with db_pool_lock:
        if db_pool is None:
            logger.info("Initializing global PostgreSQL connection pool...")
            for attempt in range(10):
                try:
                    db_pool = await asyncpg.create_pool(db_url, min_size=2, max_size=10)
                    logger.info("Successfully created global PostgreSQL database pool.")
                    break
                except Exception as e:
                    logger.warning("Failed to connect to PostgreSQL (attempt %d/10): %s", attempt+1, e)
                    await asyncio.sleep(2)
            if db_pool is None:
                raise Exception("Could not connect to PostgreSQL database pool after 10 attempts")
        return db_pool


# H2: Strong reference background tasks set to prevent garbage collection
background_tasks = set()


def run_background_task(coro, name=None):
    task = asyncio.create_task(coro, name=name)
    background_tasks.add(task)
    
    def handle_result(t):
        background_tasks.discard(t)
        try:
            t.result()
        except asyncio.CancelledError:
            pass
        except Exception as ex:
            logger.error("Error in background task %s: %s", t.get_name(), ex, exc_info=True)
            
    task.add_done_callback(handle_result)
    return task


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


@function_tool
async def web_search(
    query: str,
) -> str:
    """Search the web for current information, news, facts, or weather.
    
    Args:
        query: The search query to look up on the web.
    """
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        logger.error("TAVILY_API_KEY is not set.")
        return "Search failed: TAVILY_API_KEY is not set."
        
    logger.info("Executing Tavily web search for query: '%s'", query)
    try:
        client = AsyncTavilyClient(api_key=api_key)
        response = await client.search(query=query, max_results=3, search_depth="basic")
        
        results = response.get("results", [])
        if not results:
            logger.info("No search results returned for query: '%s'", query)
            return "No results found."
            
        summaries = []
        for r in results:
            title = r.get("title", "No Title")
            content = r.get("content", "")
            summaries.append(f"Title: {title}\nContent: {content[:200]}")
            
        formatted_result = "\n\n".join(summaries)
        logger.info("Search successfully completed. Summarized results: %s...", formatted_result[:100])
        return formatted_result
    except Exception as e:
        logger.error("Error executing Tavily web search: %s", e, exc_info=True)
        return f"An error occurred while searching the web: {str(e)}"


async def entrypoint(ctx: JobContext) -> None:
    logger.info("Agent joining room: %s", ctx.room.name)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Initialize PostgreSQL connection and tables
    db_url = os.getenv("POSTGRES_URL", "postgresql://postgres:postgrespassword@db:5432/voice_agent")
    
    # H1: Acquire connection pool
    try:
        pool = await get_db_pool(db_url)
    except Exception as e:
        logger.error("Failed to initialize Postgres pool: %s", e)
        pool = None
            
    db_conv_id = None
    past_messages = []
    
    # C2: Use pool.acquire() context manager for automatic connection release & no leaks
    if pool:
        try:
            async with pool.acquire() as conn:
                # L4: Removed redundant ALTER TABLE conversations ADD COLUMN title since it is already in CREATE TABLE
                await conn.execute("""
                    CREATE TABLE IF NOT EXISTS conversations (
                        id SERIAL PRIMARY KEY,
                        room_name VARCHAR(255) UNIQUE,
                        title VARCHAR(255),
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
                    logger.info("Initialized persistent conversation log in DB. Conv ID: %s", db_conv_id)
                
                # If the conversation already has messages, load them to continue context
                if db_conv_id:
                    rows = await conn.fetch(
                        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
                        db_conv_id
                    )
                    past_messages = [dict(r) for r in rows]
                    logger.info("Loaded %d historical messages from DB to continue conversation.", len(past_messages))
        except Exception as e:
            logger.error("Error initializing database schema or room info: %s", e)

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

    # M2: Wait up to 3 seconds for remote participants to propagate attributes
    selected_voice = os.getenv("OPENAI_TTS_VOICE", "alloy")
    for _ in range(30):
        if ctx.room.remote_participants:
            break
        await asyncio.sleep(0.1)

    for p in ctx.room.remote_participants.values():
        if p.attributes and "voice" in p.attributes:
            selected_voice = p.attributes["voice"]
            logger.info("User selected voice: %s", selected_voice)
            break

    # L11 & X14: Handle dynamic TTS Providers (edge-tts vs kokoro-tts) with Kokoro voice mapping
    tts_provider = os.getenv("TTS_PROVIDER", "edge-tts").lower()
    tts_voice = selected_voice
    if tts_provider == "kokoro":
        KOKORO_VOICE_MAP = {
            "alloy": "af_bella",
            "nova": "af_nicole",
            "shimmer": "af_sarah",
            "echo": "am_adam",
            "onyx": "am_michael",
            "fable": "bf_emma",
        }
        tts_voice = KOKORO_VOICE_MAP.get(selected_voice, "af_bella")
        tts_base_url = os.getenv("KOKORO_TTS_URL", "http://kokoro-tts:8880/v1")
        logger.info("Initializing Kokoro-TTS at %s with voice %s (mapped from %s)", tts_base_url, tts_voice, selected_voice)
    else:
        tts_base_url = os.getenv("OPENAI_TTS_BASE_URL", "http://tts:8082/v1")
        logger.info("Initializing Edge-TTS at %s with voice %s", tts_base_url, tts_voice)

    tts_instance = openai.TTS(
        model=os.getenv("OPENAI_TTS_MODEL", "tts-1"),
        voice=tts_voice,
        base_url=tts_base_url,
        api_key="not-needed",
    )

    # Initialize chat context with past history, mapping role 'agent' to 'assistant' (C4)
    chat_ctx = llm.ChatContext()
    for msg in past_messages:
        role = 'assistant' if msg['role'] == 'agent' else msg['role']
        chat_ctx.add_message(role=role, content=msg['content'])

    # Determine greeting to be spoken on startup
    if past_messages:
        greeting = "Welcome back! I remember our previous conversation. What would you like to talk about?"
    else:
        greeting = "Hi there! I'm Kay, your personal voice assistant. How can I help you today?"

    # H15: Create agent with modern TurnHandlingOptions
    interruption_mode = os.getenv("INTERRUPTION_MODE", "adaptive").lower()
    agent = Agent(
        instructions="You are Kay, a helpful voice assistant. Always write your name as 'Kay' (with only 'K' capitalized) and never in all caps 'KAY' so that the text-to-speech engine pronounces it correctly as a word instead of spelling it out letter-by-letter. Keep responses concise and conversational. You have access to a web search tool to search the web for current information, news, facts, or weather when asked or when you need up-to-date knowledge.",
        vad=ctx.proc.userdata["vad"],
        stt=stt_instance,
        llm=llm_instance,
        tts=tts_instance,
        chat_ctx=chat_ctx,
        tools=[web_search],
        use_tts_aligned_transcript=True,
        turn_handling=TurnHandlingOptions(
            turn_detection="vad",
            endpointing={
                "mode": "fixed",
                "min_delay": 0.4,
                "max_delay": 1.0,
            },
            interruption={
                "mode": interruption_mode
            }
        )
    )

    # X1: Instantiate AgentSession so session is defined
    session = AgentSession()

    # M4: Boolean flag on entrypoint scope to ensure auto-title runs exactly once
    title_generated = False

    @session.on("agent_state_changed")
    def on_agent_state(event) -> None:
        logger.info("--- AGENT STATE CHANGED: %s -> %s", event.old_state, event.new_state)

    async def _on_conversation_item(event) -> None:
        nonlocal title_generated
        item = event.item
        
        # Save and publish user and assistant ChatMessage items when they are committed to context
        if isinstance(item, llm.ChatMessage) and item.content and db_conv_id:
            # Safely serialize content to a single string (skip raw bytes like AudioContent.content)
            content_str = (item.text_content or "").strip()
            if not content_str:
                return
            
            # Map role: 'assistant' to 'assistant', and anything else to 'user'
            role = 'assistant' if item.role in ('assistant', 'agent') else 'user'
            
            # N1: Decoupled message broadcasting to keep UI active (broadcast first)
            try:
                payload = json.dumps({"sender": role, "text": content_str})
                await ctx.room.local_participant.send_text(payload, topic='lk.chat')
                logger.info("Published %s chat message: %s", role, payload)
            except Exception as ex:
                logger.error("Error publishing %s chat message: %s", role, ex)

            # M15 & M1: Await database save in event handler to preserve order
            run_title_generation = False
            db_msgs = []
            if pool:
                try:
                    async with pool.acquire() as c:
                        await c.execute(
                            "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
                            db_conv_id, role, content_str
                        )
                        logger.info("Saved %s message to DB: '%s...'", role, content_str[:30])
                        
                        # Check auto-naming title if it is a user message
                        if role == 'user':
                            try:
                                count_row = await c.fetchrow(
                                    "SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND role = 'user'",
                                    db_conv_id
                                )
                                user_prompt_count = count_row[0]

                                title_row = await c.fetchrow(
                                    "SELECT title FROM conversations WHERE id = $1",
                                    db_conv_id
                                )
                                has_custom_title = title_row['title'] is not None if title_row else False

                                if user_prompt_count >= 3 and not has_custom_title and not title_generated:
                                    title_generated = True
                                    run_title_generation = True
                                    rows = await c.fetch(
                                        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
                                        db_conv_id
                                    )
                                    db_msgs = [dict(r) for r in rows]
                            except Exception as title_err:
                                logger.error("Error checking title requirements: %s", title_err)
                except Exception as ex:
                    logger.error("Error saving %s message to DB: %s", role, ex)

            # X8: Make LLM auto-title round-trip outside of connection acquisition block to prevent pool exhaustion
            if run_title_generation and db_msgs:
                try:
                    logger.info("Triggering auto-title generation for session outside connection pool lock.")
                    summary_ctx = llm.ChatContext()
                    summary_ctx.add_message(
                        role="system",
                        content="Create a short, creative 3-to-4 word summary title for this conversation based on the history above. Do not include quotes, markdown, or any introductory text. Reply with ONLY the title."
                    )
                    for msg in db_msgs:
                        msg_role = 'assistant' if msg['role'] == 'agent' else msg['role']
                        summary_ctx.add_message(role=msg_role, content=msg['content'])
                    
                    async with llm_instance.chat(chat_ctx=summary_ctx) as stream:
                        full_response = await stream.collect()
                        new_title = full_response.text.strip()
                        new_title = new_title.replace('"', '').replace("'", "")
                        
                    # Re-acquire connection just for the quick update statement
                    if pool:
                        try:
                            async with pool.acquire() as c:
                                await c.execute(
                                    "UPDATE conversations SET title = $1 WHERE id = $2",
                                    new_title, db_conv_id
                                )
                                logger.info("Successfully generated and saved conversation title: '%s'", new_title)
                        except Exception as update_err:
                            logger.error("Failed to save generated conversation title to DB: %s", update_err)
                except Exception as title_err:
                    logger.error("Error auto-generating conversation title: %s", title_err)

    @session.on("conversation_item_added")
    def on_conversation_item(event) -> None:
        run_background_task(_on_conversation_item(event), name="on_conversation_item")

    # X3: Change deprecated "error" event to "close"
    @session.on("close")
    def on_session_close(event) -> None:
        logger.info("--- SESSION CLOSED: reason=%s, error=%s", getattr(event, 'reason', None), getattr(event, 'error', None))

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )

    logger.info("Agent session started, waiting for user speech...")
    # Use session.say() instead of generate_reply so the greeting goes directly to TTS
    # without an LLM call (avoids "no user query" error with Qwen and similar models)
    session.say(greeting)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        )
    )
