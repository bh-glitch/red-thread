.PHONY: dev setup test build seed serve voice-setup voice-check local-setup

dev:
	python3 scripts/dev.py

setup:
	python3 scripts/dev.py --setup

test:
	.venv/bin/python -m pytest backend/tests -q
	npm test

build:
	npm run build

seed:
	.venv/bin/python -m backend.scripts.seed_nessie

serve: build
	.venv/bin/python -m uvicorn backend.main:production_app --host 127.0.0.1 --port 8000

voice-setup:
	.venv/bin/python -m backend.scripts.configure_voice

voice-check:
	.venv/bin/python -m backend.scripts.check_voice

local-setup: setup
