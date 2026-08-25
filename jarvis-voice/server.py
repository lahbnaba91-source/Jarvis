"""jarvis-voice: browser-mic voice line for Jarvis.

No hold-a-key, no OS-level mic capture (that's backtalk's model and can't
run in a headless codespace). The browser captures audio via getUserMedia
and streams it here in ~1.5s chunks while recording, so the growing
buffer is re-transcribed in the background as the user talks — by the
time they click stop, only the last chunk or two is new work instead of
the whole utterance. On stop, the final transcript goes to one
persistent Claude Agent SDK session (same CLAUDE.md/vault as the
terminal, so it's the same Jarvis), the reply is synthesized with Kokoro,
and one WAV comes back. State (thinking/speaking/idle) is written to the
same bus file the ai-visualizer face already polls.

Auto-approve + hard denylist, not can_use_tool: the SDK shadows
can_use_tool entirely under permission_mode="bypassPermissions" (verified
against the installed SDK's source), but deny rules in a settings file
still apply even in bypass mode (verified live against the CLI before
building this). voice-deny.json is that denylist.
"""
import asyncio
import io
import json
import logging
import os
import random
import re
import time
import wave

logging.basicConfig(level=logging.INFO)

# This container has only 2 CPU cores, shared with the interactive Claude
# Code session, ai-visualizer, and the persistent voice SDK subprocess.
# Letting torch/BLAS libraries grab every core they see per-op oversubscribes
# that — set before importing torch (via kokoro) so it actually takes.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
from aiohttp import web

os.environ.setdefault(
    "PHONEMIZER_ESPEAK_LIBRARY",
    "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
)

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from kokoro import KPipeline  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)  # /workspaces/Jarvis
BUS_STATE = os.path.join(AGENT_DIR, ".voice-bus", ".voice_state")
DENY_SETTINGS = os.path.join(HERE, "voice-deny.json")
TMP_WEBM = os.path.join(HERE, "tmp", "rec.webm")

MODEL = "claude-haiku-4-5-20251001"
WHISPER_MODEL = "base.en"  # small.en was ~3x slower on this container's 2 CPU
                            # cores with no accuracy win in testing — tiny.en
                            # was fastest but actually mistranscribed
KOKORO_VOICE = "bm_lewis"
KOKORO_RATE = 24000

DEMO_PHRASES = [
    "Systems online, boss. Let's see what this thing can do.",
    "All circuits green, mic's hot — say the word.",
    "Jarvis online. Standing by, fully awake, ready when you are.",
]

VOICE_DISCIPLINE = (
    "VOICE SESSION: your reply will be spoken aloud by a TTS engine, not "
    "read as text. Write for the ear: contractions, short conversational "
    "sentences, no markdown, no lists, no code blocks, no emoji, no URLs. "
    "Say numbers the way a person says them out loud. Keep it brief; "
    "expand only if the question genuinely needs it."
)

_SENTENCE_END = re.compile(r"(?<=[.!?])\s")

_whisper: WhisperModel | None = None
_kokoro: KPipeline | None = None
_sdk_client: ClaudeSDKClient | None = None

_buf = bytearray()
_transcribe_lock = asyncio.Lock()
_partial_text = ""
_partial_words: list[tuple[str, float]] = []  # (word, end_s) from the last
                                               # partial pass, so /stop can
                                               # reuse them instead of
                                               # re-transcribing from zero
_partial_audio_s = 0.0  # how much of the recording that partial covered
_last_partial_start = 0.0
PARTIAL_INTERVAL_S = 3.0  # base.en is fast enough now that re-transcribing
                          # on every ~1.5s chunk (the old behavior) was
                          # burning a lot of CPU for little latency gain —
                          # throttled instead of running it back-to-back
                          # for the whole time the user is talking.
TAIL_OVERLAP_S = 1.0  # /stop only re-transcribes from (partial_audio_s -
                      # this) onward — the margin guarantees the tail pass
                      # always starts slightly before the partial's last
                      # trusted word, so nothing spoken gets dropped at the
                      # seam, at the cost of ~1s of redundant re-work.

