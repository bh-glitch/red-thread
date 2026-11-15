from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).resolve().parent.parent / '.env')
from . import engine as e
from . import progress
from . import director
from .ai import converse, game_master_route
from .case_rules import RULES
from .voice import EMOTIONAL_PRESSURE, VoiceUnavailable, render_speech as synthesize, voice_status, prefetch_speech, warm_local_backup, close_voice

logging.basicConfig(level=logging.INFO)
sessions: dict[str, e.Session] = {}
MAX_SESSIONS = 500


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        import inspect
        from importlib.metadata import version
        from deepagents import create_deep_agent
        logging.info('deepagents %s signature: %s', version('deepagents'), inspect.signature(create_deep_agent))
    except ImportError:
        logging.info('Optional deepagents not installed. Demo router is available.')
    warm_local_backup()
    yield
    await close_voice()
    sessions.clear()


app = FastAPI(title='Red Thread', lifespan=lifespan)


def session(request: Request, response: Response, ledger_session: Annotated[str | None, Cookie()] = None):
    # Evict expired sessions; keys are random, never caller-chosen.
    now = time.monotonic()
    for key in [k for k, s in sessions.items() if now - s.touched > 7200]:
        del sessions[key]
    if ledger_session not in sessions:
        if len(sessions) >= MAX_SESSIONS:
            raise HTTPException(503, 'The investigation room is full. Try again shortly.')
        saved = progress.load(ledger_session)
        if saved is not None:
            sessions[ledger_session] = saved
        else:
            ledger_session = secrets.token_urlsafe(32)
            sessions[ledger_session] = e.Session()
            response.set_cookie('ledger_session', ledger_session, httponly=True, samesite='strict', max_age=7200, secure=request.url.scheme == 'https')
    state = sessions[ledger_session]
    state.touched = now
    try:
        yield state
    finally:
        progress.save(ledger_session, state)


State = Annotated[e.Session, Depends(session)]


class Text(BaseModel):
    message: str = Field(min_length=1, max_length=1500)
    evidence_id: str | None = None
    voice: bool = True


class VoicePreference(BaseModel):
    voice: bool = True


class CaseChoice(BaseModel):
    case_id: str = Field(min_length=1, max_length=40)


class Guess(BaseModel):
    suspect_id: str


class Cross(BaseModel):
    suspects: list[str] = Field(min_length=2, max_length=2)
    question: str = Field(default='Where were you around midnight?', max_length=500)
    voice: bool = True


class Speech(BaseModel):
    suspect_id: str
    text: str = Field(min_length=1, max_length=900)


@app.get('/health')
def health():
    return {'ok': True, 'mode': 'demo' if e.demo_mode() else 'live', 'audio': voice_status()}


@app.get('/voice/status')
def voice_configuration():
    return voice_status()


@app.get('/case/load')
def case_load(s: State):
    return e.public_case(s)


def restart(s: e.Session, case_id: str):
    fresh = e.Session(case_id=case_id)
    for key, value in vars(fresh).items():
        if key != 'lock':
            setattr(s, key, value)


@app.post('/reset')
async def reset(s: State):
    async with s.lock:
        restart(s, s.case_id)
    return e.public_case(s)


@app.get('/cases')
def cases():
    return {'cases': e.case_list()}


@app.post('/case/select')
async def select_case(body: CaseChoice, s: State):
    """Switch to another case. Each switch starts that case fresh."""
    if body.case_id not in e.CASES:
        raise HTTPException(404, 'Unknown case.')
    async with s.lock:
        restart(s, body.case_id)
    return e.public_case(s)


@app.post('/call/{suspect_id}/start')
async def call_start(suspect_id: str, s: State, body: VoicePreference | None = None):
    async with s.lock:
        result = e.start_call(s, suspect_id)
        if body is None or body.voice:
            prefetch_speech(suspect_id, result['opening'], s.pressure[suspect_id], e.suspects_of(s)[suspect_id]['voice'])
        return result


@app.post('/hangup')
async def hangup(s: State):
    async with s.lock:
        s.active = None
    return {'state': e.public_state(s)}


def event(kind: str, data: dict):
    return f'event: {kind}\ndata: {json.dumps(data)}\n\n'


