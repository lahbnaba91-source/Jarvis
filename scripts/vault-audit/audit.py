#!/usr/bin/env python3
"""Vault self-audit for the HQ vault: detect structural drift the
checkpoint discipline is supposed to prevent but can't guarantee across
sessions -- broken wikilinks, folder-index drift, missing frontmatter,
orphan notes, and daily notes that don't match the template.

This script is READ-ONLY against the vault. It parses the same
frontmatter / wikilink structure the vault already enforces (the exact
parsing lookup.py uses), scores nothing, fixes nothing, and writes a
single report to `07 - Systems Status/Vault Audit.md`. Applying the safe
fixes is a judgment call left to a Jarvis session reading that report --
a dumb script editing vault markdown unsupervised is how the vault drifts
wrong, not right.

No dependencies. Pure stdlib.

Usage:
    audit.py                 # write the report, print a summary
    audit.py --json          # also dump findings as JSON to stdout
    audit.py --no-write      # print only, don't touch the report file
    audit.py --vault PATH    # audit a different vault root (testing)

Exit code: 0 if the vault is clean, 1 if any finding was recorded, 2 on
a usage/IO error.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    PACIFIC = ZoneInfo("America/Tijuana")
except Exception:  # zoneinfo missing or no tz database -- fall back to naive
    PACIFIC = None

VAULT = "/workspaces/Jarvis/HQ"
REPORT_REL = "07 - Systems Status/Vault Audit.md"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\]\n]+?)\]\]")
FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")

# The vault's own rules and guide notes discuss wikilinks by showing
# `[[old name]]`, `[[wikilinks]]` etc. as inline-code examples -- those
# are documentation, not links. Stripping fenced AND inline code before
# the wikilink scan keeps them out of the broken-link report.

# Daily notes are an append-only historical log (CLAUDE.md: never de-dupe
# across days). Their links rot by design -- a note referenced in an
# August daily note and deleted since is expected, not a defect -- and
# the folder deliberately has no index. Both checks skip this subtree.
DAILY_DIR = "01 - Daily Notes"

# Directories under the vault root that are not notes.
SKIP_DIRS = {".obsidian", ".trash", ".git"}

# Notes that are legitimately not linked from anywhere and must not be
# reported as orphans: the root index, and the daily-note template.
ORPHAN_EXEMPT_RELS = {"VAULT-INDEX.md", "README.md"}

# Headings every daily note carries, straight from Daily Note Template.md.
DAILY_REQUIRED_HEADINGS = ["## Index", "### What Got Done",
                           "### What's Still In Progress", "### Decisions Made",
                           "### Notes Touched"]
DAILY_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")
TEMPLATE_BASENAME = "daily note template"


def now_pacific():
    dt = datetime.now(PACIFIC) if PACIFIC else datetime.now()
    return dt.strftime("%Y-%m-%d %H:%M %Z").strip()


def strip_code(text):
    """Drop fenced and inline code so a ``` block or a `[[example]]`
    written as documentation can't register as a wikilink."""
    return INLINE_CODE_RE.sub("", FENCE_RE.sub("", text))


def link_target(raw):
    """`Foo`, `Foo|bar`, `Foo#heading`, `Foo#^block` -> `foo` (the note
    name Obsidian resolves by). Returns '' for a pure in-note anchor
    like `#heading`."""
    name = raw.split("|", 1)[0].split("#", 1)[0].strip()
    return name.lower()


def parse_frontmatter(text):
    return FRONTMATTER_RE.match(text)


def first_heading(body):
    m = HEADING_RE.search(body)
    return m.group(1).strip() if m else None


def folder_index_basename(dirname):
    """`07 - Systems Status` -> `systems status`; `Jarvis Systems` ->
    `jarvis systems`. The index note for a folder is the .md file whose
    name is the folder name with any leading `NN - ` stripped."""
    return re.sub(r"^\d+\s*-\s*", "", dirname).strip().lower()


def build_index(vault):
    """Walk the vault once. Return a list of note dicts and a
    basename->note map for wikilink resolution."""
    notes = []
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            if not fname.endswith(".md"):
                continue
            path = os.path.join(root, fname)
            rel = os.path.relpath(path, vault)
            if rel == REPORT_REL:
                continue  # our own generated output -- not an authored note
            try:
                with open(path, "r", encoding="utf-8") as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            basename = os.path.splitext(fname)[0]
            fm = parse_frontmatter(text)
            body = text[fm.end():] if fm else text
            no_code = strip_code(text)
            links = []
            for m in WIKILINK_RE.finditer(no_code):
                tgt = link_target(m.group(1))
                if tgt:
                    links.append(tgt)
            notes.append({
                "path": rel,
                "abspath": path,
                "dir": os.path.dirname(rel),
                "basename": basename,
                "basename_lc": basename.lower(),
                "fname": fname,
                "has_frontmatter": fm is not None,
                "title": first_heading(body) or basename,
                "links": list(dict.fromkeys(links)),
                "raw_links": [m.group(1).strip()
                              for m in WIKILINK_RE.finditer(no_code)],
                "text": text,
                "headings_blob": no_code,
            })
    by_name = {}
    for n in notes:
        by_name.setdefault(n["basename_lc"], n)
    return notes, by_name


def audit(vault):
    notes, by_name = build_index(vault)
    findings = {
        "broken_wikilinks": [],
        "index_drift": [],
        "missing_frontmatter": [],
        "orphans": [],
        "daily_note_shape": [],
    }

    known_names = set(by_name.keys())
    # The generated report is excluded from the scan as an authored note but
    # is a real file in the folder -- the folder index legitimately links it.
    known_names.add(os.path.splitext(os.path.basename(REPORT_REL))[0].lower())

    # --- broken wikilinks -------------------------------------------------
    for n in notes:
        if n["path"].startswith(DAILY_DIR + os.sep):
            continue  # historical log -- link rot is expected here
        seen = set()
        for raw in n["raw_links"]:
            tgt = link_target(raw)
            if not tgt or tgt in seen:
                continue
            seen.add(tgt)
            if tgt not in known_names:
                findings["broken_wikilinks"].append({
                    "note": n["path"],
                    "link": raw.strip(),
                })

    # --- folder-index drift --------------------------------------------------
    # Group notes by their containing directory. A directory that holds an
    # index note (basename == de-numbered folder name) should wikilink
    # every other .md directly in it, plus every immediate subfolder's
    # index note.
    by_dir = {}
    for n in notes:
        by_dir.setdefault(n["dir"], []).append(n)

    dirs_with_notes = set(by_dir.keys())
    for d, members in by_dir.items():
        if d == "":
            continue  # vault root: VAULT-INDEX.md is the map, handled elsewhere
        if d == DAILY_DIR or d.startswith(DAILY_DIR + os.sep):
            continue  # daily notes deliberately have no folder index
        folder_name = os.path.basename(d)
        want = folder_index_basename(folder_name)
        index_note = next((m for m in members if m["basename_lc"] == want), None)
        if index_note is None:
            if folder_name.lower() == "jobs":
                continue  # a Jobs folder holds Job notes, not a folder index
            findings["index_drift"].append({
                "folder": d,
                "issue": "no index note",
                "detail": f"expected a note named '{want.title()}.md' in this folder",
            })
            continue
        linked = set(index_note["links"])
        # direct .md children, minus the index itself
        for m in members:
            if m is index_note:
                continue
            if m["basename_lc"] not in linked:
                findings["index_drift"].append({
                    "folder": d,
                    "issue": "note not in index",
                    "detail": f"{m['path']} is not wikilinked from {index_note['path']}",
                })
        # immediate subfolders that themselves contain notes
        for sub in sorted(dirs_with_notes):
            if os.path.dirname(sub) != d or sub == d:
                continue
            sub_members = by_dir.get(sub, [])
            sub_want = folder_index_basename(os.path.basename(sub))
            sub_index = next((m for m in sub_members
                              if m["basename_lc"] == sub_want), None)
            if sub_index is not None:
                # nested topic area -- parent index should point at its index
                if sub_want not in linked:
                    findings["index_drift"].append({
                        "folder": d,
                        "issue": "subfolder not in index",
                        "detail": f"subfolder '{os.path.basename(sub)}' has an "
                                  f"index note not wikilinked from {index_note['path']}",
                    })
            else:
                # index-less subfolder (e.g. Jobs) -- parent index links the
                # individual notes directly, so check each of those
                for m in sub_members:
                    if m["basename_lc"] not in linked:
                        findings["index_drift"].append({
                            "folder": d,
                            "issue": "note not in index",
                            "detail": f"{m['path']} is not wikilinked from "
                                      f"{index_note['path']}",
                        })

    # --- missing frontmatter --------------------------------------------------
    for n in notes:
        if not n["has_frontmatter"]:
            findings["missing_frontmatter"].append({"note": n["path"]})

    # --- orphans -----------------------------------------------------------
    # A note nothing points at. Excludes: the root index and README, every
    # index note (pointed at by design from parents / VAULT-INDEX), and
    # every daily note + the template (chronological log, not linked).
    inbound = set()
    for n in notes:
        for tgt in n["links"]:
            inbound.add(tgt)

    for n in notes:
        rel = n["path"]
        if rel in ORPHAN_EXEMPT_RELS:
            continue
        if rel.startswith("01 - Daily Notes" + os.sep) or n["basename_lc"] == TEMPLATE_BASENAME:
            continue
        folder_name = os.path.basename(n["dir"]) if n["dir"] else ""
        if n["basename_lc"] == folder_index_basename(folder_name):
            continue  # this note is its folder's index
        if n["basename_lc"] not in inbound:
            findings["orphans"].append({"note": rel})

    # --- daily-note shape --------------------------------------------------
    for n in notes:
        if not n["path"].startswith("01 - Daily Notes" + os.sep):
            continue
        if not DAILY_NAME_RE.match(n["fname"]):
            continue
        missing = [h for h in DAILY_REQUIRED_HEADINGS
                   if h not in n["headings_blob"]]
        if missing:
            findings["daily_note_shape"].append({
                "note": n["path"],
                "missing_headings": missing,
            })

    total = sum(len(v) for v in findings.values())
    return findings, total, len(notes)


LABELS = {
    "broken_wikilinks": "Broken wikilinks",
    "index_drift": "Folder-index drift",
    "missing_frontmatter": "Missing frontmatter",
    "orphans": "Orphan notes",
    "daily_note_shape": "Daily notes off-template",
}

# Which finding types a session can safely auto-fix vs. which need a
# human-in-the-loop call. Printed in the report so the split is explicit.
SAFE_FIX = {"index_drift", "missing_frontmatter", "daily_note_shape"}


def render_report(findings, total, note_count):
    ts = now_pacific()
    lines = [
        "---",
        "status: active",
        "project: meta",
        "type: log",
        "---",
        "# Vault Audit",
        "",
        "Generated by `scripts/vault-audit/audit.py` -- **do not hand-edit, it "
        "gets overwritten every run.** This is the detector half of the vault "
        "self-audit: it finds structural drift, it does not fix it. See "
        "[[Vault Audit (vault-audit)]] for how the safe fixes get applied.",
        "",
        f"- **Last run:** {ts}",
        f"- **Notes scanned:** {note_count}",
        f"- **Findings:** {total}",
        "",
    ]

    if total == 0:
        lines += ["## Clean", "",
                  "No broken links, no index drift, no missing frontmatter, "
                  "no orphans, no off-template daily notes. Nothing to do.", ""]
        return "\n".join(lines) + "\n"

    # summary table
    lines += ["## Summary", ""]
    for key, label in LABELS.items():
        n = len(findings[key])
        tag = "safe to auto-fix" if key in SAFE_FIX else "needs a judgment call"
        lines.append(f"- **{label}:** {n}  _({tag})_")
    lines.append("")

    if findings["broken_wikilinks"]:
        lines += ["## Broken wikilinks", "",
                  "A `[[link]]` whose target note does not exist. Either the "
                  "target was renamed/deleted (fix or drop the link) or it "
                  "still needs to be written.", ""]
        for f in findings["broken_wikilinks"]:
            lines.append(f"- `{f['note']}` -> `[[{f['link']}]]`")
        lines.append("")

    if findings["index_drift"]:
        lines += ["## Folder-index drift", "",
                  "A folder's index note must wikilink every note and "
                  "subfolder in that folder -- that's the map future "
                  "sessions navigate by.", ""]
        for f in findings["index_drift"]:
            lines.append(f"- `{f['folder']}` -- {f['issue']}: {f['detail']}")
        lines.append("")

    if findings["missing_frontmatter"]:
        lines += ["## Missing frontmatter", "",
                  "Every note needs YAML frontmatter (`status` / `project` / "
                  "`type`). Values are inferred, never asked.", ""]
        for f in findings["missing_frontmatter"]:
            lines.append(f"- `{f['note']}`")
        lines.append("")

    if findings["orphans"]:
        lines += ["## Orphan notes", "",
                  "Nothing wikilinks to these and they're in no folder index. "
                  "Either wire them into the map or archive/delete them -- a "
                  "note no path leads to is a note no future session finds.", ""]
        for f in findings["orphans"]:
            lines.append(f"- `{f['note']}`")
        lines.append("")

    if findings["daily_note_shape"]:
        lines += ["## Daily notes off-template", "",
                  "Daily notes not built from `01 - Daily Notes/Daily Note "
                  "Template.md` -- missing its standard headings.", ""]
        for f in findings["daily_note_shape"]:
            miss = ", ".join(f"`{h}`" for h in f["missing_headings"])
            lines.append(f"- `{f['note']}` -- missing {miss}")
        lines.append("")

    return "\n".join(lines) + "\n"


def print_summary(findings, total, note_count):
    print(f"Vault audit: {note_count} notes scanned, {total} findings.")
    if total == 0:
        print("  clean.")
        return
    for key, label in LABELS.items():
        n = len(findings[key])
        if n:
            print(f"  {label}: {n}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", default=VAULT, help="vault root to audit")
    ap.add_argument("--json", action="store_true",
                    help="also dump findings as JSON to stdout")
    ap.add_argument("--no-write", action="store_true",
                    help="don't write the report file, print only")
    args = ap.parse_args()

    if not os.path.isdir(args.vault):
        print(f"error: vault not found: {args.vault}", file=sys.stderr)
        sys.exit(2)

    findings, total, note_count = audit(args.vault)

    if not args.no_write:
        report_path = os.path.join(args.vault, REPORT_REL)
        try:
            os.makedirs(os.path.dirname(report_path), exist_ok=True)
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(render_report(findings, total, note_count))
        except OSError as e:
            print(f"error: could not write report: {e}", file=sys.stderr)
            sys.exit(2)

    if args.json:
        print(json.dumps({"findings": findings, "total": total,
                          "notes_scanned": note_count}, indent=2))
    else:
        print_summary(findings, total, note_count)

    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
