import json
from contextlib import contextmanager
import pytest
from fastapi.testclient import TestClient
from backend.main import app, production_app, frontend_dist
from backend.ai import character_prompt
from backend.engine import Session, scripted_reply


@contextmanager
def client():
    with TestClient(app) as c:
        c.get('/case/load')
        yield c


def say(c, sid, message, evidence_id=None):
    body = {'message': message}
    if evidence_id:
        body['evidence_id'] = evidence_id
    response = c.post(f'/call/{sid}/say', json=body)
    assert response.status_code == 200, response.text
    return response.text


def clues(c):
    c.post('/call/sam/start')
    say(c, 'sam', 'Send me the transaction sheet')
    c.post('/call/marcus/start')
    say(c, 'marcus', 'What did you see that night?')


def test_no_private_case_fields_or_earned_links_on_load():
    with client() as c:
        response = c.get('/case/load').json()
        raw = json.dumps(response).lower()
        for field in ['is_guilty', 'secret', 'truth_timeline', 'breaking_point', 'cliffhanger']:
            assert field not in raw
        assert response['links'] == []
        assert response['state']['evidence'] == []
        assert response['state']['notes'] == []
        assert len(response['suspects']) == 5
        assert len(response['evidence_catalog']) == 2
        assert c.get('/reveal').status_code == 403


def test_locked_documents_cannot_be_fetched_or_presented():
    with client() as c:
        assert c.get('/evidence/transaction_sheet').status_code == 403
        c.post('/call/priya/start')
        response = c.post('/call/priya/say', json={'message': 'confess', 'evidence_id': 'transaction_sheet'})
        assert response.status_code == 403


def test_demo_path_sse_evidence_cross_guess_reveal():
    with client() as c:
        c.post('/call/sam/start')
        result = say(c, 'sam', 'Send me the transaction sheet')
        assert 'event: token' in result
        assert 'event: evidence_unlocked' in result
        assert 'event: done' in result
        sheet = c.get('/evidence/transaction_sheet').json()
        assert sum(row['amount'] for row in sheet['transactions']) == 48750
        assert {row['display_time'] for row in sheet['transactions']} == {'11:52 PM'}
        assert sheet['provenance'] in ('fixture', 'nessie')
        c.post('/call/marcus/start')
        assert 'event: evidence_unlocked' in say(c, 'marcus', 'What did you see that night?')
        case = c.get('/case/load').json()
        assert len(case['links']) == 2
        assert len(case['state']['notes']) >= 4
        response = c.post('/cross', json={'suspects': ['priya', 'marcus']})
        assert response.status_code == 200
        assert 'event: contradiction' in response.text
        assert 'I created Northshore' in response.text
        c.post('/call/priya/start')
        assert 'I set up Northshore' in say(c, 'priya', 'Explain this')
        verdict = c.post('/guess', json={'suspect_id': 'priya'}).json()
        assert verdict['correct'] is True
        reveal = c.get('/reveal').json()
        assert reveal['guilty_id'] == 'priya'
        assert len(reveal['truth_timeline']) == 4
        assert 'someone else' in reveal['cliffhanger']


def test_confession_requires_both_presented_not_merely_unlocked():
    with client() as c:
        clues(c)
        c.post('/call/priya/start')
        reply = say(c, 'priya', 'Confess right now')
        assert 'I set up Northshore' not in reply
        assert 'I set up Northshore' not in say(c, 'priya', 'Explain this', 'transaction_sheet')
        assert 'I set up Northshore' in say(c, 'priya', 'And this?', 'eyewitness')


def test_cross_requires_two_interviews_and_earned_witness():
    with client() as c:
        assert c.post('/cross', json={'suspects': ['priya', 'marcus']}).status_code == 403
        c.post('/call/sam/start'); c.post('/call/marcus/start')
        response = c.post('/cross', json={'suspects': ['priya', 'marcus']})
        assert 'event: contradiction' not in response.text
        assert 'I created Northshore' not in response.text
        assert c.post('/cross', json={'suspects': ['sam', 'sam']}).status_code == 422
        assert c.post('/cross', json={'suspects': ['sam', 'unknown']}).status_code == 404


def test_wrong_guess_is_final_but_still_allows_reveal():
    with client() as c:
        result = c.post('/guess', json={'suspect_id': 'sam'}).json()
        assert result['correct'] is False
        assert result['stamp'] == 'WRONG SUSPECT'
        assert c.post('/guess', json={'suspect_id': 'priya'}).status_code == 409
        assert c.get('/reveal').status_code == 200
        assert c.post('/call/sam/start').status_code == 409


def test_reset_relocks_reveal_and_clears_progress():
    with client() as c:
        clues(c)
        c.post('/guess', json={'suspect_id': 'priya'})
        state = c.post('/reset').json()['state']
        assert not state['visited'] and not state['notes'] and not state['evidence'] and not state['log']
        assert not state['guessed']
        assert c.get('/reveal').status_code == 403
        assert c.get('/evidence/transaction_sheet').status_code == 403


def test_sessions_are_isolated():
    with client() as a:
        clues(a)
        # Do not enter a second lifespan while the first TestClient is active.
        b = TestClient(app)
        try:
            b.get('/case/load')
            assert b.get('/evidence/transaction_sheet').status_code == 403
            assert len(a.get('/case/load').json()['state']['evidence']) == 2
            a.post('/guess', json={'suspect_id': 'priya'})
            assert b.get('/reveal').status_code == 403
        finally:
            b.close()


