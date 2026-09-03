#!/usr/bin/env python3
# barehands: move things on your screen with your bare hands.
# Copyright (C) 2026 Jared Rhodenizer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
"""barehands server — serves the hand-tracked air-board on localhost.

localhost = a secure context, which is what lets the browser open your
camera for the tracker page. Nothing here ever leaves your machine.

Endpoints:
  GET  /stage.html, /media/*   the pages + the media airlock
  POST /state                  tracker's ~45Hz scene heartbeat; the response
                               carries queued commands (the command channel)
  GET  /state                  the render page mirrors the scene from here
  POST /cmd                    board commands (your AI -> the board)
  POST /light/toggle           flip the Hubspace lamp, {"name","on","elapsed_s"}
  POST /light/green            set the lamp to green @ 100% brightness, same shape
  POST /light/white            set the lamp to white, 3600K, 100% brightness, same shape
  POST /light/set               {"r","g","b","brightness"} — arbitrary color, same shape
  GET  /light/status           full lamp state: name, on, r/g/b, brightness,
                               color_mode, color_temp_k, elapsed_s
  GET  /spotify/login          one-time browser login -> Spotify consent screen
  GET  /spotify/callback       OAuth redirect target, caches the refresh token
  POST /spotify/play           start SPOTIFY_TRACK on the active device
  POST /spotify/pause          pause playback on the active device
  POST /spotify/resume         resume playback (un-shush)
  GET  /spotify/status         {"authed": bool}
  GET  /spotify/progress       {"is_playing", "progress_ms", "item"}
  POST /show/start             play SHOW_CUES_PATH in sync with live playback
  POST /show/stop              cancel the running light show, if any
  GET  /config                 the barehands.json config (name + orbs + gestures)
  POST /config                 {"gestures": {...}} -- persists gesture settings
                               (toggles + tuned thresholds) into barehands.json
  GET  /tree?orb=N             a notes orb's folder tree — read-only, JAILED
  GET  /note?f=N/<rel>         one note's text — read-only, JAILED
  GET  /props                  the media airlock as a browsable tree
  GET  /orb                    your assistant's live state (the ring reads it)
  POST /cam/pin                stage.html: mint a pairing PIN + session_id
  POST /cam/pair               cam.html: redeem a PIN for its session_id
  POST /cam/frame               cam.html: upload the latest JPEG frame
  GET  /cam/frame               stage.html: pull the latest JPEG frame

Config lives in barehands.json next to this file:
  { "name": "Assistant", "port": 8794,
    "orbs": [ { "title": "Notes", "path": "sample-notes", "kind": "notes" },
              { "title": "Props", "path": "media",        "kind": "media" } ] }

"notes" orbs may point at ANY folder of markdown (an Obsidian vault is
just a folder of markdown). The "media" orb may point anywhere too, so
your props can stay where they already live; a relative path resolves
against the repo. Wherever it points is the airlock — the only place
images/models ever stage from.

Your AI drives the ring by writing tiny files into ./state/ :
  state/state      one word: idle | listening | thinking | speaking
  state/mood.json  {"mood": "green"|"amber"|"red", "ts": <unix time>}
  state/wave.json  {"samples": [0..1 x 64], "ts": <unix time>}
Missing files are fine — the ring just idles.
"""
import json
import secrets
import subprocess
import threading
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Hubspace lamp control lives outside this vendored tree (its own venv,
# its own gitignored cached session) -- see scripts/hubspace/hubspace_light.py.
HUBSPACE_PY = HERE.parent / "scripts" / "hubspace" / ".venv" / "bin" / "python3"
HUBSPACE_SCRIPT = HERE.parent / "scripts" / "hubspace" / "hubspace_light.py"

# Spotify playback control -- system python3 (its only dependency,
# `requests`, is already on the system interpreter, so no venv needed)
# -- see scripts/spotify/spotify_play.py.
SPOTIFY_SCRIPT = HERE.parent / "scripts" / "spotify" / "spotify_play.py"
SPOTIFY_CREDS = HERE.parent / "scripts" / "spotify" / ".state" / "creds.json"
SPOTIFY_REDIRECT = "https://jubilant-goldfish-5vxr5wvgqjjr2976-8794.app.github.dev/spotify/callback"
SPOTIFY_SCOPES = "user-modify-playback-state user-read-playback-state"
SPOTIFY_TRACK = "spotify:track:6GzCkTddOn1vSln1gbSr8y"   # the rock-on track

# Light-show cue playback -- see scripts/lightshow/analyze_track.py, which
# offline-analyzes a real audio file into a millisecond-precise cue sheet.
# This thread plays that sheet back in sync with the ACTUAL live playback
# position (polled from Spotify, not assumed), firing each cue's
# already-latency-compensated fire_at_ms.
SHOW_CUES_PATH = HERE.parent / "scripts" / "lightshow" / "cues" / "shoot_to_thrill.json"
_show_thread = None
_show_stop_event = None   # the CURRENT session's own Event -- see start_show()

# LATENCY CALIBRATION: every fired cue logs its own real cloud round-trip
# (the API's own elapsed_s -- no chat/human-reaction noise). Grouped by
# session (one gesture-triggered show = one session); once 5 sessions
# have data, the per-session averages are themselves averaged into a
# calibrated LATENCY_MS and locked into calibration.json. analyze_track.py
# reads that file (falling back to its 800ms default until it exists), so
# regenerating the cue sheet after that picks up the real measured number.
SHOW_LATENCY_LOG = HERE.parent / "scripts" / "lightshow" / "state" / "latency_log.jsonl"
SHOW_CALIBRATION_PATH = HERE.parent / "scripts" / "lightshow" / "state" / "calibration.json"
_latency_log_lock = threading.Lock()

# GESTURE RECORDER: the stage's RECORD button POSTs one entry per take —
# two hand-landmark snapshots of the same held pose, 2s apart — appended
# here for the AI to read and derive/refine gesture thresholds from.
GESTURE_LOG = HERE / "state" / "gesture_log.jsonl"
_gesture_log_lock = threading.Lock()

# GESTURE SETTINGS: the values this whole file's tuning history landed
# on, exposed as adjustable defaults instead of buried constants in
# stage.html. These exact numbers match what shipped before this
# settings panel existed (2026-08-27) -- installing it changes nothing
# until someone actually opens the panel and moves a slider.
DEFAULT_GESTURES = {
    "rockOn": True,          # horns sign -> Spotify + light show
    "fingerGun": True,       # dun-dun pose -> SVU sting
    "peaceSign": True,       # double peace sign -> "Yeah!"
    "shush": True,           # finger on lips (face-gated) -> pause Spotify
    "rps": True,             # rock/paper/scissors throw -> play vs Jarvis
    "pileDeck": True,        # 3+ open folders/tabs -> pile; pinch-sweep pages
    "rotateDragCancelPx": 800,  # px of drag since the hold started that
                             # cancels the 3D-rotate latch -- replaces the
                             # old position-based (corner/bar-only) gate:
                             # 2026-08-27, Luis's ask, any grab point now
                             # arms the latch, this just tells "held it
                             # still to rotate" apart from "actually
                             # dragging it around"
    "rotateLatchMs": 2000,   # ms of held-still before rotate mode latches
    "fingerGunCurl": 0.92,   # wrist-ratio ceiling for the dun-dun pose's
                             # tight-fist fingers (mid-canyon cut between
                             # the charge pose's 1.16 floor and a real
                             # recorded dun-dun take's 0.57-0.67)
}
_config_lock = threading.Lock()

# THE MEDIA AIRLOCK: the only folder the board can ever stage files from
# (see /cmd's own jail check and /props below). Resolved from the Props
# orb's `path` after CONFIG loads — see _media_root() below.
MEDIA_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".webm",
              ".glb", ".gltf", ".svg"}

