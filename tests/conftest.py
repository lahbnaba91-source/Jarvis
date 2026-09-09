"""Shared fixtures. The two vault scripts live in hyphenated directories
(`scripts/vault-lookup/`, `scripts/vault-audit/`) that aren't importable as
packages, so load them by path."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, ROOT / relpath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="session")
def lookup_mod():
    return _load("vault_lookup", "scripts/vault-lookup/lookup.py")


@pytest.fixture(scope="session")
def audit_mod():
    return _load("vault_audit", "scripts/vault-audit/audit.py")


@pytest.fixture(scope="session")
def lookup_script():
    return str(ROOT / "scripts" / "vault-lookup" / "lookup.py")


@pytest.fixture(scope="session")
def audit_script():
    return str(ROOT / "scripts" / "vault-audit" / "audit.py")


@pytest.fixture(scope="session")
def lookup_vault():
    return str(FIXTURES / "lookup_vault")


@pytest.fixture(scope="session")
def messy_vault():
    return str(FIXTURES / "messy_vault")