@app.post('/call/{suspect_id}/say')
async def say(suspect_id: str, body: Text, s: State):
    e.require_suspect(suspect_id, s)
    async with s.lock:
        if s.guess:
            raise HTTPException(409, 'This case has been decided.')
        if s.active != suspect_id:
            raise HTTPException(409, 'Call this suspect before asking a question.')
        result = await converse(s, suspect_id, body.message, body.evidence_id)
        reply, events = result.text, result.events
        if body.voice:
            prefetch_speech(suspect_id, reply, s.pressure[suspect_id], e.suspects_of(s)[suspect_id]['voice'])
        snapshot = e.public_state(s)
        links = [link for link in e.case_of(s)['links'] if link['revealed_by'] in s.evidence]
        catalog = e.public_case(s)['evidence_catalog']
    async def stream():
        for word in reply.split(' '):
            yield event('token', {'text': word + ' '})
            await asyncio.sleep(.008)
        for item in events:
            yield event(item['type'], item)
        yield event('done', {'text': reply, 'state': snapshot, 'links': links, 'evidence_catalog': catalog, 'suspect_id': suspect_id, 'dialogue': {'source': result.source, 'reason': result.reason}})
    return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.post('/command')
async def command(body: Text, s: State):
    route = e.route_command(s, body.message)
    if route is None:
        route = await game_master_route(s, body.message)
    return route or {'intent': 'clarify', 'message': RULES[s.case_id].command_help}


@app.post('/cross')
async def cross(body: Cross, s: State):
    if len(set(body.suspects)) != 2:
        raise HTTPException(422, 'Choose two different people.')
    for sid in body.suspects:
        e.require_suspect(sid, s)
    async with s.lock:
        if s.guess:
            raise HTTPException(409, 'This case has been decided.')
        if len(s.visited) < 2:
            raise HTTPException(403, 'Interview at least two people to unlock cross-examination.')
        r = RULES[s.case_id]
        people = e.suspects_of(s)
        culprit = e.culprit_of(s)
        pair = set(body.suspects)
        evidence = set(s.evidence)
        replies = []
        for sid in body.suspects:
            source = 'scripted'
            reply = r.cross_lines[sid](evidence)
            if not e.demo_mode():
                other = next(person for person in body.suspects if person != sid)
                result = await converse(s, sid, f'Cross-examination with {people[other]["name"]}. The detective asks: {body.question}')
                reply = result.text
                source = result.source
            replies.append({'suspect_id': sid, 'text': reply, 'dialogue': {'source': source}})
            if not e.demo_mode():
                director.observe(s, next(person for person in body.suspects if person != sid), sid, reply)
            e.remember_speech(s, sid, reply)
            if body.voice:
                prefetch_speech(sid, reply, s.pressure[sid], people[sid]['voice'])
            e.note(s, reply, people[sid]['name'])
        contradiction = pair == set(r.cross_pair) and r.cross_requires in evidence
        if contradiction:
            s.crossed = True
            e.note(s, r.contradiction_note, 'Cross-examination')
            keys = [ev['id'] for ev in e.case_of(s)['evidence']]
            if set(keys).issubset(evidence):
                s.presented[culprit] = keys
                s.pressure[culprit] = .95
                reply = r.fallback_confession
                source = 'scripted'
                if not e.demo_mode():
                    result = await converse(s, culprit, r.cross_confession_prompt)
                    reply = result.text
                    source = result.source
                replies.append({'suspect_id': culprit, 'text': reply, 'dialogue': {'source': source}})
                if not e.demo_mode():
                    director.observe(s, r.cross_witness, culprit, reply)
                e.remember_speech(s, culprit, reply)
                if body.voice:
                    prefetch_speech(culprit, reply, s.pressure[culprit], people[culprit]['voice'])
                e.note(s, r.cross_confession_note, 'Cross-examination')
        snapshot = e.public_state(s)
    async def stream():
        for reply in replies:
            yield event('statement', reply)
            await asyncio.sleep(.45)
        if contradiction:
            yield event('contradiction', r.contradiction_event)
        yield event('done', {'state': snapshot, 'contradiction': contradiction})
    return StreamingResponse(stream(), media_type='text/event-stream')


@app.get('/evidence/{evidence_id}')
def evidence(evidence_id: str, s: State):
    return e.evidence_document(s, evidence_id)


