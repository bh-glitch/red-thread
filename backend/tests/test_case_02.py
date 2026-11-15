"""Case 002 · Seven Minutes in the Dark — plays end to end in offline demo mode."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import director, engine
from backend.main import app


def events(response):
    out = []
    for block in response.text.strip().split('\n\n'):
        lines = dict(line.split(': ', 1) for line in block.split('\n') if ': ' in line)
        if 'event' in lines:
            out.append((lines['event'], json.loads(lines['data'])))
    return out


@pytest.fixture
def game():
    with TestClient(app) as c:
        data = c.post('/case/select', json={'case_id': 'case_02'}).json()
        assert data['id'] == 'case_02'
        yield c


def test_both_cases_are_listed_and_switchable():
    with TestClient(app) as c:
        listed = c.get('/cases').json()['cases']
        assert [x['id'] for x in listed] == ['case_01', 'case_02']
        assert c.post('/case/select', json={'case_id': 'case_02'}).json()['title'] == 'Seven Minutes in the Dark'
        assert c.post('/reset', json={}).json()['id'] == 'case_02'  # reset keeps the case
        assert c.post('/case/select', json={'case_id': 'case_01'}).json()['id'] == 'case_01'
        assert c.post('/case/select', json={'case_id': 'nope'}).status_code == 404


def test_public_case_keeps_secrets_server_side(game):
    data = game.get('/case/load').json()
    assert [p['id'] for p in data['suspects']] == ['noah', 'maya', 'oliver', 'zara']
    assert all('private' not in p for p in data['suspects'])
    assert data['missing_person']['name'] == 'Ethan Walker'
    assert data['cross_pair'] == ['oliver', 'zara']
    # Evidence cards stay hidden until found.
    assert all('card' not in ev for ev in data['evidence_catalog'])
    text = json.dumps(data)
    assert 'Adrian' not in text and 'Lake Harmony' not in text and 'is_guilty' not in text


def test_case_01_people_are_not_on_case_02(game):
    assert game.post('/call/priya/start', json={'voice': False}).status_code == 404


def test_full_investigation_ends_in_oliver_breaking(game):
    def ask(sid, message):
        game.post(f'/call/{sid}/start', json={'voice': False})
        done = events(game.post(f'/call/{sid}/say', json={'message': message, 'voice': False}))
        game.post('/hangup', json={})
        return done

    # Maya hands over Ethan's account history; Zara the house log.
    got = ask('maya', 'Did Ethan send you anything about his money?')
    assert ('evidence_unlocked', {'type': 'evidence_unlocked', 'id': 'account_history'}) in got
    got = ask('zara', 'Can you get the house records from the host app?')
    assert ('evidence_unlocked', {'type': 'evidence_unlocked', 'id': 'house_log'}) in got

    data = game.get('/case/load').json()
    assert {ev['id'] for ev in data['evidence_catalog'] if 'card' in ev} == {'account_history', 'house_log'}
    assert len(data['links']) == 2
    doc = game.get('/evidence/house_log').json()
    assert any('Front door' in row['device'] for row in doc['log'])
    assert game.get('/evidence/account_history').json()['transactions'][-1]['amount'] == -25000

    # Oliver vs Zara: the log breaks his alibi and, with both clues found, he folds.
    cross = events(game.post('/cross', json={'suspects': ['oliver', 'zara'], 'voice': False}))
    kinds = [kind for kind, _ in cross]
    assert 'contradiction' in kinds
    confession = [d for kind, d in cross if kind == 'statement' and d['suspect_id'] == 'oliver'][-1]['text']
    assert '25,000' in confession and 'Adrian' in confession

    verdict = game.post('/guess', json={'suspect_id': 'oliver'}).json()
    assert verdict['correct'] is True
    reveal = game.get('/reveal').json()
    assert reveal['guilty_id'] == 'oliver'
    assert [row['amount'] for row in reveal['transactions']] == [-25000]


def test_wrong_accusation(game):
    assert game.post('/guess', json={'suspect_id': 'noah'}).json()['correct'] is False


def test_director_rules_for_case_02():
    s = engine.Session(case_id='case_02')
    # Oliver keeps his cover before both clues are put to him…
    turn = director.prepare(s, 'oliver', 'Where were you during the blackout?')
    assert not turn.confession_allowed
    with pytest.raises(ValueError):
        director.validate(turn, director.ActorReply(reply='Fine, I sent the money from my laptop.', stance='defend', actions=[]))
    # …and innocent friends can't name the accomplice.
    turn = director.prepare(s, 'noah', 'Who took him?')
    with pytest.raises(ValueError):
        director.validate(turn, director.ActorReply(reply='I bet Adrian took him.', stance='defend', actions=[]))
    # With both clues presented, the gate opens and a confession is required.
    s.evidence = ['account_history', 'house_log']
    director.prepare(s, 'oliver', 'Explain this.', 'account_history')
    turn = director.prepare(s, 'oliver', 'And this.', 'house_log')
    assert turn.confession_required
    reply = director.fallback(turn)
    assert director.validate(turn, reply).stance == 'confess'


def test_secrets_unlock_and_fallbacks_validate():
    s = engine.Session(case_id='case_02')
    for sid, question in [('noah', 'Did you owe Ethan money? Any debt?'), ('maya', 'Did he text you? Did you delete a message?'), ('zara', 'Did Ethan give you a gift? How close are you?')]:
        director.prepare(s, sid, question)
        turn = director.prepare(s, sid, question)
        assert turn.secret_required, sid
        assert director.validate(turn, director.fallback(turn)).stance == 'admit_secret'


def test_saves_remember_the_case(monkeypatch, tmp_path):
    from backend import progress
    monkeypatch.setenv('LEDGER_SESSION_DB', str(tmp_path / 'p.sqlite3'))
    s = engine.Session(case_id='case_02', visited=['zara'])
    progress.save('key', s)
    restored = progress.load('key')
    assert restored.case_id == 'case_02' and restored.visited == ['zara']
    assert set(restored.pressure) == {'noah', 'maya', 'oliver', 'zara'}


@pytest.mark.parametrize('text', [
    "I suppose there is no sense keeping up the sleep story now. I triggered the breaker to drop the power at 11:47, logged in with Ethan's saved credentials to move the funds, and unlocked the door for Adrian Cole.",
    "Fine. I cut the power, I used his credentials to transfer the money, and I let Adrian in. Ethan is safe at a rental near Lake Harmony, but it's over.",
])
def test_natural_confessions_are_accepted(text):
    # Real Gemini confessions that an over-strict check once rejected
    # ("power" contains "owe"; the verb came many words after "I").
    s = engine.Session(case_id='case_02', evidence=['account_history', 'house_log'])
    s.presented['oliver'] = ['account_history', 'house_log']
    turn = director.prepare(s, 'oliver', 'Explain the contradiction.')
    assert director.validate(turn, director.ActorReply(reply=text, stance='confess', actions=['confess']))


def test_noah_secret_still_sealed_but_power_is_not_owe():
    s = engine.Session(case_id='case_02')
    turn = director.prepare(s, 'oliver', 'Where were you?')
    with pytest.raises(ValueError):
        director.validate(turn, director.ActorReply(reply='Noah borrowed money from him and never paid it back.', stance='defend', actions=[]))
    director.validate(turn, director.ActorReply(reply='The power went out and I slept through it. Money? I have no idea.', stance='defend', actions=[]))
