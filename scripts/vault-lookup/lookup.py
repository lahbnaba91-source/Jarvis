#!/usr/bin/env python3
"""Deterministic note lookup for the HQ vault: given a task in plain
English, decide which note(s) to read WITHOUT an LLM wandering the vault's
indexes and wikilinks by judgment call.

Why this exists: the vault's own design (ai-memory-vault's own wizard
file) tells the AI to "start at this index, follow the folder indexes and
wikilinks, or search" -- that's free-form reasoning over markdown, done
fresh every session. It works, but it's exactly the kind of judgment call
that's cheap to make deterministic: parse the same frontmatter/wikilink
structure the vault already enforces, score matches with fixed rules, and
hand back a ranked list instead of making the model re-derive it.

No embeddings, no vector DB -- matches the vault's own "just markdown"
philosophy. Pure stdlib.

Usage:
    lookup.py "write the weekly email"        # human-readable top matches
    lookup.py "write the weekly email" --json # machine-readable
    lookup.py --rebuild-check                 # just print index stats
"""
import argparse
import difflib
import json
import os
import re
import sys

VAULT = "/workspaces/Jarvis/HQ"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)")
WORD_RE = re.compile(r"[a-z0-9]+")

# Low-signal words filtered from query scoring. Without this, common words
# collide with boilerplate template headings ("What Got Done", "What's
# Still In Progress") that repeat once per session in every daily note,
# which let a query like "what's active right now" get outscored by a
# long daily note purely on template noise -- found via live testing.
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "did", "do", "does", "for",
    "from", "get", "got", "i", "in", "is", "it", "its", "just", "me", "my",
    "need", "now", "of", "on", "or", "right", "s", "that", "the", "this",
    "to", "was", "what", "with",
}


def tokenize_query(s):
    return [t for t in WORD_RE.findall(s.lower()) if t not in STOPWORDS]


def parse_frontmatter(text):
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm, text[m.end():]


def first_heading(body):
    m = HEADING_RE.search(body)
    return m.group(1).strip() if m else None


def first_description_line(body):
    # First non-empty, non-heading line after the title heading.
    lines = body.splitlines()
    seen_title = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            if not seen_title:
                seen_title = True
                continue
            else:
                continue
        return stripped[:200]
    return ""


def tokenize(s):
    return WORD_RE.findall(s.lower())


def build_index(vault=VAULT):
    notes = []
    for root, dirs, files in os.walk(vault):
        for fname in files:
            if not fname.endswith(".md"):
                continue
            path = os.path.join(root, fname)
            rel = os.path.relpath(path, vault)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            fm, body = parse_frontmatter(text)
            title = first_heading(body) or os.path.splitext(fname)[0]
            desc = first_description_line(body)
            # Dedupe: a template's boilerplate subheadings (e.g. "What Got
            # Done") repeat once per session in a daily note, and counting
            # each repeat would let structural noise outscore real content.
            headings = list(dict.fromkeys(h.strip() for h in HEADING_RE.findall(body)))
            links = list(dict.fromkeys(WIKILINK_RE.findall(body)))  # dedupe, keep order
            is_job = "/Jobs/" in rel or rel.startswith("Jobs/")
            notes.append({
                "path": rel,
                "abspath": path,
                "title": title,
                "status": fm.get("status", ""),
                "project": fm.get("project", ""),
                "type": fm.get("type", ""),
                "description": desc,
                "headings": headings,
                "links": links,
                "is_job": is_job,
                "body_tokens": tokenize(body),
                "title_tokens": tokenize(title),
            })
    # index by title for wikilink resolution (Obsidian resolves by note name)
    by_title = {}
    for n in notes:
        key = os.path.splitext(os.path.basename(n["path"]))[0].lower()
        by_title[key] = n

    # Reverse-link map from index notes: a note that VAULT-INDEX.md or a
    # folder index explicitly wikilinks to is a canonical pointer the vault
    # itself is making, not a keyword coincidence -- weight it accordingly.
    index_linked_from_root = set()
    index_linked_from_folder = set()
    for n in notes:
        if n["type"] != "index":
            continue
        is_root = n["path"] == "VAULT-INDEX.md"
        for link in n["links"]:
            target = by_title.get(link.strip().lower())
            if not target:
                continue
            if is_root:
                index_linked_from_root.add(target["path"])
            else:
                index_linked_from_folder.add(target["path"])

    for n in notes:
        n["linked_from_root_index"] = n["path"] in index_linked_from_root
        n["linked_from_folder_index"] = n["path"] in index_linked_from_folder

    return notes, by_title