# REMOTE CAMERA PAIRING: a second phone (cam.html, camera-only page) can
# stand in as the tracker's camera. stage.html mints a one-time PIN
# (/cam/pin); cam.html redeems it (/cam/pair) to get the session_id, then
# just POSTs a JPEG frame to /cam/frame roughly 15x/sec; stage.html GETs
# the latest one at the same rate. Luis's call (2026-08-26): this used to
# be a direct WebRTC connection between the two phones (this server only
# relayed the SDP/ICE handshake), which needed STUN/TURN to get through
# NAT and only worked some of the time depending on network conditions.
# Routing the actual frames through this server instead sidesteps NAT
# traversal entirely -- both phones already reach this server reliably
# over the same forwarded HTTPS tunnel that serves stage.html/cam.html in
# the first place. Costs a small extra hop of latency versus true P2P;
# buys a connection that works the same way every time.
_CAM_LOCK = threading.Lock()
_CAM_PINS = {}       # pin -> {"session_id", "created"}
_CAM_SESSIONS = {}   # session_id -> {"created", "frame": bytes|None, "frame_ts"}
_CAM_PIN_TTL = 300      # a minted PIN dies unredeemed after this long
_CAM_SESSION_TTL = 3600  # a session with no fresh frame is forgotten after this long


def _cam_sweep_locked():
    """Drop expired pins/sessions. Caller holds _CAM_LOCK."""
    now = time.time()
    for pin, e in list(_CAM_PINS.items()):
        if now - e["created"] > _CAM_PIN_TTL:
            del _CAM_PINS[pin]
    for sid, s in list(_CAM_SESSIONS.items()):
        # a live stream keeps renewing frame_ts every ~66ms, so this only
        # ever catches a session that either never got a first frame or
        # whose phone actually went quiet -- never one mid-use.
        if now - (s["frame_ts"] or s["created"]) > _CAM_SESSION_TTL:
            del _CAM_SESSIONS[sid]


