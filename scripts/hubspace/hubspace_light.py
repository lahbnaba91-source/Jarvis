#!/usr/bin/env python3
"""Toggle the Hubspace lamp via the Afero cloud API (aioafero).

Usage:
    hubspace_light.py status    # print {"on": bool, "name": str} for the light
    hubspace_light.py toggle    # flip it, print the new state
    hubspace_light.py green     # on, color green, brightness 100%
    hubspace_light.py white     # on, white mode, 3600K, brightness 100%
    hubspace_light.py set <r> <g> <b> <brightness>   # on, arbitrary RGB + 0-100%

First run needs HUBSPACE_EMAIL + HUBSPACE_PASSWORD in the environment to do
a one-time password login. The resulting refresh token is cached at
.state/refresh_token (gitignored) and reused on every later call, so the
password is never touched or stored again after that first run.

Talks to exactly one light: whichever the Afero account's `lights`
controller discovers first. Fine as long as there's only one -- confirmed
via a live test run (2026-08-25): a single light, "Lamp".
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from aioafero.v1 import AferoBridgeV1
from aioafero.v1.auth import AferoAuth

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
TOKEN_PATH = STATE_DIR / "refresh_token"
USERNAME_PATH = STATE_DIR / "username"


def err(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


async def get_bridge(session: aiohttp.ClientSession) -> AferoBridgeV1:
    if TOKEN_PATH.is_file() and USERNAME_PATH.is_file():
        username = USERNAME_PATH.read_text().strip()
        refresh_token = TOKEN_PATH.read_text().strip()
        try:
            bridge = await AferoBridgeV1.open(username, refresh_token, session)
            return bridge
        except Exception:
            pass  # cached token no good -- fall through to a fresh login

    username = os.environ.get("HUBSPACE_EMAIL")
    password = os.environ.get("HUBSPACE_PASSWORD")
    if not username or not password:
        err("no cached session and HUBSPACE_EMAIL/HUBSPACE_PASSWORD not set")

    auth = AferoAuth.for_login(session, username, password)
    token_data = await auth.login()
    bridge = await AferoBridgeV1.open(
        username,
        token_data.refresh_token,
        session,
        token=token_data.token,
        token_expiration=token_data.expiration,
    )
    STATE_DIR.mkdir(exist_ok=True)
    TOKEN_PATH.write_text(token_data.refresh_token)
    USERNAME_PATH.write_text(username)
    return bridge


async def run(action: str, args: list[str]) -> dict:
    async with aiohttp.ClientSession() as session:
        bridge = await get_bridge(session)
        try:
            lights = bridge.lights.items
            if not lights:
                err("no lights found on this Hubspace account")
            light = lights[0]
            light_id = light.id
            name = light.device_information.name
            is_on = bool(light.on.on) if light.on else False

            if action == "toggle":
                if is_on:
                    await bridge.lights.turn_off(light_id)
                else:
                    await bridge.lights.turn_on(light_id)
                is_on = not is_on
                return {"name": name, "on": is_on}

            if action == "green":
                await bridge.lights.set_state(
                    light_id, on=True, color_mode="color",
                    color=(0, 255, 0), brightness=100)
                return {"name": name, "on": True, "color": "green", "brightness": 100}

            if action == "white":
                # the 4-finger gesture's actual color -- matches how Luis
                # normally runs the lamp (white, 3600K, full brightness).
                # Optional temperature arg (2026-08-25, added for the
                # ROCK ON real-stop revert in barehands/server.py) can
                # override the 3600K default without touching every other
                # caller -- in practice that revert calls "white" with no
                # arg too, since a live read confirmed 3600K is correct.
                temperature = int(args[0]) if args else 3600
                await bridge.lights.set_state(
                    light_id, on=True, color_mode="white",
                    temperature=temperature, brightness=100)
                return {"name": name, "on": True, "color_mode": "white",
                        "color_temp_k": temperature, "brightness": 100}

            if action == "set":
                # set <r> <g> <b> <brightness 0-100> -- the light-show driver's
                # general-purpose knob, one cloud round-trip per call (~0.8s).
                if len(args) != 4:
                    err("usage: hubspace_light.py set <r> <g> <b> <brightness>")
                r, g, b, brightness = (int(x) for x in args)
                r, g, b = (max(0, min(255, v)) for v in (r, g, b))
                brightness = max(0, min(100, brightness))
                await bridge.lights.set_state(
                    light_id, on=True, color_mode="color",
                    color=(r, g, b), brightness=brightness)
                return {"name": name, "on": True, "color": [r, g, b], "brightness": brightness}

            if action == "get":
                # full current state -- the light-show's before/after
                # snapshot, so a show can restore exactly what was there
                c = light.color
                d = light.dimming
                cm = light.color_mode
                ct = light.color_temperature
                return {"name": name, "on": is_on,
                        "r": c.red if c else 0, "g": c.green if c else 0,
                        "b": c.blue if c else 0,
                        "brightness": d.brightness if d else 100,
                        "color_mode": cm.mode if cm else None,
                        "color_temp_k": ct.temperature if ct else None}

            return {"name": name, "on": is_on}
        finally:
            await bridge.close()


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("status", "toggle", "green", "white", "set", "get"):
        err("usage: hubspace_light.py status|toggle|green|white|get|set <r> <g> <b> <brightness>")
    t0 = time.time()
    result = asyncio.run(run(sys.argv[1], sys.argv[2:]))
    result["elapsed_s"] = round(time.time() - t0, 2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
