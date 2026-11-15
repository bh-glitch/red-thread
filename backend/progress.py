"""Local, per-player SQLite saves. No prompts, keys, or shared character memory."""
from __future__ import annotations

from dataclasses import fields
import json
import os
from pathlib import Path
import sqlite3
import time
from .engine import CASES, Session

DEFAULT_PATH = Path(__file__).parent / 'data/player_progress.sqlite3'


def connection():
    configured = os.getenv('LEDGER_SESSION_DB')
    if configured == '':
        return None
    path = Path(configured) if configured else DEFAULT_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    path.chmod(0o600)
    db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated REAL NOT NULL, payload TEXT NOT NULL)')
    return db


def encode(state: Session):
    data = {f.name: getattr(state, f.name) for f in fields(state) if f.name not in ('lock', 'touched', 'utterances')}
    data['utterances'] = [[sid, text, delivery] for (sid, text), delivery in state.utterances.items()]
    return json.dumps({'version': 1, 'case_id': state.case_id, 'state': data}, ensure_ascii=False)


def decode(payload: str):
    saved = json.loads(payload)
    if saved['version'] != 1 or saved['case_id'] not in CASES:
        return None
    data = saved['state']
    state = Session(case_id=saved['case_id'])
    for field in fields(state):
        if field.name not in ('lock', 'touched', 'utterances') and field.name in data:
            setattr(state, field.name, data[field.name])
    state.utterances = {(sid, text): delivery for sid, text, delivery in data.get('utterances', [])}
    return state


def load(key: str | None):
    if not key:
        return None
    db = connection()
    if db is None:
        return None
    try:
        row = db.execute('SELECT payload FROM sessions WHERE id = ? AND updated > ?', (key, time.time() - 7200)).fetchone()
        return decode(row[0]) if row else None
    finally:
        db.close()


def save(key: str, state: Session):
    db = connection()
    if db is None:
        return
    try:
        with db:
            db.execute('DELETE FROM sessions WHERE updated < ?', (time.time() - 7200,))
            db.execute('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)', (key, time.time(), encode(state)))
    finally:
        db.close()
