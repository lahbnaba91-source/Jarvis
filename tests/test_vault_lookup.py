"""Tests for scripts/vault-lookup/lookup.py — the note resolver CLAUDE.md
tells every session to run first."""
import json
import subprocess
import sys


def test_build_index_reads_frontmatter_and_flags_jobs(lookup_mod, lookup_vault):
    notes, _by_title = lookup_mod.build_index(lookup_vault)
    by_path = {n["path"]: n for n in notes}

    assert "Jobs/Write The Weekly Email.md" in by_path
    job = by_path["Jobs/Write The Weekly Email.md"]
    assert job["type"] == "job"
    assert job["project"] == "comms"
    assert job["is_job"] is True

    # A note VAULT-INDEX.md wikilinks is marked as canonically pointed-to.
    assert by_path["Active Priorities.md"]["linked_from_root_index"] is True


def test_exact_job_title_returns_its_boot_chain(lookup_mod, lookup_vault):
    res = lookup_mod.lookup("write the weekly email", vault=lookup_vault)

    assert res["mode"] == "job_boot_chain"
    assert res["matched_job"] == "Write The Weekly Email"
    assert res["confidence"] >= 0.55

    chain = [n["path"] for n in res["notes"]]
    assert chain[0] == "Jobs/Write The Weekly Email.md"
    assert "05 - Resources/Weekly Email.md" in chain
    assert "Jobs/Email Template.md" in chain


def test_unrelated_query_falls_back_to_ranked_search(lookup_mod, lookup_vault):
    res = lookup_mod.lookup("provision the kubernetes cluster quxx", vault=lookup_vault)
    assert res["mode"] == "ranked_search"


def test_stopwords_are_dropped_from_query_tokens(lookup_mod):
    assert lookup_mod.tokenize_query("what is active right now") == ["active"]


def test_cli_json_output_is_valid_and_matches(lookup_script, lookup_vault):
    r = subprocess.run(
        [sys.executable, lookup_script, "write the weekly email",
         "--json", "--vault", lookup_vault],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["mode"] == "job_boot_chain"
    assert data["matched_job"] == "Write The Weekly Email"


def test_cli_requires_a_query_or_rebuild_check(lookup_script):
    r = subprocess.run([sys.executable, lookup_script], capture_output=True, text=True)
    assert r.returncode != 0