@app.post('/hint')
async def hint(s: State):
    async with s.lock:
        hints = e.case_of(s)['hints']
        index = min(s.hints, len(hints) - 1)
        s.hints += 1
    return {'text': hints[index], 'level': index + 1}


@app.get('/notes')
def notes(s: State):
    return {'notes': s.notes}


@app.post('/guess')
async def guess(body: Guess, s: State):
    e.require_suspect(body.suspect_id, s)
    async with s.lock:
        if s.guess and s.guess != body.suspect_id:
            raise HTTPException(409, 'A verdict has already been recorded. Reset the case to try again.')
        s.guess = body.suspect_id
        s.active = None
        correct = e.suspects_of(s)[s.guess]['private']['is_guilty']
    return {'correct': correct, 'stamp': 'GUILTY — CASE CLOSED' if correct else 'WRONG SUSPECT', 'suspect_id': s.guess}


@app.get('/reveal')
def reveal(s: State):
    if not s.guess:
        raise HTTPException(403, 'Record your verdict before opening the sealed account.')
    case = e.case_of(s)
    culprit = e.culprit_of(s)
    e.remember_speech(s, culprit, case['cliffhanger'])
    bank = next((ev for ev in case['evidence'] if ev.get('source') == 'nessie' or 'transactions' in ev), None)
    transactions = e.load_bank()['transactions'] if bank and bank.get('source') == 'nessie' else (bank or {}).get('transactions', [])
    # The reveal highlights the suspicious rows (Case 01: all of them).
    if s.case_id != 'case_01':
        transactions = [row for row in transactions if row['amount'] <= -10000]
    return {'truth_timeline': case['truth_timeline'], 'guilty_id': culprit, 'cliffhanger': case['cliffhanger'], 'next_mission': case['next_mission'], 'transactions': transactions}


@app.post('/tts')
async def tts(body: Speech, s: State):
    person = e.require_suspect(body.suspect_id, s)
    # Only voice dialogue already emitted to this session; this is not a public TTS proxy.
    performance = s.utterances.get((body.suspect_id, body.text))
    if performance is None:
        raise HTTPException(403, 'Only case dialogue can be voiced.')
    playback_rate = '1.1' if performance['pressure'] >= EMOTIONAL_PRESSURE else '1'
    try:
        audio, provider = await synthesize(body.suspect_id, body.text, performance['pressure'], person['voice'])
        headers = {'Cache-Control': 'no-store', 'X-Voice-Provider': provider, 'X-Voice-Playback-Rate': playback_rate}
        reason = voice_status().get('fallback_reason')
        if provider != 'gemini' and reason:
            headers['X-Voice-Fallback'] = reason
        return Response(audio, media_type='audio/wav', headers=headers)
    except VoiceUnavailable as error:
        messages = {
            'local_unavailable': 'Local speech is unavailable. Run make setup to verify the selected voice model.',
            'not_configured': 'Add your Gemini key with make voice-setup to enable humanlike voices.',
            'disabled': 'Gemini voice is disabled in .env.',
            'rate_limited': 'Gemini voice quota reached. Using the browser voice for now.',
            'authentication': 'Gemini rejected this key. Check the key and project access.',
            'model_unavailable': 'This Gemini TTS model is unavailable for your project.',
            'timeout': 'Character voice took too long. Using the browser voice for now.',
            'invalid_request': 'Google rejected the voice request configuration. Check the TTS model and preview API version.',
            'network': 'Could not connect to Google voice. Check your network connection.',
            'service_unavailable': 'Google voice is temporarily unavailable. Using the browser voice for now.',
        }
        raise HTTPException(503, messages.get(error.reason, 'Gemini voice is temporarily unavailable. Using the browser voice.'), headers={'X-Voice-Fallback': error.reason, 'X-Voice-Playback-Rate': playback_rate}) from None


# Optional single-origin production entry point. Only dist/ is publicly served;
# the case files, .env, and backend source stay outside the static mount.
production_app = FastAPI(docs_url=None, redoc_url=None)
production_app.mount('/api', app)
frontend_dist = Path(__file__).resolve().parent.parent / 'dist'
if frontend_dist.is_dir():
    production_app.mount('/', StaticFiles(directory=frontend_dist, html=True), name='game')