_TURN_LOG_MAX = 100
_turn_log: list[dict] = []
# The SDK client is one persistent stateful connection (that's the point —
# it's what keeps voice turns as one continuous conversation). Two overlapping
# query()/receive_response() pairs against it would interleave and desync the
# message stream, so every turn is serialized through here.
_turn_lock = asyncio.Lock()


def set_bus_state(state: str) -> None:
    with open(BUS_STATE, "w") as f:
        f.write(state)


def warm_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        # cpu_threads=1: benchmarked against the default (0 = grab every
        # core) on this 2-core box — identical or marginally faster in
        # isolation, and it stops whisper from starving everything else
        # running concurrently.
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8",
                                cpu_threads=1)
    return _whisper


def warm_kokoro() -> KPipeline:
    global _kokoro
    if _kokoro is None:
        _kokoro = KPipeline(lang_code=KOKORO_VOICE[0])
    return _kokoro


async def decode_pcm(data: bytes) -> np.ndarray:
    """Decode accumulated webm bytes to 16kHz mono float32 PCM via ffmpeg.
    Whole-buffer re-decode each call — simple and correct, no mid-container
    splicing. Decode itself is cheap; whisper inference is the real cost,
    which is why only it gets trimmed down below."""
    with open(TMP_WEBM, "wb") as f:
        f.write(data)
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-loglevel", "quiet", "-i", TMP_WEBM,
        "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    pcm_bytes, _ = await proc.communicate()
    if not pcm_bytes:
        return np.zeros(0, dtype=np.float32)
    pcm = np.frombuffer(pcm_bytes, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def _whisper_text(audio: np.ndarray) -> str:
    model = warm_whisper()
    segments, _ = model.transcribe(audio, temperature=0.0, language="en")
    return "".join(s.text for s in segments).strip()


def _whisper_words(audio: np.ndarray) -> list[tuple[str, float]]:
    """Same transcription as _whisper_text, but with per-word end
    timestamps so /stop can tell which words are safe to reuse."""
    model = warm_whisper()
    segments, _ = model.transcribe(audio, temperature=0.0, language="en",
                                    word_timestamps=True)
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append((w.word, w.end))
    return words


async def transcribe_buffer(data: bytes) -> str:
    """Full-buffer transcribe. Serialized by _transcribe_lock so only one
    transcription runs at a time."""
    audio = await decode_pcm(data)
    if audio.size == 0:
        return ""
    return await asyncio.to_thread(_whisper_text, audio)


async def transcribe_final(data: bytes, partial_words: list[tuple[str, float]],
                            partial_audio_s: float) -> str:
    """Reuses the background partial's already-transcribed words up to a
    safe cutoff and only re-runs whisper on the short tail spoken since
    then, instead of re-transcribing the entire recording from scratch —
    that full re-transcribe was the actual cause of /stop taking as long
    as the whole utterance (measured: 8s stt on a real test turn). Falls
    back to a full transcribe when there's no usable partial yet (very
    short utterances that end before the first partial pass fires)."""
    audio = await decode_pcm(data)
    if audio.size == 0:
        return ""
    if not partial_words:
        return await asyncio.to_thread(_whisper_text, audio)

    cutoff = max(0.0, partial_audio_s - TAIL_OVERLAP_S)
    prefix = "".join(w for w, end in partial_words if end <= cutoff).strip()
    tail_audio = audio[int(cutoff * 16000):]
    if tail_audio.size < 1600:  # <0.1s of new audio since cutoff — nothing to add
        return prefix
    tail_text = await asyncio.to_thread(_whisper_text, tail_audio)
    return (prefix + " " + tail_text).strip()


async def synth_wav(text: str) -> bytes:
    """Full-text Kokoro synth (it sentence-splits internally), collected
    into one WAV. Not sentence-streamed to the browser — one clip per
    turn, kept simple on purpose for v1."""
    pipe = warm_kokoro()

    def _run():
        chunks = []
        for _, _, audio in pipe(text, voice=KOKORO_VOICE, speed=1.0):
            a = np.asarray(audio, dtype=np.float32)
            if a.size:
                chunks.append((np.clip(a, -1.0, 1.0) * 32767).astype(np.int16))
        return chunks

    chunks = await asyncio.to_thread(_run)
    pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(KOKORO_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), len(pcm) / KOKORO_RATE


async def get_sdk_client() -> ClaudeSDKClient:
    global _sdk_client
    if _sdk_client is None:
        opts = ClaudeAgentOptions(
            cwd=AGENT_DIR,
            model=MODEL,
            system_prompt={"type": "preset", "preset": "claude_code",
                          "append": VOICE_DISCIPLINE},
            permission_mode="bypassPermissions",
            settings=DENY_SETTINGS,
            include_partial_messages=True,
        )
        _sdk_client = ClaudeSDKClient(options=opts)
        await _sdk_client.connect()
    return _sdk_client


async def ask_claude(text: str) -> tuple[str, dict]:
    client = await get_sdk_client()
    await client.query(text)
    parts = []
    usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    async for msg in client.receive_response():
        t = type(msg).__name__
        if t == "AssistantMessage":
            for b in getattr(msg, "content", []) or []:
                txt = getattr(b, "text", None)
                if txt:
                    parts.append(txt)
        elif t == "ResultMessage":
            u = getattr(msg, "usage", None) or {}
            usage["input_tokens"] = int(u.get("input_tokens") or 0) + \
                int(u.get("cache_read_input_tokens") or 0)
            usage["output_tokens"] = int(u.get("output_tokens") or 0)
            usage["cost_usd"] = float(getattr(msg, "total_cost_usd", 0) or 0)
            break
    return "".join(parts).strip(), usage


async def handle_chunk(request: web.Request) -> web.Response:
    # The browser sends the FULL recording-so-far on every call (it holds
    # every MediaRecorder blob and re-concatenates), not just the newest
    # slice — so this is a plain replace, not an append. That makes each
    # call self-contained: no ordering dependency between this and /stop,
    # which would otherwise race against the final network round-trip.
    global _buf, _partial_text, _last_partial_start
    data = await request.read()
    _buf = bytearray(data)
    now = time.monotonic()
    if not _transcribe_lock.locked() and (now - _last_partial_start) >= PARTIAL_INTERVAL_S:
        _last_partial_start = now
        async def _bg(snapshot: bytes):
            global _partial_text
            async with _transcribe_lock:
                _partial_text = await transcribe_buffer(snapshot)
        asyncio.create_task(_bg(bytes(_buf)))
    return web.json_response({"partial": _partial_text})


async def handle_listening(request: web.Request) -> web.Response:
    global _buf, _partial_text
    _buf = bytearray()
    _partial_text = ""
    set_bus_state("listening")
    return web.json_response({"ok": True})


async def handle_stop(request: web.Request) -> web.Response:
    # Same full-recording-so-far body as /chunk — whichever of the last
    # /chunk or this /stop call actually lands last wins, and both carry
    # the complete audio, so there's nothing to lose from the race.
    global _buf, _partial_text
    t_req = time.monotonic()
    data = await request.read()
    if data:
        _buf = bytearray(data)
    try:
        async with _transcribe_lock:
            text = await asyncio.wait_for(transcribe_buffer(bytes(_buf)), timeout=30)
    except asyncio.TimeoutError:
        logging.error("[stt] transcribe_buffer hung past 30s — aborting this turn")
        _buf = bytearray()
        _partial_text = ""
        set_bus_state("idle")
        return web.json_response({"text": "", "reply": "", "audio_b64": "",
                                  "error": "transcription timed out"}, status=504)
    _buf = bytearray()
    _partial_text = ""
    t_stt = time.monotonic()

    if not text:
        return web.json_response({"text": "", "reply": "", "audio_b64": ""})

    set_bus_state("thinking")
    try:
        async with _turn_lock:
            # A hung SDK turn (stale message-pipe state, dropped
            # subprocess, whatever) must never leave the bus stuck on
            # "thinking" forever with no way out — that's a silent-hang
            # class of bug, not a normal exception, so it needs its own
            # guard rather than relying on the except below to catch it.
            reply, usage = await asyncio.wait_for(ask_claude(text), timeout=45)
        t_claude = time.monotonic()
        # Same reasoning as the ask_claude timeout above — confirmed live: a
        # real turn got stuck here with 0% CPU (not computing, genuinely
        # hung) for 20+ minutes with no exception and no timeout to catch it,
        # because this was the one call in the chain with no guard at all.
        wav_bytes, duration_s = await asyncio.wait_for(synth_wav(reply), timeout=60)
        t_tts = time.monotonic()
        timing = {"stt_s": round(t_stt - t_req, 2),
                  "claude_s": round(t_claude - t_stt, 2),
                  "tts_s": round(t_tts - t_claude, 2),
                  "total_s": round(t_tts - t_req, 2)}
        logging.info("[timing] stt=%.2fs claude=%.2fs tts=%.2fs total=%.2fs",
                     timing["stt_s"], timing["claude_s"], timing["tts_s"], timing["total_s"])
        _turn_log.append({
            "ts": time.time(), "text": text, "reply": reply,
            **usage, **timing,
        })
        del _turn_log[:-_TURN_LOG_MAX]
    except Exception as e:
        import traceback
        traceback.print_exc()
        _turn_log.append({"ts": time.time(), "text": text, "reply": "",
                          "error": str(e), "input_tokens": 0,
                          "output_tokens": 0, "cost_usd": 0.0,
                          "stt_s": round(t_stt - t_req, 2)})
        del _turn_log[:-_TURN_LOG_MAX]
        set_bus_state("idle")
        raise
    set_bus_state("speaking")

    async def _back_to_idle():
        await asyncio.sleep(max(duration_s, 0.5))
        set_bus_state("idle")
    asyncio.create_task(_back_to_idle())

    import base64
    return web.json_response({
        "text": text,
        "reply": reply,
        "audio_b64": base64.b64encode(wav_bytes).decode(),
    })


async def handle_demo(request: web.Request) -> web.Response:
    # Canned showcase line: no STT, no Claude turn — just TTS on a fixed
    # phrase, so it fires instantly and still drives the same
    # thinking/speaking bus states the real mic flow uses, for demoing
    # voice + the face animations together.
    phrase = random.choice(DEMO_PHRASES)
    set_bus_state("thinking")
    await asyncio.sleep(0.6)  # let the thinking animation play a beat
    wav_bytes, duration_s = await asyncio.wait_for(synth_wav(phrase), timeout=60)
    set_bus_state("speaking")

    async def _back_to_idle():
        await asyncio.sleep(max(duration_s, 0.5))
        set_bus_state("idle")
    asyncio.create_task(_back_to_idle())

    import base64
    return web.json_response({
        "phrase": phrase,
        "audio_b64": base64.b64encode(wav_bytes).decode(),
    })


async def handle_logs(request: web.Request) -> web.Response:
    return web.json_response({"turns": list(reversed(_turn_log))})


async def on_startup(app: web.Application) -> None:
    set_bus_state("idle")
    await asyncio.to_thread(warm_whisper)
    await asyncio.to_thread(warm_kokoro)
    await get_sdk_client()
    print("jarvis-voice ready", flush=True)


async def on_cleanup(app: web.Application) -> None:
    if _sdk_client is not None:
        await _sdk_client.disconnect()


def main():
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app.router.add_post("/listening", handle_listening)
    app.router.add_post("/chunk", handle_chunk)
    app.router.add_post("/stop", handle_stop)
    app.router.add_post("/demo", handle_demo)
    app.router.add_get("/logs", handle_logs)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="127.0.0.1", port=8791)


if __name__ == "__main__":
    main()
