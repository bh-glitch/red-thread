from fastapi.testclient import TestClient
from backend import engine, progress
from backend.main import app, sessions


def test_saved_progress_restores_histories_evidence_actor_memory_and_authorized_audio(tmp_path, monkeypatch):
    monkeypatch.setenv('LEDGER_SESSION_DB', str(tmp_path / 'progress.sqlite3'))
    s = engine.Session(visited=['sam'], evidence=['transaction_sheet'], active='sam')
    s.histories['sam'] = [{'role': 'user', 'content': 'Tell me more.'}, {'role': 'assistant', 'content': 'I’m listening.'}]
    s.interview_memory['sam'] = {'turns': 2, 'secret_revealed': True}
    engine.remember_speech(s, 'sam', 'I’m listening.')
    progress.save('player-a', s)
    restored = progress.load('player-a')
    assert restored is not s and restored.lock is not s.lock
    assert restored.evidence == s.evidence and restored.histories == s.histories
    assert restored.interview_memory == s.interview_memory and restored.utterances == s.utterances
    assert progress.load('player-b') is None
    assert (tmp_path / 'progress.sqlite3').stat().st_mode & 0o777 == 0o600


def test_cookie_recovers_progress_after_in_memory_restart_and_reset_persists(tmp_path, monkeypatch):
    monkeypatch.setenv('LEDGER_SESSION_DB', str(tmp_path / 'progress.sqlite3'))
    with TestClient(app) as c:
        c.get('/case/load'); c.post('/call/sam/start')
        cookie = c.cookies['ledger_session']
        c.post('/call/sam/say', json={'message': 'Send the transaction sheet.'})
        sessions.clear()  # simulate a new backend process using the same local save
        case = c.get('/case/load').json()
        assert c.cookies['ledger_session'] == cookie
        assert case['state']['evidence'] == ['transaction_sheet']
        assert sessions[cookie].histories['sam']
        c.post('/reset')
        sessions.clear()
        assert c.get('/case/load').json()['state']['evidence'] == []
        assert sessions[cookie].histories['sam'] == []
