# claude-quota

Track this machine's Claude Code usage against the plan limit, warn in-terminal
as it approaches, and swap the credential file to a second account before the
first one gets capped.

Full write-up lives in the vault:
`HQ/05 - Resources/Jarvis Systems/Claude Code Quota (claude-quota).md`.

## Ground truth

`https://api.anthropic.com/api/oauth/usage`, called with the account's own OAuth
token (the same data the in-CLI `/usage` screen shows). Per window it returns
`utilization` (0-100 percent), an exact `resets_at`, and `locked_reason` when the
window is capped. No estimating against a guessed token ceiling.

## Commands

```
scripts/claude-quota/usage.sh            # 5h / 7d bars, %, reset countdowns
scripts/claude-quota/usage.sh check      # silent unless >= WARN_PCT / locked
scripts/claude-quota/usage.sh json       # raw payload

scripts/claude-quota/account.sh setup    # one-time: how to save both accounts
scripts/claude-quota/account.sh save <name>
scripts/claude-quota/account.sh list
scripts/claude-quota/account.sh status
scripts/claude-quota/account.sh use <name>
scripts/claude-quota/account.sh auto     # swap to healthiest other account if capped
scripts/claude-quota/account.sh restore-prev
```

## Thresholds — `config.env` (max of the 5h and 7d windows)

| var        | default | effect                                                        |
|------------|---------|--------------------------------------------------------------|
| `WARN_PCT` | 80      | `usage.sh check` exits nonzero                               |
| `SWAP_PCT` | 90      | hook swaps the creds file + warns; current turn not stopped  |
| `BLOCK_PCT`| 97      | hook swaps + `exit 2`: blocks the tool call / next prompt    |

## Enforcement — `hook.sh`, wired into `.claude/settings.json`

`SessionStart` (prints status, swaps if already capped), `UserPromptSubmit`
(blocks a new turn on a capped account), `PreToolUse` for every tool (the
mid-task catch). Results are cached for `CACHE_TTL` seconds and the green path
short-circuits in ~30 s intervals, so the endpoint is not hammered. Any network
failure is fail-open.

## The hard limitation

Swapping `~/.claude/.credentials.json` does **not** hot-reload the running
`claude` process. The hook changes the file and tells you; you `/exit` and
reopen `claude` to actually move onto the other account. `BLOCK_PCT` exists to
stop you burning the capped account in the meantime.

## Setup required before auto-swap works

`account.sh auto` needs a second account saved. Run `account.sh setup` and
follow it (`/login` into each account, `account.sh save <name>`). An account
left idle past its refresh-token expiry goes stale — `account.sh list` shows the
days left; re-`/login` and re-`save` to refresh it.
