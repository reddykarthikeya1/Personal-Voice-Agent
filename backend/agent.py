import os
import logging

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
    )

    # Start session - don't close on disconnect
    session = AgentSession()

    @session.on("user_input_transcribed")
    def on_user_input(event) -> None:
        logger.info(f"--- USER INPUT TRANSCRIBED: '{event.transcript}' (is_final={event.is_final})")

    @session.on("agent_state_changed")
    def on_agent_state(event) -> None:
        logger.info(f"--- AGENT STATE CHANGED: {event.old_state} -> {event.new_state}")

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