def _cam_log(msg):
    # log_message() below is silenced for the whole server (noisy at 45Hz
    # from the tracker heartbeat) -- pairing/signaling is rare and exactly
    # what needs to be visible while debugging a real phone-to-phone
    # connection live, so it gets its own always-on line to stdout.
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _show_fire_and_log(session_id, r, g, b, brightness):
    result, _ = hubspace_call("set", str(r), str(g), str(b), str(brightness))
    elapsed_s = result.get("elapsed_s")
    if elapsed_s is None:
        return
    SHOW_LATENCY_LOG.parent.mkdir(exist_ok=True)
    with _latency_log_lock:
        with open(SHOW_LATENCY_LOG, "a") as f:
            f.write(json.dumps({"session": session_id, "ts": time.time(),
                                 "elapsed_s": elapsed_s}) + "\n")
    _show_maybe_calibrate()


def _show_maybe_calibrate():
    if SHOW_CALIBRATION_PATH.is_file():
        return   # already locked in -- delete the file to re-calibrate
    try:
        lines = SHOW_LATENCY_LOG.read_text().splitlines()
    except Exception:
        return
    by_session = {}
    for line in lines:
        try:
            rec = json.loads(line)
            by_session.setdefault(rec["session"], []).append(rec["elapsed_s"])
        except Exception:
            continue
    if len(by_session) < 5:
        return
    session_avgs = [sum(v) / len(v) for v in by_session.values()]
    latency_ms = round(sum(session_avgs) / len(session_avgs) * 1000)
    SHOW_CALIBRATION_PATH.parent.mkdir(exist_ok=True)
    SHOW_CALIBRATION_PATH.write_text(json.dumps({
        "latency_ms": latency_ms, "n_sessions": len(by_session),
        "session_avgs_s": [round(a, 3) for a in session_avgs],
        "calibrated_at": time.time(),
    }, indent=2))


def _show_run(cues_path, stop_event, session_id):
    try:
        data = json.loads(Path(cues_path).read_text())
    except Exception:
        return
    cues = sorted(data.get("cues", []), key=lambda c: c["fire_at_ms"])
    duration_ms = data.get("duration_s", 0) * 1000

    # snapshot the lamp exactly as it was BEFORE the show touches it, so
    # whatever ends this session (song ends, gets paused, re-triggered,
    # manually stopped) can put it back exactly how it was -- restore
    # lives in `finally` below so every exit path below hits it.
    # Double-read: Afero's cloud can serve a just-stale cached read right
    # after a very recent command elsewhere hasn't fully settled yet; a
    # second read ~1s later reliably has the real current state.
    hubspace_call("get")
    time.sleep(1)
    snapshot, snap_code = hubspace_call("get")

    real_stop = False
    try:
        # sync anchor: poll real progress_ms, retrying briefly since the
        # Echo Dot can take a couple seconds to actually start after play
        anchor_progress_ms, anchor_t = None, None
        for _ in range(10):
            if stop_event.is_set():
                return
            result, code = spotify_call("progress")
            if code == 200 and result.get("is_playing") and result.get("progress_ms") is not None:
                anchor_progress_ms = result["progress_ms"]
                anchor_t = time.monotonic()
                break
            stop_event.wait(0.5)
        if anchor_progress_ms is None:
            return   # never started playing -- nothing to sync to

        def estimated_progress_ms():
            return anchor_progress_ms + (time.monotonic() - anchor_t) * 1000

        last_resync = time.monotonic()
        stagnant_polls = 0

        def resync():
            # REAL-STOP DETECTION (2026-08-25, Luis's ask): is_playing was
            # already tried and abandoned as a stop signal here -- confirmed
            # live to stay true 60+s after a real stop on this Alexa/
            # Spotify Connect setup (see the STOP gesture's own comment in
            # stage.html). progress_ms is a more honest signal: if the
            # track is really still playing, it advances roughly in step
            # with real elapsed time; if playback actually stopped, the
            # reported position freezes even while is_playing keeps lying.
            # Two consecutive frozen reads (~6s) required before acting,
            # so one noisy poll can't false-trigger it. Returns True the
            # moment a real stop is confirmed -- caller returns immediately.
            nonlocal anchor_progress_ms, anchor_t, stagnant_polls, real_stop
            result, code = spotify_call("progress")
            if code != 200 or result.get("progress_ms") is None:
                return False   # a failed poll is not a stop signal either way
            new_progress_ms = result["progress_ms"]
            elapsed_ms = (time.monotonic() - anchor_t) * 1000
            advanced_ms = new_progress_ms - anchor_progress_ms
            if elapsed_ms > 500 and advanced_ms < elapsed_ms * 0.5:
                stagnant_polls += 1
            else:
                stagnant_polls = 0
            anchor_progress_ms, anchor_t = new_progress_ms, time.monotonic()
            if stagnant_polls >= 2:
                real_stop = True
                return True
            return False

        for cue in cues:
            if stop_event.is_set():
                return
            if cue["fire_at_ms"] < estimated_progress_ms():
                continue   # already past this one (started mid-track / fell behind)
            while True:
                if stop_event.is_set():
                    return
                now_ms = estimated_progress_ms()
                if now_ms >= duration_ms:
                    # the track reached its own known length -- a real
                    # stop just as much as detected stagnation is
                    real_stop = True
                    return
                remaining_s = (cue["fire_at_ms"] - now_ms) / 1000
                if remaining_s <= 0:
                    break
                stop_event.wait(min(remaining_s, 0.2))
                # periodic resync corrects drift from seeks/network hiccups,
                # and also catches a real stop -- see resync() above.
                if time.monotonic() - last_resync > 3:
                    last_resync = time.monotonic()
                    if resync():
                        return
            # fire-and-forget: hubspace_call blocks ~0.8s on its own cloud
            # round-trip -- running it inline here ate into the NEXT cue's
            # timing budget every single fire, compounding into multi-
            # second drift over a few dozen cues. A thread keeps the
            # scheduler's own clock accurate no matter how long the bulb
            # takes to answer.
            threading.Thread(
                target=_show_fire_and_log,
                args=(session_id, cue["r"], cue["g"], cue["b"], cue["brightness"]),
                daemon=True,
            ).start()

        # every cue has fired, but the track can still be running (the
        # cue list doesn't necessarily reach all the way to the true
        # end) -- idle here up to the track's own known duration as a
        # safety ceiling AND keep resyncing, so a real stop during this
        # idle tail still gets caught (see resync() above).
        while True:
            if stop_event.is_set():
                return
            now_ms = estimated_progress_ms()
            if now_ms >= duration_ms:
                real_stop = True   # reached the track's own known length
                return
            stop_event.wait(min((duration_ms - now_ms) / 1000, 1.0))
            if time.monotonic() - last_resync > 3:
                last_resync = time.monotonic()
                if resync():
                    return
    finally:
        # a CONFIRMED real stop (progress genuinely frozen, not just
        # is_playing lying) reverts to white/3600K/100% -- Luis's ask,
        # 2026-08-25, matching how he actually runs the lamp day to day
        # (live-read confirmed, not guessed). A deliberate exit (the STOP
        # gesture, /show/stop, re-trigger, cue exhaustion) keeps the old
        # behavior: restore whatever was on the lamp before the show.
        if real_stop:
            hubspace_call("white")
        elif snap_code == 200 and snapshot:
            hubspace_call("set", str(snapshot["r"]), str(snapshot["g"]),
                          str(snapshot["b"]), str(snapshot["brightness"]))


