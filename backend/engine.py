"""Server-owned case rules. Nothing in this module is bundled by Vite."""
from __future__ import annotations

import asyncio
import copy
import difflib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from fastapi import HTTPException

ROOT = Path(__file__).parent
# Every case file in cases/ is playable; case_01 is the default.
CASES = {c['id']: c for c in (json.loads(p.read_text()) for p in sorted((ROOT / 'cases').glob('case_*.json')))}
DEFAULT_CASE = 'case_01'
CASE = CASES[DEFAULT_CASE]  # Case 01, kept for older imports and tests.
SUSPECTS = {s['id']: s for s in CASE['suspects']}
_SUSPECTS = {cid: {p['id']: p for p in c['suspects']} for cid, c in CASES.items()}


def case_of(s: 'Session'):
    return CASES[s.case_id]


def suspects_of(s: 'Session'):
    return _SUSPECTS[s.case_id]


def case_list():
    return [
        {'id': c['id'], 'number': c['number'], 'title': c['title'], 'tagline': c.get('tagline', '')}
        for c in sorted(CASES.values(), key=lambda c: c['number'])
    ]


@dataclass
class Session:
    case_id: str = DEFAULT_CASE
    touched: float = field(default_factory=time.monotonic)
    visited: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)
    log: list[dict] = field(default_factory=list)
    pressure: dict = field(default_factory=dict)
    presented: dict = field(default_factory=dict)
    histories: dict = field(default_factory=dict)
    utterances: dict = field(default_factory=dict)
    interview_memory: dict = field(default_factory=dict)
    director_log: list[dict] = field(default_factory=list)
    hints: int = 0
    guess: str | None = None
    active: str | None = None
    crossed: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self):
        if self.case_id not in CASES:
            self.case_id = DEFAULT_CASE
        people = _SUSPECTS[self.case_id]
        for sid, p in people.items():
            self.pressure.setdefault(sid, p['private']['tells']['baseline_nervousness'])
            self.presented.setdefault(sid, [])
            self.histories.setdefault(sid, [])


def require_suspect(sid: str, s: 'Session | None' = None):
    people = suspects_of(s) if s is not None else SUSPECTS
    if sid not in people:
        raise HTTPException(404, 'Unknown person on this case.')
    return people[sid]


def public_state(s: Session):
    return {'visited': s.visited, 'evidence': s.evidence, 'notes': s.notes, 'log': s.log, 'crossed': s.crossed, 'guessed': s.guess is not None}


def public_case(s: Session):
    case = case_of(s)
    fields = ['id', 'number', 'title', 'briefing', 'opening_letter', 'amount', 'date']
    data = {k: case[k] for k in fields}
    for optional in ('location', 'tagline', 'board', 'missing_person', 'cross_pair', 'clue_hint'):
        if optional in case:
            data[optional] = case[optional]
    bank = load_bank() if any(ev.get('source') == 'nessie' for ev in case['evidence']) else None
    data['victim_business'] = {'name': bank['business']['name']} if bank else case['victim_business']
    data['suspects'] = [{k: v for k, v in p.items() if k not in ('private',)} for p in case['suspects']]
    # Board cards for evidence are only sent once that evidence is found.
    data['evidence_catalog'] = [
        {'id': ev['id'], 'title': ev['title'], 'type': ev['type'], **({'card': ev['card']} if ev['id'] in s.evidence and 'card' in ev else {})}
        for ev in case['evidence']
    ]
    data['links'] = [link for link in case['links'] if link['revealed_by'] in s.evidence]
    data['cases'] = case_list()
    data['mode'] = 'demo' if demo_mode() else 'live'
    from .voice import voice_status
    data['audio'] = voice_status()
    data['data_source'] = bank['provenance'] if bank else case.get('data_source', 'Case file')
    data['state'] = public_state(s)
    return data


def demo_mode():
    return os.getenv('DEMO_MODE', 'true').lower() == 'true'


def load_bank():
    # A successful Nessie seed replaces the cache. Demo mode never makes network calls.
    return json.loads((ROOT / 'data/nessie_cache.json').read_text())


def note(s: Session, text: str, source: str):
    if not any(n['text'] == text for n in s.notes):
        s.notes.append({'id': f'n{len(s.notes)+1}', 'text': text, 'source': source})


def unlock(s: Session, eid: str):
    if eid not in s.evidence:
        s.evidence.append(eid)
        ev = next((x for x in case_of(s)['evidence'] if x['id'] == eid), None)
        if ev and ev.get('note'):
            note(s, ev['note']['text'], ev['note']['source'])
        return True
    return False


def evidence_document(s: Session, eid: str):
    if eid not in s.evidence:
        raise HTTPException(403, 'This evidence has not been discovered. Ask a suspect for it.')
    case = case_of(s)
    evidence = copy.deepcopy(next((e for e in case['evidence'] if e['id'] == eid), None))
    if evidence is None:
        raise HTTPException(404, 'Document not found.')
    for private in ('locked_until', 'note', 'card'):
        evidence.pop(private, None)
    evidence['number'] = f"{[x['id'] for x in case['evidence']].index(eid) + 1:03d}"
    if evidence.get('source') == 'nessie':
        bank = load_bank()
        evidence.update({'transactions': bank['transactions'], 'provenance': bank['provenance'], 'notice': bank.get('notice', ''), 'business': bank['business']['name']})
    return evidence


