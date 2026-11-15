"""Trusted game state and actor contracts. The director never selects live dialogue."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from . import engine as e
from .case_rules import RULES, CaseRules


class ActorReply(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reply: str = Field(min_length=1, max_length=600)
    stance: Literal['cooperate', 'deflect', 'defend', 'admit_secret', 'confess']
    # Allowed values are set per case and per turn (see actor_schema and validate).
    actions: list[str] = Field(default_factory=list, max_length=3)


@dataclass
class Turn:
    sid: str
    message: str
    context: dict
    allowed_actions: set[str]
    confession_required: bool
    confession_allowed: bool
    secret_available: bool
    secret_required: bool
    delivered: list[str]
    case_id: str = e.DEFAULT_CASE

    @property
    def rules(self) -> CaseRules:
        return RULES[self.case_id]


def rules(s: e.Session) -> CaseRules:
    return RULES[s.case_id]


def memory(s: e.Session, sid: str):
    defaults = {
        'turns': 0, 'sensitive_questions': 0, 'rapport': 0,
        'secret_revealed': False, 'confessed': False, 'last_stance': None,
        'heard_claims': [],
    }
    saved = s.interview_memory.setdefault(sid, {})
    for key, value in defaults.items():
        saved.setdefault(key, value)
    return saved


def context(s: e.Session, sid: str):
    """An actor gets their own dossier and presented evidence, never the full case."""
    m = memory(s, sid)
    r = rules(s)
    people = e.suspects_of(s)
    confession_allowed = e.breaking(s, sid)
    confess = confession_allowed and not m['confessed']
    secret = sid != e.culprit_of(s) and (
        m['secret_revealed'] or m['sensitive_questions'] >= 2
        or (m['sensitive_questions'] >= 1 and m['rapport'] >= 2)
        or (m['sensitive_questions'] >= 1 and s.pressure[sid] >= .65)
    )
    stage = 'aftermath' if m['confessed'] else 'candid' if m['secret_revealed'] else 'broken' if confession_allowed else 'opening' if m['turns'] <= 1 else 'strained' if s.pressure[sid] >= .7 else 'guarded' if s.pressure[sid] >= .35 else 'conversational'
    allowed = {r.share[sid]} if sid in r.share else set()
    if secret and not m['secret_revealed']:
        allowed.add('reveal_personal_secret')
    if confession_allowed:
        allowed.add('confess')
    dossier = {'cover_story': r.cover[sid], 'known_facts': r.knowledge[sid]}
    if secret:
        dossier.pop('cover_story')
        dossier['known_facts'] = list(dict.fromkeys(r.knowledge[sid] + people[sid]['private']['knows']))
        dossier['personal_disclosure'] = people[sid]['private']['secret']
        dossier['true_alibi'] = people[sid]['private']['alibi']
    if confession_allowed:
        # The next case's twist stays sealed even after this case's confession.
        dossier['admitted_financial_facts' if m['confessed'] else 'required_admission'] = people[sid]['private']['secret']
        dossier['cover_story'] = r.broken_cover
    presented = [r.presented[eid] for eid in s.presented[sid] if eid in r.presented]
    return {
        'identity': people[sid]['name'],
        'public_cast': [{'name': p['name'], 'role': p['role']} for p in people.values()],
        'dossier': dossier,
        'interview': {'stage': stage, 'pressure': round(s.pressure[sid], 2), **m, 'heard_claims': m['heard_claims'][-6:]},
        'investigation_progress': {'people_interviewed': len(s.visited), 'clues_discovered': len(s.evidence), 'cross_examination_occurred': s.crossed},
        'evidence_presented_to_you': presented,
        'documents_you_shared': sorted({action for entry in s.director_log if entry['speaker'] == sid for action in entry['actions'] if action in r.evidence_actions}),
        'personal_secret_available': secret,
        'confession_required': confess,
        'confession_allowed': confession_allowed,
        'personal_disclosure_required': False,
        'allowed_actions': sorted(allowed),
    }


def prepare(s: e.Session, sid: str, message: str, present: str | None = None):
    e.require_suspect(sid, s)
    delivered = []
    if present:
        if present not in s.evidence:
            from fastapi import HTTPException
            raise HTTPException(403, 'You must discover this evidence before presenting it.')
        if present not in s.presented[sid]:
            s.presented[sid].append(present)
            delivered.append(present)
            s.pressure[sid] = min(1, s.pressure[sid] + .22)
    m = memory(s, sid)
    m['turns'] += 1
    sensitive = bool(re.search(rules(s).topics[sid], message.lower()))
    if sensitive:
        m['sensitive_questions'] += 1
    if re.search(r'\b(please|thank|understand|help|worried|trust|honest|listen)\b', message.lower()):
        m['rapport'] = min(5, m['rapport'] + 1)
    aggressive = bool(re.search(r'\b(lying|liar|stole|confess|arrest|proof|guilty)\b', message.lower()))
    challenged = aggressive or (sensitive and not (m['secret_revealed'] or m['confessed']))
    s.pressure[sid] = round(max(0, min(1, s.pressure[sid] + (.15 if challenged else -.02))), 3)
    brief = context(s, sid)
    secret_required = brief['personal_secret_available'] and sensitive and not m['secret_revealed']
    brief['personal_disclosure_required'] = secret_required
    return Turn(sid, message, brief, set(brief['allowed_actions']), brief['confession_required'], brief['confession_allowed'], brief['personal_secret_available'], secret_required, delivered, s.case_id)


def validate(turn: Turn, response: ActorReply):
    if not set(response.actions) <= turn.allowed_actions:
        raise ValueError('An action is not authorized for this character and stage.')
    if response.stance == 'confess' and not turn.confession_allowed:
        raise ValueError('The evidence gate has not been met.')
    if response.stance == 'admit_secret' and not turn.secret_available:
        raise ValueError('This personal disclosure is still sealed.')
    if turn.secret_required and (response.stance != 'admit_secret' or 'reveal_personal_secret' not in response.actions):
        raise ValueError('The detective has earned your personal disclosure. Admit the provided personal fact now; stop deflecting.')
    if turn.confession_required and (response.stance != 'confess' or 'confess' not in response.actions):
        raise ValueError('The established evidence has broken the cover story; acknowledge it.')
    r = turn.rules
    culprit = next(k for k, p in e._SUSPECTS[turn.case_id].items() if p['private']['is_guilty'])
    text = response.reply.strip()
    q = text.lower().replace('’', "'")
    heard = turn.context['interview']['heard_claims']
    if turn.confession_required and not all(re.search(term, q) for term in r.confession_terms):
        raise ValueError('Make a specific first-person admission of the authorized facts.')
    if re.search(r.sealed_twist, q):
        raise ValueError('The next case is still sealed.')
    if turn.sid == culprit and not turn.confession_allowed and re.search(r.early_confession, q):
        raise ValueError('Keep the cover story until both pieces of evidence are presented.')
    r.extra_validate(turn, q, response)
    # Catch concrete cross-character secrets rather than giving a critic the full
    # truth or asking a second model to invent a verdict.
    for sid, terms in r.personal_facts.items():
        heard_admission = any(claim['speaker'] == sid and claim['personal_admission'] for claim in heard)
        sealed = not turn.secret_available if sid == turn.sid else not heard_admission
        if sealed and all(re.search(term, q) for term in terms):
            raise ValueError('That private fact is not available in this interview.')
    if turn.sid in r.personal_facts and turn.secret_available and not turn.context['interview']['secret_revealed'] and all(re.search(term, q) for term in r.personal_facts[turn.sid]) and 'reveal_personal_secret' not in response.actions:
        raise ValueError('Record the personal admission with reveal_personal_secret so it remains remembered.')
    heard_confession = any(claim['speaker'] == culprit and claim['financial_admission'] for claim in heard)
    if turn.sid != culprit and re.search(r.culprit_secret_terms, q) and not heard_confession:
        raise ValueError('Do not invent knowledge of the culprit.')
    if re.search(r'\[(?:nervous|sigh|pause)|\*(?:sigh|pause)|system prompt|as an ai', q):
        raise ValueError('Return spoken character dialogue only.')
    if response.stance == 'admit_secret' and 'reveal_personal_secret' not in response.actions:
        raise ValueError('Record the personal admission with its permitted action.')
    if response.stance == 'admit_secret':
        disclosure = r.personal_facts.get(turn.sid)
        if disclosure is None or not all(re.search(term, q) for term in disclosure):
            raise ValueError('Your admission must acknowledge the actual personal_disclosure fact, not a new explanation.')
    if turn.context['interview']['confessed'] and re.search(r"\b(?:never|did not|didn't)\s+(?:created?|set up|scheduled?|moved?|stole|steal|sent|send|unlocked?)\b", q):
        raise ValueError('Do not retract the financial admission you already made.')
    if turn.context['interview']['secret_revealed']:
        denial = r.retractions.get(turn.sid)
        if denial and re.search(r"\b(?:never|did not|didn't)\s+(?:" + denial + ')', q):
            raise ValueError('Do not retract the personal fact you already admitted.')
    # Names, feelings and tactics can vary; new exact times and amounts cannot.
    allowed_times = r.allowed_times | r.extra_times.get(turn.sid, set())
    for clock in re.findall(r'\b\d{1,2}(?::\d{2})?\s*[ap]m\b', q):
        if re.sub(r'\s+', '', clock) not in allowed_times:
            raise ValueError('Do not invent a new clock time. Use the provided alibi and case times.')
    if re.search(r'\b(?:sent|sending|send you|emailed|attached|forwarded)\b', q) and not set(response.actions).intersection(r.evidence_actions) and not (turn.confession_allowed and turn.sid == culprit):
        raise ValueError('A claimed document delivery needs an authorized sharing action.')
    return response.model_copy(update={'reply': text})


def observe(s: e.Session, listener: str, speaker: str, text: str):
    """Share an actual in-room statement, never the speaker's private dossier."""
    if listener == speaker:
        return
    e.require_suspect(listener, s)
    e.require_suspect(speaker, s)
    q = text.lower()
    source = memory(s, speaker)
    r = rules(s)
    terms = r.personal_facts.get(speaker)
    memory(s, listener)['heard_claims'].append({
        'speaker': speaker,
        'name': e.suspects_of(s)[speaker]['name'],
        'claim': text,
        'personal_admission': bool(source['secret_revealed'] and terms and all(re.search(term, q) for term in terms)),
        'financial_admission': bool(source['confessed'] and re.search(r.confession_terms[0], q)),
    })