def start_show():
    # each session gets its OWN Event -- a shared/global one meant a
    # not-yet-exited old thread's stop signal got silently CLEARED by the
    # next start_show() call (the 2s join is best-effort, not guaranteed),
    # reviving it as a zombie that kept firing cues from a dead session
    # indefinitely, completely disconnected from real playback state.
    global _show_thread, _show_stop_event
    if _show_stop_event:
        _show_stop_event.set()
    if _show_thread and _show_thread.is_alive():
        _show_thread.join(timeout=2)
    _show_stop_event = threading.Event()
    session_id = f"s{round(time.time())}"
    _show_thread = threading.Thread(
        target=_show_run, args=(SHOW_CUES_PATH, _show_stop_event, session_id), daemon=True)
    _show_thread.start()


def stop_show():
    if _show_stop_event:
        _show_stop_event.set()


def spotify_call(*args):
    """Run spotify_play.py <args...>, return (result_dict, http_code)."""
    try:
        out = subprocess.run(
            ["python3", str(SPOTIFY_SCRIPT), *args],
            capture_output=True, text=True, timeout=10,
        )
        result = json.loads((out.stdout or "{}").strip() or "{}")
        return result, (502 if "error" in result else 200)
    except Exception as e:
        return {"error": str(e)}, 502


def hubspace_call(action, *args):
    """Run hubspace_light.py <action> [args...], return (result_dict, http_code)."""
    try:
        out = subprocess.run(
            [str(HUBSPACE_PY), str(HUBSPACE_SCRIPT), action, *args],
            capture_output=True, text=True, timeout=8,
        )
        result = json.loads((out.stdout or "{}").strip() or "{}")
        return result, (502 if "error" in result else 200)
    except Exception as e:
        return {"error": str(e)}, 502


def load_config():
    cfg = {"name": "Assistant", "port": 8794, "orbs": [],
           # seconds before a non-idle ring state is treated as stale and
           # shown as idle — rescues a writer that died without saying
           # goodbye (see the note in /orb). Raise it if your turns run long.
           "state_timeout_s": 600}
    try:
        cfg.update(json.loads((HERE / "barehands.json").read_text()))
    except Exception:
        pass
    if not cfg.get("orbs"):
        cfg["orbs"] = [
            {"title": "Notes", "path": "sample-notes", "kind": "notes"},
            {"title": "Props", "path": "media", "kind": "media"},
        ]
    for orb in cfg["orbs"]:
        orb["path"] = str(Path(str(orb.get("path", ""))).expanduser())
    # unknown/missing keys fall back to the defaults; a saved file from
    # before a new gesture setting existed still loads clean
    cfg["gestures"] = {**DEFAULT_GESTURES, **cfg.get("gestures", {})}
    return cfg


CONFIG = load_config()


