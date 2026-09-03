---
name: ship-it
description: Run the full vault checkpoint drill for the current session — persist every change to its real contextual home, sync the daily note and folder indexes, log any decision, drift-scan, verify each write landed, and commit code changes with the required attribution. Invoke when Luis says "ship it", "check it in", "checkpoint", or "close it out".
---

# Ship It

The checkpoint discipline from `CLAUDE.md`, run as a fixed sequence instead of from memory. The failure this prevents: a session ends, the daily note gets a line, and the real documentation home never happens — so the next session can't find it. Do every step. Don't skip one because it "looks empty" — say "nothing changed there" and move on.

## 0. Scope the session

List, out loud, everything that changed this session:
- **Files** created, edited, moved, deleted (code and vault).
- **Running systems** touched (a service, a config, a hook, a cron).
- **Decisions** made — anything with real tradeoff analysis or expensive to reverse.
- **Profile / preference** facts learned about Luis or how he wants things done.

Lock that list. Every later step works through it.

## 1. Real contextual home for each change

For each item in scope, find where it actually belongs:
- **An existing note first.** Run `python3 /workspaces/Jarvis/scripts/vault-lookup/lookup.py "<the thing, in plain English>"` to find it. Append to it.
- **A new note** in the right folder only if nothing existing is a logical home. Give it YAML frontmatter (`status` / `project` / `type`) — infer the values, never ask.
- **A daily-note entry alone is NEVER the home.** The daily note is the log; the contextual note is the memory.

Write the updates now. Consolidate — if this replaces something already in the note, delete what it replaced. No accreting two versions.

## 2. Today's daily note

- Path: `HQ/01 - Daily Notes/NN - Month YYYY/YYYY-MM-DD.md`. Verify today's date against the system clock first (`date` — a session can span midnight). Use Pacific (Mexicali/Tijuana).
- If today's note doesn't exist, create it from `HQ/01 - Daily Notes/Daily Note Template.md` — copy the template, fill the placeholders. Never hand-roll a bare heading.
- If it exists, append a new `## Session N — [Pacific time]: [topic]` section. Don't overwrite the earlier session.
- Fill the template's sections: Index bullet (update this first), What Got Done, What's Still In Progress, Decisions Made, Notes Touched, Profile Updates. An empty section stays as a bare `-`.

## 3. Folder indexes

For every folder that gained, lost, or materially changed a note this session:
- Open its index (`<Folder Name>.md`, folder name with any leading `NN - ` stripped).
- Add / update / remove the note's bullet so the index matches the folder exactly.
- If a **new folder** was created: create its index note in the same pass, and add it to the Vault Structure map in `HQ/VAULT-INDEX.md`.

## 4. Decisions Log

If step 0 found a real decision, append an entry to `HQ/05 - Resources/Reference/Decisions Log.md` — newest first, in that file's format: date, project tag, the decision, the reasoning, reversibility if it matters. Skip anything trivial or trivially undone.

## 5. Drift scan

Run `python3 /workspaces/Jarvis/scripts/vault-audit/audit.py`. Fix what it reports that's mechanically safe (a missing index bullet, inferred frontmatter, a dropped template heading). Leave judgment-heavy findings (orphans, ambiguous broken links) for Luis and say so.

Then eyeball the touched folder's index and any notes cross-referenced by what you changed — fix stale links or counts in the same pass.

## 6. Verify every write

Read each file you changed back. Confirm the change is actually there. "I edited it" is not evidence; the reread is. If a write didn't land, fix it before continuing.

## 7. Code changes → commit

If any project **source code** changed (not vault notes):
- State the exact diff in plain language and get Luis's explicit confirmation before committing — even if it seems obvious.
- Branch first if on `main`.
- End the commit message with this session's own attribution footer — the `Co-Authored-By:` line and `Claude-Session:` URL given in the current session's attribution guidance. Do not copy a URL from a past session.
- Push / open a PR only if Luis asked for it.

## 8. Report

Terminal reply stays short: what got persisted where, what the audit said, anything still open. The detail lives in the vault now, not the chat. End on the next action or a forward question — never a wrap-up or a suggestion to stop.