def fuzzy_ratio(a, b):
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def score_note(query_tokens, query_str, note):
    score = 0.0

    # Title match: fuzzy whole-string + token overlap
    title_fuzzy = fuzzy_ratio(query_str, note["title"])
    score += title_fuzzy * 6
    title_overlap = len(set(query_tokens) & set(note["title_tokens"]))
    score += title_overlap * 3

    # Project slug match
    if note["project"] and note["project"].lower() in query_tokens:
        score += 5

    # Heading match, capped overall so a note with many headings can't
    # win purely on heading count
    heading_score = 0
    for h in note["headings"]:
        h_tokens = tokenize(h)
        overlap = len(set(query_tokens) & set(h_tokens))
        if overlap:
            heading_score += 2 * overlap
    score += min(heading_score, 10)

    # Body keyword hits, capped so long notes don't dominate purely on length
    body_hits = sum(min(note["body_tokens"].count(t), 5) for t in set(query_tokens))
    score += min(body_hits, 20) * 0.3

    # Small boost for index notes on vague/short queries (few tokens)
    if note["type"] == "index" and len(query_tokens) <= 3:
        score += 1.5

    # Jobs are the highest-precision hit type; nudge them up slightly
    # (full boost happens in the dedicated job-match pass in `lookup`)
    if note["is_job"]:
        score += 0.5

    # A note the vault's own index explicitly points to for this kind of
    # question is a canonical signal, not a keyword coincidence -- e.g.
    # VAULT-INDEX.md saying "open work lives in [[Active Priorities]]"
    # should win even when the query's literal words don't favor it.
    if note.get("linked_from_root_index"):
        score += 8
    elif note.get("linked_from_folder_index"):
        score += 4

    return score


def resolve_boot_chain(job_note, by_title, notes_by_path):
    """A Job's boot chain = itself + every note it directly wikilinks to
    that actually exists in the vault, in link order."""
    chain = [job_note]
    seen = {job_note["path"]}
    for link in job_note["links"]:
        target = by_title.get(link.strip().lower())
        if target and target["path"] not in seen:
            chain.append(target)
            seen.add(target["path"])
    return chain


def lookup(query, vault=VAULT, top_n=8, job_threshold=0.55):
    notes, by_title = build_index(vault)
    query_tokens = tokenize_query(query)
    query_str = query.strip()

    # Pass 1: does this strongly match a Job title?
    jobs = [n for n in notes if n["is_job"]]
    best_job, best_job_score = None, 0.0
    for j in jobs:
        r = fuzzy_ratio(query_str, j["title"])
        if r > best_job_score:
            best_job, best_job_score = j, r

    if best_job and best_job_score >= job_threshold:
        chain = resolve_boot_chain(best_job, by_title, notes)
        return {
            "mode": "job_boot_chain",
            "matched_job": best_job["title"],
            "confidence": round(best_job_score, 3),
            "notes": [
                {"path": n["path"], "type": n["type"], "project": n["project"],
                 "description": n["description"]}
                for n in chain
            ],
        }

    # Pass 2: general ranked search
    scored = [(score_note(query_tokens, query_str, n), n) for n in notes]
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:top_n]
    return {
        "mode": "ranked_search",
        "notes": [
            {"path": n["path"], "type": n["type"], "project": n["project"],
             "score": round(s, 2), "description": n["description"]}
            for s, n in top if s > 0
        ],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("query", nargs="?", help="task in plain English")
    ap.add_argument("--vault", default=VAULT)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--rebuild-check", action="store_true",
                     help="just print index stats, no query")
    args = ap.parse_args()

    if args.rebuild_check:
        notes, _ = build_index(args.vault)
        jobs = [n for n in notes if n["is_job"]]
        print(f"{len(notes)} notes indexed, {len(jobs)} Jobs found.")
        for j in jobs:
            print(f"  Job: {j['title']}  ({j['path']})")
        return

    if not args.query:
        ap.error("query required unless --rebuild-check is passed")

    result = lookup(args.query, vault=args.vault, top_n=args.top)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    if result["mode"] == "job_boot_chain":
        print(f"Matched Job: \"{result['matched_job']}\" (confidence {result['confidence']})")
        print("Boot chain (read in this order):")
        for i, n in enumerate(result["notes"], 1):
            print(f"  {i}. {n['path']}  [{n['type']}]")
            if n["description"]:
                print(f"     {n['description']}")
    else:
        if not result["notes"]:
            print("No matches.")
            return
        print(f"Top matches for: \"{args.query}\"")
        for n in result["notes"]:
            print(f"  {n['score']:5.2f}  {n['path']}  [{n['type']}/{n['project']}]")
            if n["description"]:
                print(f"          {n['description']}")


if __name__ == "__main__":
    main()