def _media_root():
    """The Props orb's folder, resolved. Defaults to the repo's own ./media.

    A notes orb could always point at any folder on disk while the media orb
    was pinned to ./media — that asymmetry meant an existing prop library had
    to be COPIED into the repo (two copies of your own files, the second one
    sitting in a git working tree). The Props orb's `path` is honoured now,
    the same way a notes orb's is. A relative path still resolves against the
    repo, so the shipped default is unchanged and an existing config keeps
    working.
    """
    for orb in CONFIG.get("orbs", []):
        if orb.get("kind") == "media":
            q = Path(str(orb.get("path") or "media")).expanduser()
            return (q if q.is_absolute() else HERE / q).resolve()
    return (HERE / "media").resolve()


MEDIA_ROOT = _media_root()

try:
    STATE_TIMEOUT = float(CONFIG.get("state_timeout_s", 600))
except (TypeError, ValueError):
    STATE_TIMEOUT = 600.0


def clamp(v, lo, hi, cast=float):
    try:
        return max(lo, min(hi, cast(v)))
    except (TypeError, ValueError):
        return None


# {key: (validator, ...validator args)} -- keeps GESTURE_FIELDS as the
# one place that knows both a setting's type AND its sane range, so a
# malformed or out-of-range POST body can never wedge stage.html with a
# threshold nobody would ever intentionally set (a 0ms latch, a
# negative margin, etc).
GESTURE_FIELDS = {
    "rockOn": lambda v: bool(v),
    "fingerGun": lambda v: bool(v),
    "peaceSign": lambda v: bool(v),
    "shush": lambda v: bool(v),
    "rps": lambda v: bool(v),
    "pileDeck": lambda v: bool(v),
    "rotateDragCancelPx": lambda v: clamp(v, 200, 3000, cast=int),
    "rotateLatchMs": lambda v: clamp(v, 300, 5000, cast=int),
    "fingerGunCurl": lambda v: clamp(v, 0.3, 1.4),
}


def save_gestures(patch):
    """Validate + merge a partial gesture-settings patch, persist it into
    barehands.json (read-modify-write, every other key in the file
    untouched), and return the resulting full gestures dict."""
    with _config_lock:
        try:
            on_disk = json.loads((HERE / "barehands.json").read_text())
        except Exception:
            on_disk = {}
        merged = {**DEFAULT_GESTURES, **CONFIG.get("gestures", {})}
        for k, v in (patch or {}).items():
            if k not in GESTURE_FIELDS:
                continue
            validated = GESTURE_FIELDS[k](v)
            if validated is not None:
                merged[k] = validated
        on_disk["gestures"] = merged
        (HERE / "barehands.json").write_text(json.dumps(on_disk, indent=2) + "\n")
        CONFIG["gestures"] = merged
        return merged


def orb_root(i):
    """Resolve a notes orb's jail root, or None."""
    try:
        orb = CONFIG["orbs"][int(i)]
        assert orb.get("kind") == "notes"
        p = Path(orb["path"])
        if not p.is_absolute():
            p = HERE / p
        return p.resolve()
    except Exception:
        return None


