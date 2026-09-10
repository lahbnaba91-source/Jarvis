---
status: active
project: meta
type: index
---
# VAULT INDEX

Read this file at the start of every conversation to understand who I am, how I work, and how this vault is organized. This is a fresh vault — the profile sections below are stubs. Fill them in.

---

## Vault location

This vault lives at `@@VAULT_PATH@@`. If you use Claude Desktop, claude.ai, or any AI other than Claude Code, point it at this path (set it in your MCP / filesystem connector, and tell the AI "my vault is here"). An AI can't read or maintain a vault it can't find.

---

## Who I Am

<!-- Fill this in: name, where you're based, timezone, what you do. A few sentences. -->

## Key People

<!-- People the assistant should recognise by name. One bullet each: name, relationship. -->

## Projects

<!-- One short section per active project. Give each a folder under 02 - Projects/ and note its status. -->

## Vault Structure

```
00 - Inbox            ← Capture everything, sort later
01 - Daily Notes      ← Dated logs of what got done, one file per day
02 - Projects         ← One subfolder per active project
03 - Personal         ← Life outside work
04 - Archive          ← Completed projects and old notes
05 - Resources         ← Cross-project reference material, templates
06 - Reference        ← Static knowledge you look up
07 - Systems Status   ← What's running, last verified working, known fragile points
```

## What's Active Right Now

All open work lives in one note: [[Active Priorities]]. Tag each item with its project where it isn't obvious. Check it at the start of every conversation; verify an item's real state before acting on it.

## How I Think

<!-- How you make decisions, what you value in an answer, how you like to work. -->

## My Preferences for Working with AI

- **Plain language, no jargon, and be direct.** Don't hedge or over-qualify.
- **Be a partner, not a yes-man.** Argue your position when you think I'm wrong.
- **Don't settle for half-finished work.** Do it right the first time.
- **Pull me back from rabbit holes.** Flag tangents; be the closer.
- <!-- Add your own. -->

---

## How My Memory Works (for the AI)

This vault is your memory. It is external and effectively unlimited. Do not try to hold all of it at once. Hold only what the current task needs, and trust that everything else is one search away. **To find something, run `python3 @@JARVIS_ROOT@@/scripts/vault-lookup/lookup.py "<the task, in plain English>"` first.** It deterministically resolves a matching Job's full boot chain, or ranks notes by frontmatter/heading/index-pointer signals. Only fall back to manually starting at this index and following folder indexes/wikilinks if the tool isn't reachable or its top result clearly isn't right. Knowing a note exists is as good as holding it, because you can retrieve it in one step.

---

## Vault Rules for AI

These rules apply to any AI that reads or writes to this vault.

### Frontmatter and Wikilinks

Every note MUST have YAML frontmatter. When you create a note, include it. When you edit an existing note that's missing or has incomplete frontmatter, fix it as part of that write. Don't stop to add frontmatter to files you're only reading. Code files are the exception — no frontmatter or wikilinks in code.

Never ask what the frontmatter values should be. Infer them.

### Note format

Simple, legible, readable. No random emojis. Checkboxes are real Markdown checkboxes (`- [ ]` / `- [x]`), never emoji stand-ins. **Append before you create:** default to adding to an existing note rather than spinning up a new one — fewer, fuller notes beat many thin ones. Create a new note only when nothing existing is a logical home.

```yaml
---
status: active
project: [project-slug]
type: plan
---
```

**Always link:** anyone in Key People · named businesses, products, and platforms · any note this one directly references, extends, or depends on.
**Never link:** generic words just because a note shares the name · the same target twice in one note · the note's own title.

### How to Determine Each Field

**status** — Default `active`. In progress / has unchecked items → `active`; all done → `completed`; a future "maybe" → `idea`; was active but gone quiet → `parked`; in the Archive folder → `archived`.

**project** — What the note *serves* (folder is the default, but content wins).

**type** — What KIND of document it is: `index` (folder map), `reference` (static lookup doc), `guide` (how-to/runbook), `plan` (strategy/phased build), `log` (dated session capture).

### Valid Field Values

**status:** `active` | `completed` | `parked` | `idea` | `archived`
**type:** `index` | `reference` | `guide` | `plan` | `log`

### Folder Indexes (keep them in sync)

Every folder that holds substantial content gets an index note named after the folder: `<Folder Name>.md`, frontmatter `type: index`, listing each note with a one-line description. When you create, rename, move, or materially change a note, update its folder's index in the same pass. When a new folder is created, create its index at the same time and update the **Vault Structure** map above.

### Renaming and moving notes

- **Moving** a note to another folder is safe — wikilinks resolve by note name. Update both folders' indexes.
- **Renaming** a note breaks `[[links]]` unless done **inside the Obsidian app** (its "auto-update internal links" setting). A shell `mv` does not. If you must rename a file directly, find and fix every `[[old name]]` reference by hand.

### Checkpoint Persistence

Whenever something changes that a future session would need to know, persist it without being asked: update the relevant note, today's daily note, and (only for a new always-on rule) CLAUDE.md. Then scan the touched folder's index and any cross-referenced notes for drift and fix it in the same pass.

### Daily Notes

Live in `01 - Daily Notes/`, in monthly subfolders (`01 - Daily Notes/08 - August 2026/`). Filename `YYYY-MM-DD.md`. Frontmatter `status: active`, `project: personal`, `type: log`. Start the body with a date heading (`# Monday, June 8, 2026`), then an **`## Index`** block (one bold-topic line per session with a one-sentence outcome), then the entry body from `01 - Daily Notes/Daily Note Template.md`. Create every daily note FROM the template; never hand-roll one. If today's note exists, append a new `## Session N` — don't overwrite.

At the start of every conversation, after reading this index, check yesterday's daily note. If it doesn't exist and you have context for that day, create it from what you have and say it's reconstructed. Zero context → assume a day off and skip it.

### Living Profile

Update the profile sections above (Who I Am, Key People, How I Think, Projects) as you learn new things through conversation. Log every profile update in the daily note's "Profile Updates" section.
