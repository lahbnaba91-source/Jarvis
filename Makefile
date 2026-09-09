# Jarvis — one verb per action. These targets run the SAME commands CI runs
# (.github/workflows/ci.yml), so "passes locally" and "passes CI" can't drift.
.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help bootstrap dev format \
        test test-badge test-next test-barehands test-python \
        lint lint-next lint-python lint-shell

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

bootstrap: ## First-time / rebuild setup (interactive — prompts for secrets)
	bash scripts/install-prereqs.sh
	bash scripts/bootstrap.sh

dev: ## Bring the always-on services up (ai-visualizer, jarvis-voice, barehands)
	bash scripts/start-all.sh

## ---- tests -----------------------------------------------------------------

test: test-badge test-barehands test-python ## Run every fast test suite
	@echo "OK: all suites passed"

test-badge: ## BADGE dose-engine suite (builds the native PARMA driver first)
	cd services/badge && bash engine/native/build.sh && npm test

test-barehands: ## barehands gesture + smoothing tests
	cd barehands && node test/test-smoothing.js && node test/test-gestures.js

test-python: ## Python tests (vault tooling)
	pytest

test-next: ## Site Analyzer: typecheck + lint + build (heavy — needs `npm ci` in next-app/)
	cd next-app && npm run typecheck && npm run lint && npm run build

## ---- lint ----------------------------------------------------------------

lint: lint-python lint-shell ## Lint everything that doesn't need node_modules
	@echo "OK: lint clean"

lint-python: ## ruff check (lint only — formatting is a separate, opt-in pass)
	ruff check .

format: ## Reformat first-party Python with ruff (writes files)
	ruff format .

lint-shell: ## shellcheck every tracked shell script (error severity, matches CI)
	shellcheck -S error $$(git ls-files '*.sh')

lint-next: ## eslint (needs `npm ci` in next-app/)
	cd next-app && npm run lint