_STATE = b"{}"          # latest scene state: tracker POSTs, render GETs
_CMDS = []              # queued board commands (your AI -> tracker)
_ALLOWED = ("add_img", "add_card", "clear", "reset", "hand", "give",
            "yank", "hover", "scroll_note", "widget", "explode", "assemble",
            "present")


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 persistent connections -- the phone-2 relay hits /cam/frame
    # roughly 15x/sec each direction, and on plain HTTP/1.0 (the stdlib
    # default) every single one of those opens a brand-new TCP+TLS
    # connection through the Codespaces tunnel, which is what was crushing
    # the FPS (2026-08-26 live report). Every response below that has no
    # body now sends an explicit Content-Length: 0 -- required so the
    # client always knows exactly where a response ends and can safely
    # reuse the connection, instead of hanging on an ambiguous body length.
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        # no-store on the pages themselves so a plain reload always serves
        # current code (Chrome/Safari happily cache through reloads
        # otherwise) -- a stale cached copy on a phone would silently miss
        # fixes (this bit cam.html mid-testing, 2026-08-25).
        if self.path.split("?")[0].endswith(("stage.html", "cam.html")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(HERE), **k)

    def translate_path(self, path):
        # Serve /media/* from the configured Props folder, not blindly from
        # ./media. The airlock check and the /props tree both honour
        # MEDIA_ROOT, but static serving would resolve against the repo
        # (directory=HERE), so a Props orb pointing elsewhere would list a
        # viewer's real props and 404 every one of them. Same containment
        # rule as the airlock: resolve first, then prove it's inside.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/media/"):
            rel = urllib.parse.unquote(clean[len("/media/"):]).lstrip("/")
            target = (MEDIA_ROOT / rel).resolve()
            if MEDIA_ROOT == target or MEDIA_ROOT in target.parents:
                return str(target)
            return str(MEDIA_ROOT)
        return super().translate_path(path)

    def log_message(self, *a):
        pass

    def _client_ip(self):
        # traffic to the Codespace's forwarded URL arrives through its
        # proxy, so self.client_address is the proxy, not the real phone --
        # X-Forwarded-For carries the actual one when present.
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global _STATE
        n = int(self.headers.get("Content-Length", 0) or 0)
        # 262144 (256KB) was fine for every other POST body here (all tiny
        # command/state objects) but silently ate real /gesture/record
        # VIDEO takes -- 120/sec landmark capture runs ~1-2MB for a 2.5s
        # take (2026-08-25, traced from a real logged take: 206KB at the
        # OLD 30/sec single-hand rate alone). 20MB covers a two-hand take
        # with real margin.
        MAX_BODY = 20 * 1024 * 1024
        if n > MAX_BODY:
            # CONNECTION-CORRUPTION BUG (2026-08-26, found chasing a real
            # phone .glb-upload failure that was later abandoned as a
            # feature -- but this underlying bug is real regardless and
            # applies to ANY oversized POST to ANY endpoint here). Root
            # cause: the old code just skipped reading an oversized body
            # outright, leaving its bytes unread in the socket. Under the
            # OLD HTTP/1.0 default that was harmless -- the connection
            # closed after every response regardless, so anything unread
            # just got discarded with it. Today's HTTP/1.1 keep-alive
            # change (this same file, earlier today) means the connection
            # is now REUSED -- unread bytes from THIS request's body
            # desync the next request's parse on the same connection,
            # corrupting it. Must always fully drain the socket before
            # responding, oversized or not, so the connection stays valid
            # for reuse either way.
            remaining = n
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._json({"error": f"body too large (max {MAX_BODY // (1024 * 1024)}MB)"}, 413)
            return
        body = self.rfile.read(n) if n > 0 else b"{}"
        if self.path == "/state":
            # the tracker's heartbeat doubles as the command channel
            _STATE = body
            out = json.dumps(_CMDS[:8]).encode()
            del _CMDS[:8]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if self.path == "/light/toggle":
            result, code = hubspace_call("toggle")
            self._json(result, code)
            return
        if self.path == "/light/green":
            result, code = hubspace_call("green")
            self._json(result, code)
            return
        if self.path == "/light/white":
            result, code = hubspace_call("white")
            self._json(result, code)
            return
        if self.path == "/light/set":
            # the light-show driver's general-purpose knob: {r,g,b,brightness}
            try:
                cmd = json.loads(body)
                r, g, b = int(cmd["r"]), int(cmd["g"]), int(cmd["b"])
                brightness = int(cmd["brightness"])
                result, code = hubspace_call("set", str(r), str(g), str(b), str(brightness))
            except Exception as e:
                result, code = {"error": str(e)}, 400
            self._json(result, code)
            return
        if self.path == "/gesture/record":
            # {ts, snapshots:[snap1, snap2]} or {ts, kind:"video", frames}
            # — see GESTURE_LOG above.
            try:
                rec = json.loads(body)
            except Exception as e:
                self._json({"error": str(e)}, 400)
                return
            # a request cut short client-side (tab backgrounded, phone
            # locked, connection dropped mid-recording) reads as an empty
            # body here -- do_POST's shared reader defaults THAT to {},
            # which would otherwise silently log a blank, useless row.
            if not rec.get("snapshots") and not rec.get("frames"):
                self._json({"error": "empty take (no snapshots/frames) — not logged"}, 400)
                return
            GESTURE_LOG.parent.mkdir(parents=True, exist_ok=True)
            with _gesture_log_lock:
                with open(GESTURE_LOG, "a") as f:
                    f.write(json.dumps({"ts": time.time(), **rec}) + "\n")
            self._json({"ok": True})
            return
        if self.path == "/config":
            # {"gestures": {...partial...}} -- the settings panel's save
            # action. Partial on purpose: only keys the panel actually
            # changed need to be sent, everything else keeps its current
            # value. See GESTURE_FIELDS for what's accepted and its range.
            try:
                patch = json.loads(body)
            except Exception as e:
                self._json({"error": str(e)}, 400)
                return
            merged = save_gestures(patch.get("gestures"))
            self._json({"ok": True, "gestures": merged})
            return
        if self.path == "/spotify/play":
            result, code = spotify_call("play", SPOTIFY_TRACK)
            self._json(result, code)
            return
        if self.path == "/spotify/pause":
            result, code = spotify_call("pause")
            self._json(result, code)
            return
        if self.path == "/spotify/resume":
            # THE SHUSH's un-shush -- resume, not force a track like /play
            result, code = spotify_call("resume")
            self._json(result, code)
            return
        if self.path == "/show/start":
            start_show()
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/show/stop":
            stop_show()
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/cam/pin":
            session_id = secrets.token_hex(8)
            pin = f"{secrets.randbelow(10000):04d}"
            with _CAM_LOCK:
                _cam_sweep_locked()
                _CAM_PINS[pin] = {"session_id": session_id, "created": time.time()}
                _CAM_SESSIONS[session_id] = {
                    "created": time.time(), "frame": None, "frame_ts": None}
            _cam_log(f"PIN minted  pin={pin} session={session_id} from={self._client_ip()}")
            self._json({"pin": pin, "session_id": session_id})
            return
        if self.path == "/cam/pair":
            try:
                pin = str(json.loads(body).get("pin", "")).strip()
            except Exception:
                pin = ""
            with _CAM_LOCK:
                _cam_sweep_locked()
                entry = _CAM_PINS.pop(pin, None)   # one-time use
            if entry is None:
                _cam_log(f"PAIR FAILED  pin={pin} from={self._client_ip()} (invalid/expired)")
                self._json({"error": "invalid or expired PIN"}, 400)
                return
            _cam_log(f"PAIR ok  pin={pin} -> session={entry['session_id']} from={self._client_ip()}")
            self._json({"session_id": entry["session_id"]})
            return
        if self.path.startswith("/cam/frame"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            session_id = (q.get("session_id") or [""])[0]
            with _CAM_LOCK:
                sess = _CAM_SESSIONS.get(session_id)
                if sess is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                first_frame = sess["frame"] is None
                sess["frame"] = body
                sess["frame_ts"] = time.time()
            # ~15 uploads/sec would drown the log -- only the first frame
            # of a session (the moment phone 2 actually goes live) prints.
            if first_frame:
                _cam_log(f"FRAME stream started  session={session_id} "
                         f"bytes={len(body)} from={self._client_ip()}")
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/cmd":
            try:
                cmd = json.loads(body)
                assert cmd.get("a") in _ALLOWED
                if cmd["a"] in ("add_img", "hand", "give", "present") and cmd.get("src"):
                    # THE AIRLOCK: only files really inside ./media/ ever
                    # stage — subfolders allowed, escapes 400. If the
                    # exact path misses, a UNIQUE basename match anywhere
                    # inside the airlock self-heals a wrong-folder guess;
                    # zero or many matches still 400.
                    rel = str(cmd.get("src", "")).lstrip("/")
                    if rel.startswith("media/"):
                        rel = rel[6:]
                    media = MEDIA_ROOT
                    target = (media / rel).resolve()
                    if media not in target.parents or not target.is_file():
                        name = Path(rel).name.lower()
                        hits = [p for p in media.rglob("*")
                                if p.is_file()
                                and p.name.lower() == name] if name else []
                        if len(hits) != 1:
                            raise ValueError("not in the media airlock")
                        target = hits[0]
                    cmd["src"] = "/media/" + target.relative_to(media).as_posix()
                _CMDS.append(cmd)
                self.send_response(204)
            except Exception:
                self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/light/status":
            result, code = hubspace_call("get")
            self._json(result, code)
            return
        if self.path == "/spotify/status":
            result, code = spotify_call("status")
            self._json(result, code)
            return
        if self.path == "/spotify/progress":
            # {is_playing, progress_ms, item} -- THE SHUSH checks
            # is_playing before doing anything (no music = no-op)
            result, code = spotify_call("progress")
            self._json(result, code)
            return
        if self.path == "/spotify/login":
            # one-time browser login: send the person to Spotify's consent
            # screen; /spotify/callback below catches the redirect back
            try:
                client_id = json.loads(SPOTIFY_CREDS.read_text())["client_id"]
            except Exception:
                self._json({"error": "scripts/spotify/.state/creds.json missing/invalid"}, 500)
                return
            params = urllib.parse.urlencode({
                "client_id": client_id, "response_type": "code",
                "redirect_uri": SPOTIFY_REDIRECT, "scope": SPOTIFY_SCOPES,
            })
            self.send_response(302)
            self.send_header("Location", f"https://accounts.spotify.com/authorize?{params}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/spotify/callback"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code = (q.get("code") or [None])[0]
            if not code:
                err = (q.get("error") or ["no code in callback"])[0]
                body = f"<body style='font-family:monospace'>Spotify login failed: {err}</body>".encode()
            else:
                result, _ = spotify_call("exchange", code)
                ok = result.get("authed")
                body = (f"<body style='font-family:monospace'>"
                        f"{'Spotify linked — you can close this tab.' if ok else 'Exchange failed: ' + json.dumps(result)}"
                        f"</body>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/config":
            # the page builds its ring name + orb bloom from this, and
            # (2026-08-27) its gesture-settings panel from "gestures"
            self._json({"name": CONFIG.get("name", "Assistant"),
                        "orbs": [{"title": o.get("title", "?"),
                                  "kind": o.get("kind", "notes")}
                                 for o in CONFIG["orbs"]],
                        "gestures": CONFIG.get("gestures", DEFAULT_GESTURES)})
            return
        if self.path.startswith("/tree"):
            # a notes orb's folder tree. Jailed to that orb's configured
            # folder, .md only, CLAUDE.md (AI config, not a note) excluded.
            q = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query)
            idx = (q.get("orb") or ["0"])[0]
            root = orb_root(idx)
            if root is None or not root.is_dir():
                self._json({"name": "?", "notes": [], "dirs": []}, 404)
                return

            def walk(d):
                out = {"name": d.name, "notes": [], "dirs": []}
                for p in sorted(d.iterdir()):
                    if p.name.startswith("."):
                        continue
                    if p.is_dir():
                        sub = walk(p)
                        if sub["notes"] or sub["dirs"]:
                            out["dirs"].append(sub)
                    elif p.suffix == ".md" and p.name != "CLAUDE.md":
                        # note files travel as "<orb>/<relpath>" so /note
                        # knows which jail to resolve them against
                        out["notes"].append(
                            {"title": p.stem,
                             "file": f"{int(idx)}/{p.relative_to(root).as_posix()}"})
                return out
            try:
                tree = walk(root)
                tree["name"] = CONFIG["orbs"][int(idx)].get("title", tree["name"])
                self._json(tree)
            except Exception:
                self._json({"name": "?", "notes": [], "dirs": []}, 500)
            return
        if self.path == "/props":
            # the media airlock as a browsable tree — live filesystem
            # read: drop a file in media/, reopen the orb, it's there

            def walkm(d):
                out = {"name": d.name, "items": [], "dirs": []}
                for p in sorted(d.iterdir()):
                    if p.name.startswith("."):
                        continue
                    if p.is_dir():
                        sub = walkm(p)
                        # a folder carrying a README was made on purpose, so
                        # it stays listed even while empty — the board is how
                        # a folder gets discovered. Arbitrary empty folders
                        # still stay hidden.
                        documented = (p / "README.md").is_file()
                        if sub["items"] or sub["dirs"] or documented:
                            out["dirs"].append(sub)
                    elif p.suffix.lower() in MEDIA_EXTS:
                        # as_posix: these strings become URL fragments in the
                        # browser, where a backslash is not a separator — and
                        # THE FOLDER IS THE RENDER LAW, read client-side with
                        # forward slashes (/\/fx\// etc. in stage.html).
                        out["items"].append(p.relative_to(MEDIA_ROOT).as_posix())
                return out
            try:
                tree = walkm(MEDIA_ROOT)
                tree["name"] = "Props"
                self._json(tree)
            except Exception:
                self._json({"name": "Props", "items": [], "dirs": []}, 500)
            return
        if self.path.startswith("/cam/frame"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            session_id = (q.get("session_id") or [""])[0]
            with _CAM_LOCK:
                sess = _CAM_SESSIONS.get(session_id)
                if sess is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                frame, frame_ts = sess["frame"], sess["frame_ts"]
            if frame is None:
                # a valid, still-live session (created by /cam/pin) that
                # just hasn't received its first upload yet -- distinct
                # from 404 (no such session at all) so stage.html can tell
                # "still waiting for phone 2" apart from "pairing expired".
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self.send_header("X-Frame-Ts", str(frame_ts))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(frame)
            return
        if self.path == "/orb":
            # the ring's heartbeat: your assistant's live state, read from
            # tiny files in ./state/. Every read fails soft — no files,
            # no assistant, no problem: the ring just breathes.
            s_dir = HERE / "state"
            out = {"state": "idle", "mood": "green", "wave": None}
            try:
                f = s_dir / "state"
                s = f.read_text().strip().lower()
                if s in ("idle", "listening", "thinking", "speaking"):
                    # a STALE non-idle state decays to idle: the only thing
                    # that ever writes "idle" is a session finishing, so a
                    # session killed or crashed mid-turn never writes it and
                    # the ring sat on "thinking" forever. Safety net for a
                    # dead writer, not a liveness signal — a genuinely long
                    # turn decays too; raise state_timeout_s if yours do.
                    age = time.time() - f.stat().st_mtime
                    if s == "idle" or age < STATE_TIMEOUT:
                        out["state"] = s
            except Exception:
                pass
            try:
                m = json.loads((s_dir / "mood.json").read_text())
                if time.time() - float(m.get("ts", 0)) < 45.0:
                    out["mood"] = m.get("mood", "green")
            except Exception:
                pass
            if out["state"] == "speaking":
                try:
                    w = json.loads((s_dir / "wave.json").read_text())
                    if time.time() - float(w.get("ts", 0)) < 0.6:
                        out["wave"] = w.get("samples", [])[:64]
                except Exception:
                    pass
            self._json(out)
            return
        if self.path == "/state":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(_STATE)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(_STATE)
            return
        if not self.path.startswith("/note?"):
            return super().do_GET()
        # one note's text: f=<orb>/<relpath>, resolved against that orb's
        # jail. Inside the root, .md only, must exist — anything else 404s.
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel = (q.get("f") or [""])[0]
        idx, _, rel = rel.partition("/")
        root = orb_root(idx)
        if root is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        target = (root / rel).resolve()
        if (root not in target.parents) or target.suffix != ".md" \
                or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = target.read_text(encoding="utf-8", errors="replace").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    (HERE / "state").mkdir(exist_ok=True)   # the ring's runtime files land here
    port = int(CONFIG.get("port", 8794))
    print(f"barehands up: http://127.0.0.1:{port}/stage.html", flush=True)
    # 0.0.0.0, not 127.0.0.1: Codespaces' automatic port-forward detection
    # needs a non-loopback bind to notice this is listening and proxy it to
    # a phone/browser outside the container (same reasoning as ai-visualizer).
    print("  tracker (camera): open that URL in Chrome", flush=True)
    print("  render (overlay): same URL + ?role=render", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