def start_call(s: Session, sid: str):
    p = require_suspect(sid, s)
    if s.guess:
        raise HTTPException(409, 'This case has already been decided. Reset to investigate again.')
    s.active = sid
    if sid not in s.visited:
        s.visited.append(sid)
    s.log.append({'id': f'c{len(s.log)+1}', 'name': p['name'], 'role': p['role'], 'time': time.strftime('%H:%M')})
    note(s, f"Interview opened with {p['name']}, {p['role'].lower()}.", p['name'])
    previous = next((m['content'] for m in reversed(s.histories[sid]) if m['role'] == 'assistant'), None)
    opening = previous or p['opening']
    if not s.histories[sid]:
        s.histories[sid].append({'role': 'assistant', 'content': opening})
    remember_speech(s, sid, opening)
    return {'suspect_id': sid, 'opening': opening, 'resumed': previous is not None, 'state': public_state(s)}


def remember_speech(s: Session, sid: str, text: str):
    """Authorize a spoken line and preserve its delivery at the time it was said."""
    s.utterances[(sid, text)] = {'pressure': s.pressure[sid]}


def culprit_of(s: Session):
    return next(k for k, p in suspects_of(s).items() if p['private']['is_guilty'])


def breaking(s: Session, sid: str):
    """The culprit folds only once every key clue has been put to them."""
    keys = {ev['id'] for ev in case_of(s)['evidence']}
    return sid == culprit_of(s) and keys.issubset(s.presented[sid])


def scripted_reply(s: Session, sid: str, message: str, present: str | None):
    p = require_suspect(sid, s)
    q = message.lower()
    events = []
    if present:
        if present not in s.evidence:
            raise HTTPException(403, 'You must discover this evidence before presenting it.')
        if present not in s.presented[sid]:
            s.presented[sid].append(present)
        s.pressure[sid] = min(1.0, s.pressure[sid] + .22)
    triggers = p['private']['tells']['triggers']
    s.pressure[sid] = max(0, min(1, s.pressure[sid] + (.15 if any(t in q for t in triggers) else -.02)))
    if sid == 'sam':
        if any(w in q for w in ['sheet', 'transaction', 'record', 'document', 'money', 'payment', 'northshore', 'send', 'bank', 'evidence']):
            if unlock(s, 'transaction_sheet'):
                events.append({'type': 'evidence_unlocked', 'id': 'transaction_sheet'})
            reply = 'Yes, sending it right away. Three payments to Northshore Supply, $16,250 each. And look at the times… every single one at 11:52 PM.'
        elif any(w in q for w in ['tuesday', 'interview', 'hiding', 'secret', 'alibi', 'where', 'nervous']):
            reply = 'Fine. I-I was at a job interview last Tuesday, at a competitor. Please don’t tell the owner. That’s what I was hiding; it had nothing to do with those payments.'
            note(s, 'Sam says his secret was a job interview at a competitor on Tuesday afternoon.', p['name'])
        else:
            reply = 'I keep the accounts, but I don’t approve vendors. I can send you the transaction sheet; that’s where I’d start.'
    elif sid == 'marcus':
        if any(w in q for w in ['saw', 'see', 'night', 'late', 'light', 'office', 'priya', 'midnight', '11:52', 'witness', 'evidence', 'where', 'happen']):
            if unlock(s, 'eyewitness'):
                events.append({'type': 'evidence_unlocked', 'id': 'eyewitness'})
            reply = 'The night I was there, Priya’s office light was on around midnight. I saw her through the window. Thought it was odd for someone who always leaves early.'
        elif any(w in q for w in ['van', 'dent', 'hiding', 'secret', 'why']):
            reply = 'All right, I dented the delivery van. I stayed late trying to fix it before anyone noticed. That’s my whole big secret.'
            note(s, 'Marcus says he stayed late to fix a dent in the delivery van.', p['name'])
        else:
            reply = 'I make deliveries, not payments. I was outside the bakery that night, though. You should ask me what I saw.'
    elif sid == 'elena':
        if any(w in q for w in ['rent', 'debt', 'hiding', 'secret', 'savings', 'staff']):
            reply = 'I covered the overdue rent out of my own savings. I didn’t tell the staff; I couldn’t let them think we were sinking. That’s what I was hiding.'
        elif any(w in q for w in ['where', 'night', 'midnight', 'alibi']):
            reply = 'At home with my daughter. I came in at six to open up. By then the money was already gone.'
        else:
            reply = 'I don’t recognize Northshore. Sam checks the ledger, but operations handles new vendors. Someone made that name look legitimate.'
    elif sid == 'theo':
        if any(w in q for w in ['server', 'hiding', 'secret', 'freelance', 'permission']):
            reply = 'Okay… I used a spare server for a freelance project. Without asking. It was stupid, but it had nothing to do with the bakery’s bank account.'
        elif any(w in q for w in ['login', 'password', 'access', 'another']):
            reply = 'Network access isn’t banking access. Everyone is meant to use their own bank login. I can fix a router; I can’t authorize a vendor payment.'
        else:
            reply = 'My maintenance session ended at nine-ten. After that I was at home, working on something of my own. I wasn’t logged in at midnight.'
    else:
        if breaking(s, sid):
            reply = 'I… the payments and Marcus’s statement, together… All right. I set up Northshore. I was in the office at 11:52. But you don’t understand the whole story.'
            note(s, 'Confronted with both clues, Priya admits creating Northshore and being in the office at 11:52.', p['name'])
        elif present:
            reply = 'That doesn’t establish anything on its own. Sam handles the books, and Marcus can be mistaken. I’m always home asleep by ten.'
        elif any(w in q for w in ['night', 'where', 'midnight', '11:52', 'alibi', 'office', 'home', 'marcus', 'asleep']):
            reply = 'I’m always home asleep by ten. Every night. Whatever Marcus thinks he saw, he must have been mistaken.'
            note(s, 'Priya claims she is always home asleep by 10 PM.', p['name'])
        elif any(w in q for w in ['northshore', 'vendor', 'money', 'payment', 'sam', 'guilty', 'confess']):
            reply = 'Northshore? I oversee operations, not individual entries. Sam has access to the ledger. Have you asked why he’s been so nervous lately?'
        else:
            reply = 'I’ve given this bakery years of my life. I’d be happy to help, but I suggest you look at who actually keeps the books.'
    if sid == 'priya' and not breaking(s, sid) and s.pressure[sid] >= .45:
        turn = len(s.histories[sid]) // 2
        lead_ins = ['I-I mean… ', 'No. Wait… ', 'I… listen. '] if s.pressure[sid] >= .75 else ['Look… ', 'Just… ', 'Let me be clear. ']
        reply = lead_ins[turn % len(lead_ins)] + reply
    elif sid == 'sam' and s.pressure[sid] >= .5 and reply.startswith('Yes,'):
        reply = reply.replace('Yes,', 'Yes. Y-yes,', 1)
    elif sid == 'marcus' and s.pressure[sid] >= .45 and 'I dented' in reply:
        reply = reply.replace('All right,', 'All right. Look…', 1)
    s.histories[sid].extend([{'role': 'user', 'content': message}, {'role': 'assistant', 'content': reply}])
    note(s, reply, p['name'])
    return reply, events


