import os
import logging
import asyncio
import asyncpg
import json
import csv
import io
import re
import aiohttp

from datetime import datetime, timezone

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
    """Search the web for current, up-to-date information: news, recent events, prices,
    weather, sports, or facts about specific people, products, or companies.

    Phrase the query in natural, present-tense terms describing what you want to know.
    Do NOT add a year to the query unless the user explicitly asked about a specific past
    year — adding an old year forces stale results. Base your answer on what this tool
    returns, not on prior memory.

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
        response = await client.search(query=query, max_results=5, search_depth="basic")

        results = response.get("results", [])
        if not results:
            logger.info("No search results returned for query: '%s'", query)
            return "No results found. Try rephrasing the query in simpler, present-tense terms."

        # Re-anchor the model to the real current date so it doesn't fall back to its
        # training-era default year when summarizing the results.
        today = datetime.now(timezone.utc).strftime("%A, %B %d, %Y")
        summaries = [f"(Today's date is {today}. Use only the information below; it is current.)"]
        for r in results:
            title = r.get("title", "No Title")
            content = r.get("content", "")
            published = r.get("published_date") or ""
            line = f"Title: {title}\nContent: {content[:300]}"
            if published:
                line += f"\nPublished: {published}"
            summaries.append(line)

        formatted_result = "\n\n".join(summaries)
        logger.info("Search successfully completed. Summarized results: %s...", formatted_result[:100])
        return formatted_result
    except Exception as e:
        logger.error("Error executing Tavily web search: %s", e, exc_info=True)
        return f"An error occurred while searching the web: {str(e)}"


# Shared async HTTP helper for the keyless data tools below.
async def _http_get_json(url: str, params: dict | None = None, timeout: float = 10.0):
    timeout_cfg = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=timeout_cfg) as session:
        async with session.get(url, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


# WMO weather interpretation codes -> short spoken descriptions
_WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "heavy freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
    85: "light snow showers", 86: "snow showers",
    95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail",
}


@function_tool
async def get_weather(location: str) -> str:
    """Get the current weather conditions for a city or place. Use this for any weather
    question instead of a generic web search — it is faster and more accurate.

    Args:
        location: The city or place name, e.g. "Tokyo" or "Paris, France".
    """
    logger.info("Fetching weather for: '%s'", location)
    try:
        # 1) Geocode the place name to coordinates (keyless).
        geo = await _http_get_json(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1, "language": "en", "format": "json"},
        )
        matches = geo.get("results") or []
        if not matches:
            return f"I couldn't find a place called {location}. Could you say the city name again?"

        place = matches[0]
        lat, lon = place["latitude"], place["longitude"]
        name = place.get("name", location)
        country = place.get("country", "")
        where = f"{name}, {country}" if country else name

        # 2) Fetch current conditions for those coordinates (keyless).
        wx = await _http_get_json(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
            },
        )
        cur = wx.get("current", {})
        temp_c = cur.get("temperature_2m")
        feels_c = cur.get("apparent_temperature")
        humidity = cur.get("relative_humidity_2m")
        wind = cur.get("wind_speed_10m")
        desc = _WEATHER_CODES.get(cur.get("weather_code"), "unclear conditions")

        if temp_c is None:
            return f"I found {where} but couldn't read the current weather. Try again in a moment."

        temp_f = round(temp_c * 9 / 5 + 32)
        result = (
            f"In {where} it's currently {round(temp_c)} degrees Celsius "
            f"({temp_f} Fahrenheit) with {desc}."
        )
        if feels_c is not None and abs(feels_c - temp_c) >= 2:
            result += f" Feels like {round(feels_c)} Celsius."
        if humidity is not None:
            result += f" Humidity {round(humidity)} percent."
        if wind is not None:
            result += f" Wind {round(wind)} kilometers per hour."

        logger.info("Weather result: %s", result)
        return result
    except Exception as e:
        logger.error("Error fetching weather: %s", e, exc_info=True)
        return f"Sorry, I couldn't get the weather right now: {str(e)}"


@function_tool
async def get_crypto_price(coin: str) -> str:
    """Get the current US-dollar price of a cryptocurrency and its 24-hour change.
    Use this for crypto price questions instead of a web search.

    Args:
        coin: The cryptocurrency name or symbol, e.g. "Bitcoin", "BTC", or "Ethereum".
    """
    logger.info("Fetching crypto price for: '%s'", coin)
    try:
        # 1) Resolve the name/symbol to a CoinGecko coin id (keyless).
        search = await _http_get_json(
            "https://api.coingecko.com/api/v3/search",
            params={"query": coin},
        )
        coins = search.get("coins") or []
        if not coins:
            return f"I couldn't find a cryptocurrency called {coin}."

        top = coins[0]
        coin_id = top["id"]
        name = top.get("name", coin)
        symbol = (top.get("symbol") or "").upper()

        # 2) Fetch the current price and 24h change (keyless).
        price_data = await _http_get_json(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin_id, "vs_currencies": "usd", "include_24hr_change": "true"},
        )
        entry = price_data.get(coin_id)
        if not entry or entry.get("usd") is None:
            return f"I couldn't get a current price for {name} right now."

        price = entry["usd"]
        change = entry.get("usd_24h_change")
        price_str = f"{price:,.2f}" if price < 100 else f"{price:,.0f}"
        result = f"{name} ({symbol}) is trading at about {price_str} US dollars."
        if change is not None:
            direction = "up" if change >= 0 else "down"
            result += f" That's {direction} {abs(change):.1f} percent in the last 24 hours."

        logger.info("Crypto result: %s", result)
        return result
    except Exception as e:
        logger.error("Error fetching crypto price: %s", e, exc_info=True)
        return f"Sorry, I couldn't get that crypto price right now: {str(e)}"


# Google Sheet holding workout plans — one tab per person (the user + friends).
# Read-only via the public CSV export; shared "anyone with link can view". Overridable via env.
WORKOUT_SHEET_ID = os.getenv("WORKOUT_SHEET_ID", "1_MTl-ZH4k9S2dUiI5gbXH-m826jEoUKZ1GQQmqBltZU")


async def _discover_sheet_tabs(sheet_id: str):
    """Return [(tab_name, gid), ...] for every tab in the spreadsheet, parsed keylessly
    from the htmlview bootstrap. Falls back to the default first tab on any failure."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/htmlview"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10.0)) as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            html = await resp.text()
    tabs = []
    for block in re.findall(r"items\.push\((\{.*?\})\)", html):
        name_m = re.search(r'name:\s*"(.*?)"', block)
        gid_m = re.search(r'gid:\s*"(\d+)"', block)
        if name_m and gid_m:
            tabs.append((name_m.group(1), gid_m.group(1)))
    return tabs or [("Sheet1", "0")]


