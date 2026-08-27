#!/usr/bin/env python3
"""Trigger Spotify playback via the Web API (Authorization Code flow).

Usage:
    spotify_play.py exchange <code>   # one-time: trade the /callback code
                                       # for tokens, cache the refresh token
    spotify_play.py play <uri>        # start a track/playlist on the
                                       # active device (spotify:track:... or
                                       # spotify:playlist:...)
    spotify_play.py pause             # pause playback on the active device
    spotify_play.py status            # {"authed": bool}

Needs an active Spotify device already open somewhere (phone/desktop/web) --
this API can't launch the app itself, only tell an already-open one what
to play.

client_id/client_secret live in .state/creds.json (gitignored, written once
by setup). The refresh token lands in .state/refresh_token (gitignored)
after the first /spotify/login -> /spotify/callback round trip; every call
after that mints a fresh access token from it, so the browser login never
has to happen again unless the refresh token is revoked.
"""
import base64
import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
CREDS_PATH = STATE_DIR / "creds.json"
TOKEN_PATH = STATE_DIR / "refresh_token"

REDIRECT_URI = "https://cuddly-space-doodle-4qwjpgpvqvgrhqgvq-8794.app.github.dev/spotify/callback"
SCOPES = "user-modify-playback-state user-read-playback-state"
TOKEN_URL = "https://accounts.spotify.com/api/token"


def err(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


def creds() -> dict:
    try:
        return json.loads(CREDS_PATH.read_text())
    except Exception:
        err("no .state/creds.json -- client_id/client_secret not configured")


def basic_auth_header() -> dict:
    c = creds()
    raw = f"{c['client_id']}:{c['client_secret']}".encode()
    return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


def exchange_code(code: str) -> dict:
    resp = requests.post(TOKEN_URL, headers=basic_auth_header(), data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }, timeout=10)
    data = resp.json()
    if "refresh_token" not in data:
        return {"error": data.get("error_description", "no refresh_token in response")}
    STATE_DIR.mkdir(exist_ok=True)
    TOKEN_PATH.write_text(data["refresh_token"])
    return {"authed": True}


def get_access_token() -> str:
    if not TOKEN_PATH.is_file():
        err("not authed yet -- visit http://127.0.0.1:8794/spotify/login first")
    refresh_token = TOKEN_PATH.read_text().strip()
    resp = requests.post(TOKEN_URL, headers=basic_auth_header(), data={
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, timeout=10)
    data = resp.json()
    if "access_token" not in data:
        err(data.get("error_description", "refresh failed"))
    # Spotify sometimes rotates the refresh token on refresh; keep the
    # newest one so a stale token never gets stuck in the cache.
    if data.get("refresh_token"):
        TOKEN_PATH.write_text(data["refresh_token"])
    return data["access_token"]


DEFAULT_DEVICE_ID = "18e2a2e0-cfb7-415c-94ba-1366c00378fe_amzn_1"   # luis's Echo Dot


def play_uri(uri: str, device_id: str = DEFAULT_DEVICE_ID) -> dict:
    token = get_access_token()
    resp = requests.put(
        "https://api.spotify.com/v1/me/player/play",
        params={"device_id": device_id} if device_id else {},
        headers={"Authorization": f"Bearer {token}"},
        json={"uris": [uri]}, timeout=10)
    if resp.status_code in (200, 204):
        return {"playing": uri, "device_id": device_id}
    if resp.status_code == 404:
        return {"error": "NO_ACTIVE_DEVICE -- open Spotify (phone/desktop/web) first"}
    try:
        detail = resp.json().get("error", {}).get("message", resp.text)
    except Exception:
        detail = resp.text
    return {"error": f"{resp.status_code}: {detail}"}


def pause(device_id: str = DEFAULT_DEVICE_ID) -> dict:
    # Luis's device is an Echo Dot on Spotify Connect via Alexa -- confirmed
    # live that pause returns 200 with an opaque token body instead of the
    # usual 204, even though it genuinely pauses (is_playing flips false).
    token = get_access_token()
    resp = requests.put(
        "https://api.spotify.com/v1/me/player/pause",
        params={"device_id": device_id} if device_id else {},
        headers={"Authorization": f"Bearer {token}"}, timeout=10)
    if resp.status_code in (200, 204):
        return {"paused": True, "device_id": device_id}
    if resp.status_code == 404:
        return {"error": "NO_ACTIVE_DEVICE -- open Spotify (phone/desktop/web) first"}
    try:
        detail = resp.json().get("error", {}).get("message", resp.text)
    except Exception:
        detail = resp.text
    return {"error": f"{resp.status_code}: {detail}"}


def status() -> dict:
    if not TOKEN_PATH.is_file():
        return {"authed": False}
    try:
        get_access_token()
        return {"authed": True}
    except SystemExit:
        return {"authed": False}


def progress() -> dict:
    """Live playback position -- the light-show scheduler's sync anchor."""
    token = get_access_token()
    resp = requests.get("https://api.spotify.com/v1/me/player",
                         headers={"Authorization": f"Bearer {token}"}, timeout=10)
    if resp.status_code == 204 or not resp.text:
        return {"is_playing": False, "progress_ms": None}
    data = resp.json()
    return {"is_playing": bool(data.get("is_playing")),
            "progress_ms": data.get("progress_ms"),
            "item": (data.get("item") or {}).get("uri")}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("exchange", "play", "pause", "status", "progress"):
        err("usage: spotify_play.py exchange <code> | play <uri> | pause | status | progress")
    action = sys.argv[1]
    if action == "exchange":
        if len(sys.argv) != 3:
            err("usage: spotify_play.py exchange <code>")
        result = exchange_code(sys.argv[2])
    elif action == "progress":
        result = progress()
    elif action == "play":
        if len(sys.argv) != 3:
            err("usage: spotify_play.py play <spotify-uri>")
        result = play_uri(sys.argv[2])
    elif action == "pause":
        result = pause()
    else:
        result = status()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