def resolve_name(text: str, s: Session | None = None):
    people = suspects_of(s) if s is not None else SUSPECTS
    q = re.sub(r'[^a-z ]', '', text.lower())
    for sid, p in people.items():
        names = [sid, p['name'].split()[-1].lower()]
        if any(re.search(r'\b' + re.escape(name) + r'\b', q) for name in names) or p['role'].lower() in q or p['role'].lower().split()[-1] in q.split():
            return sid
    for word in q.split():
        if word in {'the', 'and', 'can', 'you', 'for', 'that', 'this', 'with', 'please', 'call', 'talk', 'who', 'was', 'are'} or len(word) < 3:
            continue
        matches = difflib.get_close_matches(word, list(people), n=1, cutoff=.6)
        if matches:
            return matches[0]
    return None


def route_command(s: Session, text: str):
    q = text.lower().strip()
    case = case_of(s)
    names = [sid for sid, p in suspects_of(s).items() if sid in q or p['name'].split()[-1].lower() in q]
    sid = resolve_name(q, s)
    if re.fullmatch(r'(?:please\s+)?(?:hang\s*up|end\s+(?:the\s+)?call|back\s+to\s+(?:the\s+)?board)(?:\s+please)?[.!?]*', q):
        return {'intent': 'hangup'}
    # Inside an interview, mentions of "call Sam", "help me", "notes", or
    # "confront" are conversation, not commands to switch screens.
    if s.active:
        return {'intent': 'say', 'suspect_id': s.active, 'message': text}
    if any(w in q for w in ['cross', 'confront', 'same room']):
        return {'intent': 'cross', 'suspects': names[:2] if len(names) >= 2 else case.get('cross_pair', list(suspects_of(s))[:2])}
    if any(w in q for w in ['call', 'phone', 'speak to', 'talk to', 'interview']) and sid:
        return {'intent': 'call', 'suspect_id': sid}
    if any(w in q for w in ['guess', 'accuse', 'arrest']):
        return {'intent': 'guess', 'suspect_id': sid}
    if 'hint' in q or 'help me' in q:
        return {'intent': 'hint'}
    if 'notes' in q or 'notebook' in q:
        return {'intent': 'notes'}
    if not s.active and any(w in q for w in ['show', 'open', 'evidence', 'sheet', 'log', 'record']):
        found = [ev for ev in case['evidence'] if ev['id'] in s.evidence] or case['evidence']
        eid = next((ev['id'] for ev in found if any(k in q for k in ev.get('keywords', []))), found[0]['id'])
        return {'intent': 'evidence', 'evidence_id': eid}
    if s.active:
        return {'intent': 'say', 'suspect_id': s.active, 'message': text}
    return None
