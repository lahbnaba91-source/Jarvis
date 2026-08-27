#!/usr/bin/env python3
"""Terminal chat agent backed by a free Groq-hosted model (OpenAI-compatible
API), with the same shape as Claude Code: a REPL loop where the model can
read files, list directories, write files, and run shell commands.

Needs a free API key from console.groq.com in the environment:

    export GROQ_API_KEY=gsk_...
    scripts/groq-agent/agent.py

Optional: GROQ_MODEL to override the default model.

write_file and run_shell ALWAYS print exactly what they're about to do and
wait for an explicit y/n before doing it -- that gate lives in this script,
not in the model's judgment, since a free/weaker model is driving real
writes and real commands on this machine.

Type 'exit' or 'quit' to end the session.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import requests

JARVIS_ROOT = Path("/workspaces/Jarvis")
API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-oss-120b"
MAX_TOOL_ROUNDS = 10
READ_LIMIT = 40_000
SHELL_OUTPUT_LIMIT = 8_000

SYSTEM_PROMPT = f"""You are a terminal ops/coding assistant running on a free \
Groq-hosted model, operating inside the Jarvis codespace at {JARVIS_ROOT}.

You have tools: read_file and list_dir run immediately. write_file and \
run_shell are gated -- the human is shown the exact write or command and \
must approve it before it happens. That approval is handled outside your \
control, so just call the tool and read the result; don't ask the user to \
type a confirmation in chat themselves, the tool already does that.

To bring up the ai-visualizer, jarvis-voice, and barehands servers, run:
    bash scripts/start-all.sh
from {JARVIS_ROOT}. It's idempotent -- it skips any service already \
listening on its port (ai-visualizer :8790, jarvis-voice :8791, \
barehands :8794), so it's always safe to run.

If a write_file or run_shell call comes back with {{"declined": true}}, \
that means the human said no. Do not retry the same action rephrased (a \
different shell syntax, a different wrapper) -- that's an end run around \
their answer. Tell them it was declined and stop; only try again if they \
explicitly ask you to.

Keep responses concise and direct."""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file's contents.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List entries in a directory.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or overwrite a text file. Requires human approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": "Run a shell command. Requires human approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                },
                "required": ["command"],
            },
        },
    },
]


def resolve(path: str) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else JARVIS_ROOT / p


def confirm(prompt: str) -> bool:
    try:
        reply = input(f"{prompt} [y/N]: ").strip().lower()
    except EOFError:
        return False
    return reply == "y"


def tool_read_file(path: str) -> dict:
    p = resolve(path)
    try:
        text = p.read_text(errors="replace")
    except Exception as e:
        return {"error": str(e)}
    truncated = len(text) > READ_LIMIT
    return {"content": text[:READ_LIMIT], "truncated": truncated}


def tool_list_dir(path: str) -> dict:
    p = resolve(path)
    try:
        entries = sorted(p.iterdir())
    except Exception as e:
        return {"error": str(e)}
    return {
        "entries": [
            f"{e.name}/" if e.is_dir() else e.name for e in entries
        ]
    }


def tool_write_file(path: str, content: str) -> dict:
    p = resolve(path)
    action = "Overwrite" if p.exists() else "Create"
    print(f"\n--- {action} {p} ---")
    preview = content if len(content) <= 2000 else content[:2000] + "\n... (truncated)"
    print(preview)
    print("--- end of file content ---")
    if not confirm(f"{action} this file?"):
        return {"declined": True}
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    except Exception as e:
        return {"error": str(e)}
    return {"ok": True}


def tool_run_shell(command: str, cwd: str = None) -> dict:
    run_dir = resolve(cwd) if cwd else JARVIS_ROOT
    print(f"\n--- run in {run_dir} ---")
    print(command)
    print("--- end of command ---")
    if not confirm("Run this command?"):
        return {"declined": True}
    try:
        proc = subprocess.run(
            command, shell=True, cwd=run_dir,
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:
        return {"error": str(e)}
    out = (proc.stdout or "") + (proc.stderr or "")
    if len(out) > SHELL_OUTPUT_LIMIT:
        out = out[:SHELL_OUTPUT_LIMIT] + "\n... (truncated)"
    return {"returncode": proc.returncode, "output": out}


DISPATCH = {
    "read_file": lambda a: tool_read_file(a["path"]),
    "list_dir": lambda a: tool_list_dir(a["path"]),
    "write_file": lambda a: tool_write_file(a["path"], a["content"]),
    "run_shell": lambda a: tool_run_shell(a["command"], a.get("cwd")),
}


def groq_chat(api_key: str, model: str, messages: list) -> dict:
    resp = requests.post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto",
            "temperature": 0.3,
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Groq API error {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def main() -> None:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        print("ERROR: GROQ_API_KEY is not set. Get a free key at "
              "console.groq.com and `export GROQ_API_KEY=...`", file=sys.stderr)
        sys.exit(1)
    model = os.environ.get("GROQ_MODEL", DEFAULT_MODEL)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    print(f"Groq terminal agent ({model}) -- type 'exit' to quit.")

    while True:
        try:
            user_input = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit"):
            break

        messages.append({"role": "user", "content": user_input})

        for _ in range(MAX_TOOL_ROUNDS):
            try:
                data = groq_chat(api_key, model, messages)
            except Exception as e:
                print(f"[error] {e}")
                messages.pop()  # drop the user turn, don't leave state stuck
                break

            msg = data["choices"][0]["message"]
            tool_calls = msg.get("tool_calls")

            if not tool_calls:
                content = msg.get("content", "")
                print(f"\nagent> {content}")
                messages.append({"role": "assistant", "content": content})
                break

            messages.append(msg)
            for call in tool_calls:
                name = call["function"]["name"]
                try:
                    args = json.loads(call["function"]["arguments"] or "{}")
                except Exception:
                    args = {}
                fn = DISPATCH.get(name)
                result = fn(args) if fn else {"error": f"unknown tool {name}"}
                messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": json.dumps(result),
                })
        else:
            print("[warning] hit tool-call round limit for this turn")


if __name__ == "__main__":
    main()