async def _fetch_tab_rows(sheet_id: str, gid: str):
    """Fetch one tab as parsed CSV rows."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&gid={gid}"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10.0)) as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            text = await resp.text()
    return list(csv.reader(io.StringIO(text)))


@function_tool
async def get_workout_plan(person: str = "", day: str = "", body_part: str = "") -> str:
    """Look up workout plans from the user's Google Sheet. The sheet has one tab per person —
    the user and their friends — so this can compare people's training and lifts. Use it for
    any question about workouts, exercises, sets, reps, weights, or who is strongest at something.

    Args:
        person: Optional. A person's name to limit to (e.g. "Karthikeya"). Empty = everyone.
        day: Optional. A training day to filter to, e.g. "Day 1".
        body_part: Optional. A muscle-group keyword to filter exercises, e.g. "chest" or "back".
    """
    logger.info("Reading workout plan (person='%s', day='%s', body_part='%s')",
                person or "<all>", day or "<all>", body_part or "<all>")
    try:
        tabs = await _discover_sheet_tabs(WORKOUT_SHEET_ID)

        # Select which people's tabs to read.
        if person:
            needle = person.strip().lower()
            selected = [(n, g) for (n, g) in tabs if needle in n.lower()]
            if not selected:
                names = ", ".join(n for n, _ in tabs)
                return f"I couldn't find anyone called '{person}'. The people in the sheet are: {names}."
        else:
            selected = tabs

        day_needle = day.strip().lower() if day else ""
        bp_needle = body_part.strip().lower() if body_part else ""

        sections = []
        for name, gid in selected:
            try:
                rows = await _fetch_tab_rows(WORKOUT_SHEET_ID, gid)
            except Exception as tab_err:
                logger.warning("Could not read tab '%s' (gid %s): %s", name, gid, tab_err)
                continue
            if not rows or len(rows) < 2:
                continue

            header = [h.strip() for h in rows[0]]
            lines = []
            for r in rows[1:]:
                cells = [c.strip() for c in r]
                if not any(cells):
                    continue
                if day_needle and not (cells and day_needle in cells[0].lower()):
                    continue
                if bp_needle and bp_needle not in " ".join(cells).lower():
                    continue
                pairs = [
                    f"{header[i]}: {cells[i]}"
                    for i in range(min(len(header), len(cells)))
                    if cells[i]
                ]
                if pairs:
                    lines.append(", ".join(pairs))
            if lines:
                sections.append(f"=== {name} ===\n" + "\n".join(lines))

        if not sections:
            filt = body_part or day or "that"
            return f"I couldn't find any '{filt}' entries in the workout sheet."

        people_count = len(sections)
        result = (
            f"Workout plans from the user's Google Sheet ({people_count} "
            f"{'person' if people_count == 1 else 'people'}). "
            f"Weights are the proof for strength comparisons.\n\n" + "\n\n".join(sections)
        )
        logger.info("Workout plan: returned %d section(s)", people_count)
        return result
    except Exception as e:
        logger.error("Error reading workout sheet: %s", e, exc_info=True)
        return f"Sorry, I couldn't read the workout sheet right now: {str(e)}"


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

    # TTS is Kokoro (running on GPU). Edge-TTS has been removed. Map the UI's voice
    # names to Kokoro voices.
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

    # Anchor the model to the real current date. Without this it falls back to its
    # training-era default year (e.g. answering 2026 questions with 2023 facts).
    now = datetime.now(timezone.utc)
    current_date = now.strftime("%A, %B %d, %Y")
    current_year = now.strftime("%Y")

    instructions = f"""Today's date is {current_date}. Treat this as the present — never assume it is an earlier year.