@pytest.mark.parametrize('message,intent,sid', [
    ('call Sam', 'call', 'sam'), ('phone Samm', 'call', 'sam'),
    ('talk to Nair', 'call', 'priya'), ('call Marcus', 'call', 'marcus'),
    ('hang up', 'hangup', None), ('hint', 'hint', None),
    ('cross examine Priya and Marcus', 'cross', None), ('guess Priya', 'guess', 'priya'),
    ('call the bookkeeper', 'call', 'sam'), ('call the owner', 'call', 'elena'),
    ('call the IT contractor', 'call', 'theo'), ('call Elena', 'call', 'elena'),
])
def test_command_routing(message, intent, sid):
    with client() as c:
        result = c.post('/command', json={'message': message}).json()
        assert result['intent'] == intent
        if sid:
            assert result['suspect_id'] == sid


def test_hints_escalate_then_repeat_last():
    with client() as c:
        hints = [c.post('/hint').json() for _ in range(4)]
        assert [h['level'] for h in hints] == [1, 2, 3, 3]
        assert len(set(h['text'] for h in hints)) == 3


def test_only_active_person_can_receive_questions():
    with client() as c:
        assert c.post('/call/priya/say', json={'message': 'hello'}).status_code == 409
        c.post('/call/sam/start')
        assert c.post('/call/priya/say', json={'message': 'hello'}).status_code == 409


@pytest.mark.parametrize('question', [
    'Did you call Priya last night?',
    'Can you help me understand these records?',
    'What does your interview note mean?',
    'Why would I accuse Marcus?',
    'Did Elena ask you to hang up?',
    'Were you on the phone with Sam?',
])
def test_interview_questions_do_not_trigger_board_commands(question):
    with client() as c:
        c.post('/call/sam/start')
        route = c.post('/command', json={'message': question}).json()
        assert route == {'intent': 'say', 'suspect_id': 'sam', 'message': question}
        assert c.post('/call/sam/say', json={'message': question}).status_code == 200


@pytest.mark.parametrize('command', ['hang up', 'Please end the call.', 'back to the board'])
def test_explicit_voice_hangup_still_works_inside_an_interview(command):
    with client() as c:
        c.post('/call/sam/start')
        assert c.post('/command', json={'message': command}).json()['intent'] == 'hangup'


def test_live_prompt_omits_guilty_secret_until_breaking_point():
    s = Session()
    prompt = character_prompt(s, 'priya')
    assert 'Created Northshore' not in prompt
    assert 'another person approved' not in prompt.lower()
    assert 'shell vendor' not in prompt
    s.presented['priya'] = ['transaction_sheet', 'eyewitness']
    assert 'shell vendor' in character_prompt(s, 'priya')


def test_suspects_do_not_receive_each_others_private_slices():
    s = Session()
    prompt = character_prompt(s, 'sam').lower()
    assert 'dented' not in prompt
    assert 'shell vendor' not in prompt
    assert 'sam okafor' in prompt
    assert 'job interview at a competing bakery' not in prompt


def test_innocents_explain_unrelated_secrets():
    s = Session()
    reply, _ = scripted_reply(s, 'sam', 'Where were you Tuesday?', None)
    assert 'job interview' in reply
    reply, _ = scripted_reply(s, 'marcus', 'Did you dent the van?', None)
    assert 'dented' in reply


def test_pressure_changes_delivery_without_skipping_confession_gate():
    s = Session()
    replies = [scripted_reply(s, 'priya', 'Marcus says your office was lit at 11:52', None)[0] for _ in range(8)]
    assert any('I-I mean' in reply for reply in replies)
    assert not any('I set up Northshore' in reply for reply in replies)
    assert s.pressure['priya'] == 1
    scripted_reply(s, 'priya', 'How are you?', None)
    assert s.pressure['priya'] < 1


@pytest.mark.skipif(not frontend_dist.is_dir(), reason='Run make build for the production static-file smoke test.')
def test_production_mount_serves_game_and_restricts_private_files():
    c = TestClient(production_app)
    try:
        assert c.get('/').status_code == 200
        assert c.get('/api/case/load').status_code == 200
        assert c.get('/api/reveal').status_code == 403
        assert c.get('/backend/cases/case_01.json').status_code == 404
        assert c.get('/.env').status_code == 404
    finally:
        c.close()


def test_added_contacts_have_independent_alibis_and_do_not_receive_priyas_dialogue():
    with client() as c:
        public = c.get('/case/load').json()
        assert {p['id'] for p in public['suspects']} == {'sam', 'marcus', 'priya', 'elena', 'theo'}
        assert all(len(p['questions']) == 2 for p in public['suspects'])
        c.post('/call/elena/start')
        reply = say(c, 'elena', 'What are you hiding from the staff?')
        assert 'overdue rent' in reply and 'home asleep by ten' not in reply
        c.post('/call/theo/start')
        reply = say(c, 'theo', 'What did you use the server for?')
        assert 'freelance project' in reply and 'home asleep by ten' not in reply
        assert len(c.get('/case/load').json()['state']['evidence']) == 0
        result = c.post('/cross', json={'suspects': ['elena', 'theo']})
        assert 'Home with my daughter' in result.text
        assert 'maintenance connection' in result.text
        assert 'event: contradiction' not in result.text