def actor_schema(turn: Turn):
    """Constrain metadata while leaving every spoken word for the actor to write."""
    schema = ActorReply.model_json_schema()
    schema['required'] = ['reply', 'stance', 'actions']
    stances = ['cooperate', 'deflect', 'defend']
    if turn.secret_available and not turn.context['interview']['secret_revealed']:
        stances.append('admit_secret')
    if turn.confession_allowed:
        stances.append('confess')
    required_action = 'confess' if turn.confession_required else 'reveal_personal_secret' if turn.secret_required else None
    if required_action:
        stances = ['confess' if turn.confession_required else 'admit_secret']
        schema['properties']['actions'] = {'type': 'array', 'const': [required_action]}
    elif turn.allowed_actions:
        schema['properties']['actions']['items']['enum'] = sorted(turn.allowed_actions)
    else:
        schema['properties']['actions']['maxItems'] = 0
    schema['properties']['stance']['enum'] = stances
    return schema


def commit(s: e.Session, turn: Turn, response: ActorReply, source: str, reason: str | None = None):
    response = validate(turn, response)
    events = []
    m = memory(s, turn.sid)
    for action in set(response.actions):
        if action in rules(s).evidence_actions:
            eid = rules(s).evidence_actions[action]
            if e.unlock(s, eid):
                events.append({'type': 'evidence_unlocked', 'id': eid})
        elif action == 'reveal_personal_secret':
            m['secret_revealed'] = True
        elif action == 'confess':
            m['confessed'] = True
    m['last_stance'] = response.stance
    s.histories[turn.sid].extend([{'role': 'user', 'content': turn.message}, {'role': 'assistant', 'content': response.reply}])
    e.note(s, response.reply, e.suspects_of(s)[turn.sid]['name'])
    e.remember_speech(s, turn.sid, response.reply)
    s.director_log.append({'speaker': turn.sid, 'turn': m['turns'], 'stage': turn.context['interview']['stage'], 'actions': response.actions, 'source': source, 'reason': reason})
    return response.reply, events


def fallback(turn: Turn):
    """A bounded offline safety net, used only when generation fails validation."""
    r = turn.rules
    if turn.confession_allowed:
        return ActorReply(reply=r.fallback_confession, stance='confess', actions=['confess'])
    if turn.secret_required:
        return ActorReply(reply=r.fallback_secret[turn.sid], stance='admit_secret', actions=['reveal_personal_secret'])
    if turn.sid in r.fallback_share:
        pattern, line = r.fallback_share[turn.sid]
        if re.search(pattern, turn.message.lower()):
            return ActorReply(reply=line, stance='cooperate', actions=[r.share[turn.sid]])
    return ActorReply(reply=r.fallback_default[turn.sid], stance='defend')
