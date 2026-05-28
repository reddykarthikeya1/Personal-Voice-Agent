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
    llm,
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
    past_messages = []
    if conn:
        try:
            # Create tables and alter existing schema if needed
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id SERIAL PRIMARY KEY,
                    room_name VARCHAR(255) UNIQUE,
                    title VARCHAR(255),
                    created_at TIMESTAMP DEFAULT NOW()
                );
                ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title VARCHAR(255);
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
            
            # If the conversation already has messages, load them to continue context
            if db_conv_id:
                rows = await conn.fetch(
                    "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
                    db_conv_id
                )
                past_messages = [dict(r) for r in rows]
                logger.info(f"Loaded {len(past_messages)} historical messages from DB to continue conversation.")
            
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

    # Determine user selected voice from remote participant attributes
    selected_voice = os.getenv("OPENAI_TTS_VOICE", "alloy")
    for p in ctx.room.remote_participants.values():
        if p.attributes and "voice" in p.attributes:
            selected_voice = p.attributes["voice"]
            logger.info(f"User selected voice: {selected_voice}")
            break

    # Microsoft edge-tts wrapper
    tts_base_url = os.getenv("OPENAI_TTS_BASE_URL", "http://tts:8082/v1")
    logger.info(f"Initializing edge-tts at {tts_base_url} with voice {selected_voice}")
    tts_instance = openai.TTS(
        model=os.getenv("OPENAI_TTS_MODEL", "tts-1"),
        voice=selected_voice,
        base_url=tts_base_url,
        api_key="not-needed",
    )

    # Initialize chat context with past history if continuing
    chat_ctx = llm.ChatContext()
    for msg in past_messages:
        chat_ctx.add_message(role=msg['role'], content=msg['content'])

    # Create agent with latency optimizations (Item 5 VAD tweaks)
    agent = Agent(
        instructions="You are Kay, a helpful voice assistant. Always write your name as 'Kay' (with only 'K' capitalized) and never in all caps 'KAY' so that the text-to-speech engine pronounces it correctly as a word instead of spelling it out letter-by-letter. Keep responses concise and conversational.",
        vad=ctx.proc.userdata["vad"],
        stt=stt_instance,
        llm=llm_instance,
        tts=tts_instance,
        chat_ctx=chat_ctx,
        use_tts_aligned_transcript=True,
        min_endpointing_delay=0.4,
        max_endpointing_delay=1.0,
        allow_interruptions=True,
    )

    # Start session - don't close on disconnect
    session = AgentSession()

    @session.on("user_input_transcribed")
    def on_user_input(event) -> None:
        logger.info(f"--- USER INPUT TRANSCRIBED: '{event.transcript}' (is_final={event.is_final})")

    @session.on("agent_state_changed")
    def on_agent_state(event) -> None:
        logger.info(f"--- AGENT STATE CHANGED: {event.old_state} -> {event.new_state}")
        
        # When agent finishes speaking (transition from speaking to listening/thinking)
        # We capture the full generated assistant response here to avoid truncation (Fix for Item 5)
        if event.old_state == "speaking" and event.new_state != "speaking":
            assistant_msg = None
            for msg in reversed(session.history.messages()):
                if msg.role == "assistant":
                    assistant_msg = msg
                    break
            
            if assistant_msg and db_conv_id:
                content_str = ""
                if isinstance(assistant_msg.content, list):
                    content_parts = []
                    for part in assistant_msg.content:
                        if hasattr(part, 'text'):
                            content_parts.append(part.text)
                        elif hasattr(part, 'content'):
                            content_parts.append(part.content)
                        elif isinstance(part, str):
                            content_parts.append(part)
                        else:
                            content_parts.append(str(part))
                    content_str = "".join(content_parts)
                elif isinstance(assistant_msg.content, str):
                    content_str = assistant_msg.content
                else:
                    content_str = str(assistant_msg.content)
                
                content_str = content_str.strip()
                if content_str:
                    logger.info(f"Agent finished speaking, saving full response: '{content_str[:50]}...'")
                    
                    async def save_and_publish_agent():
                        try:
                            c = await asyncpg.connect(db_url)
                            await c.execute(
                                "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
                                db_conv_id, 'agent', content_str
                            )
                            logger.info(f"Saved agent message to DB: '{content_str[:30]}...'")
                            
                            # Check auto-naming title as before
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

                                if user_prompt_count >= 3 and not has_custom_title:
                                    logger.info(f"Triggering auto-title generation for session. Prompts count: {user_prompt_count}")
                                    
                                    db_msgs = await c.fetch(
                                        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
                                        db_conv_id
                                    )
                                    
                                    summary_ctx = llm.ChatContext()
                                    for msg in db_msgs:
                                        summary_ctx.add_message(role=msg['role'], content=msg['content'])
                                    
                                    summary_ctx.add_message(
                                        role="system",
                                        content="Create a short, creative 3-to-4 word summary title for this conversation based on the history above. Do not include quotes, markdown, or any introductory text. Reply with ONLY the title."
                                    )
                                    
                                    async with llm_instance.chat(chat_ctx=summary_ctx) as stream:
                                        full_response = await stream.collect()
                                        new_title = full_response.choices[0].message.content.strip()
                                        new_title = new_title.replace('"', '').replace("'", "")
                                        
                                        await c.execute(
                                            "UPDATE conversations SET title = $1 WHERE id = $2",
                                            new_title, db_conv_id
                                        )
                                        logger.info(f"Successfully generated and saved conversation title: '{new_title}'")
                            except Exception as title_err:
                                logger.error(f"Error auto-generating conversation title: {title_err}")
                                
                            await c.close()
                        except Exception as ex:
                            logger.error(f"Error saving agent message to DB: {ex}")
                            
                        try:
                            import json
                            payload = json.dumps({"sender": "agent", "text": content_str})
                            await ctx.room.local_participant.send_text(payload, topic='lk.chat')
                            logger.info(f"Published agent chat message: {payload}")
                        except Exception as ex:
                            logger.error(f"Error publishing agent chat message: {ex}")
                    
                    asyncio.create_task(save_and_publish_agent())

    @session.on("conversation_item_added")
    def on_conversation_item(event) -> None:
        item = event.item
        
        # Save and publish ONLY user messages here immediately (Item 5)
        # Agent messages are handled at completed speech in on_agent_state to prevent truncation
        if hasattr(item, 'role') and item.role == 'user' and hasattr(item, 'content') and item.content and db_conv_id:
            # Safely serialize content to a single string
            content_str = ""
            if isinstance(item.content, list):
                content_parts = []
                for part in item.content:
                    if hasattr(part, 'text'):
                        content_parts.append(part.text)
                    elif hasattr(part, 'content'):
                        content_parts.append(part.content)
                    elif isinstance(part, str):
                        content_parts.append(part)
                    else:
                        content_parts.append(str(part))
                content_str = "".join(content_parts)
            elif isinstance(item.content, str):
                content_str = item.content
            else:
                content_str = str(item.content)

            if not content_str.strip():
                return
            
            # Save message and publish to data channel asynchronously
            async def save_and_publish_user():
                try:
                    c = await asyncpg.connect(db_url)
                    await c.execute(
                        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
                        db_conv_id, 'user', content_str
                    )
                    logger.info(f"Saved user message to DB: user: '{content_str[:30]}...'")
                    await c.close()
                except Exception as ex:
                    logger.error(f"Error saving user message to DB: {ex}")

                try:
                    import json
                    payload = json.dumps({"sender": "user", "text": content_str})
                    await ctx.room.local_participant.send_text(payload, topic='lk.chat')
                    logger.info(f"Published user chat message: {payload}")
                except Exception as ex:
                    logger.error(f"Error publishing user chat message: {ex}")
            
            asyncio.create_task(save_and_publish_user())

    @session.on("error")
    def on_session_error(event) -> None:
        logger.error(f"--- SESSION ERROR: source={event.source}, error={event.error}")

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(close_on_disconnect=False),
    )

    logger.info("Agent session started, waiting for user speech...")
    # Use session.say() instead of generate_reply so the greeting goes directly to TTS
    # without an LLM call (avoids "no user query" error with Qwen and similar models)
    if past_messages:
        greeting = "Welcome back! I remember our previous conversation. What would you like to talk about?"
    else:
        greeting = "Hi there! I'm Kay, your personal voice assistant. How can I help you today?"
    session.say(greeting)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        )
    )