You are Kay, a warm and helpful voice assistant having a spoken, real-time conversation.

WHO YOU'RE TALKING TO
- The person you're speaking with is Karthikeya. When they say "my", "me", or "I" about workouts or lifts, use Karthikeya's tab in the workout sheet (person="Karthikeya").

YOUR NAME
- Always write your name as "Kay" (only the K capitalized), never "KAY", so the text-to-speech engine pronounces it as a word instead of spelling it out.

HOW YOU TALK — your replies are read aloud, so speak, don't write a document:
- Keep replies short: usually one to three sentences. Lead with the answer first.
- Never use markdown, numbered lists, bullet points, headings, asterisks, emoji, or code blocks — they sound broken when spoken. If you must list a few things, say them in a flowing sentence ("first..., then..., and finally...").
- Use plain, easy-to-pronounce words. Speak symbols out ("percent", "dollars", "and").
- When there's more to say, give the short version and offer to go deeper, e.g. "want the details?".

YOUR TOOLS — prefer the specific tool over a generic search:
- get_weather: current conditions for any city. Use it for any weather question.
- get_crypto_price: live US-dollar price and 24-hour change for a cryptocurrency.
- get_workout_plan: workout routines from the user's Google Sheet, which has one tab per person (the user and their friends). Use it for any question about workouts, training, lifts, or comparing people — e.g. who is strongest at a lift. Cite the weights from the sheet as your proof, and only name people and numbers that actually appear in the data.
- web_search: anything else that can change — news, recent events, sports, or facts about specific people, products, or companies, and any "latest", "today", or "right now" question.
- When a question needs more than one tool, use them together in the same turn before answering — for example, read the workout sheet to get a number, then web_search to compare it. Don't stop after one tool if the question isn't fully answered yet.

USING THE WEB:
- Write search queries in natural, present-tense terms. Do NOT put a year in the query unless the user asked about a specific past year; if you need the year, it is {current_year}.
- Base time-sensitive answers on what the tool returns, not on memory. If results look stale or conflict with today's date, search again with a better query rather than repeating old information.

CONVERSATION STYLE:
- Never reply with empty filler like "Sure!" or "Okay!" on its own. Either answer, begin the task, or ask one quick clarifying question if the request is genuinely unclear.
- Be direct and friendly. Don't over-apologize or pile on praise — a brief "good catch" is enough, then move on."""

    agent = Agent(
        instructions=instructions,
        vad=ctx.proc.userdata["vad"],
        stt=stt_instance,
        llm=llm_instance,
        tts=tts_instance,
        chat_ctx=chat_ctx,
        tools=[web_search, get_weather, get_crypto_price, get_workout_plan],
        # Edge-TTS / Kokoro do not return word-aligned transcripts, so leaving this on
        # logged a warning on every turn AND left the agent transcript empty — which made
        # the UI's "Speaking" status fall back to "Synthesizing voice...". Disabling it lets
        # LiveKit forward the LLM text as the transcript, populating the live status correctly.
        use_tts_aligned_transcript=False,
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
        if isinstance(item, llm.ChatMessage) and item.content:
            # Safely serialize content to a single string (skip raw bytes like AudioContent.content)
            content_str = (item.text_content or "").strip()
            if not content_str:
                return

            # Map role: 'assistant' to 'assistant', and anything else to 'user'
            role = 'assistant' if item.role in ('assistant', 'agent') else 'user'

            # N1: Decoupled message broadcasting to keep UI active even if the DB is down
            try:
                payload = json.dumps({"sender": role, "text": content_str})
                await ctx.room.local_participant.send_text(payload, topic='lk.chat')
                logger.info("Published %s chat message: %s", role, payload)
            except Exception as ex:
                logger.error("Error publishing %s chat message: %s", role, ex)

            # M15 & M1: Await database save in event handler to preserve order.
            # Persistence only runs when the pool AND conversation row exist; the
            # broadcast above is independent so the live transcript never blocks on the DB.
            run_title_generation = False
            db_msgs = []
            if pool and db_conv_id:
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
