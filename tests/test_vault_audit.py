"""Tests for scripts/vault-audit/audit.py — the read-only vault
structural-drift detector."""
import subprocess
import sys


def test_broken_wikilink_is_detected(audit_mod, messy_vault):
    findings, total, _count = audit_mod.audit(messy_vault)
    broken = [f["link"] for f in findings["broken_wikilinks"]]
    assert "Ghost Note" in broken
    assert total > 0


def test_missing_frontmatter_is_detected(audit_mod, messy_vault):
    findings, _total, _count = audit_mod.audit(messy_vault)
    notes = [f["note"] for f in findings["missing_frontmatter"]]
    assert "No Frontmatter.md" in notes


def test_orphan_note_is_detected(audit_mod, messy_vault):
    findings, _total, _count = audit_mod.audit(messy_vault)
    orphans = [f["note"] for f in findings["orphans"]]
    assert "No Frontmatter.md" in orphans


def test_cli_exits_1_when_findings_exist(audit_script, messy_vault):
    r = subprocess.run(
        [sys.executable, audit_script, "--no-write", "--vault", messy_vault],
        capture_output=True, text=True,
    )
    assert r.returncode == 1


def test_cli_exits_2_on_missing_vault(audit_script, tmp_path):
    r = subprocess.run(
        [sys.executable, audit_script, "--no-write", "--vault", str(tmp_path / "nope")],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
