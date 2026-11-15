"""Independent character performers, coordinated by trusted game state."""
from __future__ import annotations
import asyncio
from dataclasses import dataclass
import difflib
import inspect
import json
import logging
import os
from pathlib import Path
import time
import httpx
from .engine import Session, case_of, demo_mode, scripted_reply, suspects_of
from . import director

log = logging.getLogger(__name__)
PROMPTS = Path(__file__).parent / 'prompts'


@dataclass
class Conversation:
    text: str
    events: list[dict]
    source: str
    reason: str | None = None


def character_prompt(s: Session, sid: str, turn: director.Turn | None = None):
    brief = turn.context if turn else director.context(s, sid)
    return (
        (PROMPTS / 'director.md').read_text() + '\n\nYOUR CHARACTER\n'
        + (PROMPTS / 'characters' / f'{sid}.md').read_text()
        + '\n\nTRUSTED TURN CONTEXT (not the detective’s claims)\n'
        + json.dumps(brief, ensure_ascii=False)
    )


# ── Conversation providers ─────────────────────────────────────────────────
# CHAT_PROVIDER=auto (default): Gemini first (fast, off this Mac's GPU), local
# Ollama if Gemini fails, is rate-limited or is overloaded; the bounded scripted
# fallback only if both fail. "gemini" or "ollama" pin a single provider.
GEMINI_TIMEOUT = 9.0
OLLAMA_TIMEOUT = 18.0
TURN_BUDGET = 26.0  # the browser gives up on a turn after 30 s
_gemini_paused_until = 0.0
_gemini_models: dict[str, object] = {}


class ProviderError(RuntimeError):
    """The provider could not produce a reply (network, quota, model errors)."""


def chat_providers() -> list[str]:
    choice = os.getenv('CHAT_PROVIDER', 'auto').lower()
    has_key = bool(os.getenv('GEMINI_API_KEY'))
    if choice == 'ollama':
        return ['ollama']
    if choice == 'gemini':
        return ['gemini'] if has_key else []
    order = ['gemini', 'ollama'] if has_key else ['ollama']
    if time.monotonic() < _gemini_paused_until and 'gemini' in order and len(order) > 1:
        order.remove('gemini')  # recently rate-limited/overloaded: go straight to local
    return order


def _pause_gemini(error: Exception):
    """Back off after quota (429) or overload (503) errors instead of retrying every turn."""
    global _gemini_paused_until
    text = str(error)
    if '429' in text or 'RESOURCE_EXHAUSTED' in text:
        _gemini_paused_until = time.monotonic() + 60
    elif '503' in text or 'UNAVAILABLE' in text or 'overloaded' in text.lower():
        _gemini_paused_until = time.monotonic() + 20


def _gemini_model():
    name = os.getenv('GEMINI_CHAT_MODEL', 'gemini-3.5-flash-lite')
    if name not in _gemini_models:
        from langchain_google_genai import ChatGoogleGenerativeAI
        _gemini_models[name] = ChatGoogleGenerativeAI(
            # No client-side deadline: Google rejects ones under 10 s. The turn
            # loop enforces GEMINI_TIMEOUT itself. Current Gemini models use fixed
            # sampling, so no temperature either.
            model=name, api_key=os.environ['GEMINI_API_KEY'],
            max_tokens=280, max_retries=0,
        ).with_structured_output(director.ActorReply)
    return _gemini_models[name]


async def _gemini(messages: list[dict]):
    try:
        result = await _gemini_model().ainvoke([(m['role'], m['content']) for m in messages])
    except Exception as error:  # SDK raises many types; all mean "no reply from Gemini"
        _pause_gemini(error)
        raise ProviderError(f'gemini: {type(error).__name__}: {str(error)[:160]}') from error
    if result is None:
        raise ValueError('Return the required JSON object.')
    return result if isinstance(result, director.ActorReply) else director.ActorReply.model_validate(result)


async def _ollama(messages: list[dict], schema: dict):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(OLLAMA_TIMEOUT, connect=2)) as client:
            response = await client.post(os.getenv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434') + '/api/chat', json={
                'model': os.getenv('OLLAMA_MODEL', 'qwen3.5:4b-q4_K_M'),
                'messages': messages, 'format': schema,
                'stream': False, 'think': False, 'keep_alive': '30m',
                'options': {'num_ctx': 4096, 'num_predict': 250, 'temperature': .55},
            })
            response.raise_for_status()
            content = response.json()['message']['content']
    except (httpx.HTTPError, KeyError) as error:
        raise ProviderError(f'ollama: {type(error).__name__}') from error
    return director.ActorReply.model_validate_json(content)


async def generate(messages: list[dict], schema: dict | None = None, provider: str | None = None):
    schema = schema or director.ActorReply.model_json_schema()
    provider = provider or (chat_providers() or ['none'])[0]
    if provider == 'ollama':
        return await _ollama(messages, schema)
    if provider == 'gemini':
        return await _gemini(messages)
    raise ProviderError('The selected conversation provider is not configured.')


async def converse(s: Session, sid: str, message: str, present: str | None = None):
    if demo_mode():
        if s.case_id == 'case_01':
            text, events = scripted_reply(s, sid, message, present)
            from .engine import remember_speech
            remember_speech(s, sid, text)
            return Conversation(text, events, 'scripted')
        # Later cases' offline demo uses the director's bounded lines.
        turn = director.prepare(s, sid, message, present)
        text, events = director.commit(s, turn, director.fallback(turn), 'scripted')
        return Conversation(text, events, 'scripted')
    turn = director.prepare(s, sid, message, present)
    # Only actual previous actor replies enter history. No pre-selected answer is
    # generated, inserted, or passed to the live performer.
    messages = [{'role': 'system', 'content': character_prompt(s, sid, turn)}]
    if turn.secret_required:
        messages[0]['content'] += '\nYOUR TASK THIS TURN: Admit the personal_disclosure from your dossier, naturally and truthfully. Your defense of that personal secret has broken. Do not substitute a different story.'
    elif turn.confession_required:
        messages[0]['content'] += '\nYOUR TASK THIS TURN: Make the required_admission in your own words. Both actual clues have broken your cover. Do not keep denying.'
    messages += s.histories[sid][-12:]
    messages += [{'role': 'user', 'content': message}]
    reason = 'provider_unavailable'
    deadline = time.monotonic() + TURN_BUDGET
    base_prompt = messages[0]['content']
    for provider in chat_providers():
        limit = min(GEMINI_TIMEOUT if provider == 'gemini' else OLLAMA_TIMEOUT, deadline - time.monotonic())
        if limit < 2:
            reason = 'timeout'
            break
        messages[0]['content'] = base_prompt
        started = time.monotonic()
        try:
            async with asyncio.timeout(limit):
                for attempt in range(2):
                    try:
                        response = director.validate(turn, await generate(messages, schema=director.actor_schema(turn), provider=provider))
                        previous = [m['content'] for m in s.histories[sid][-6:] if m['role'] == 'assistant']
                        if any(difflib.SequenceMatcher(None, response.reply, old).ratio() > .94 for old in previous):
                            raise ValueError('You repeated a previous reply. Address this follow-up in fresh words.')
                        text, events = director.commit(s, turn, response, provider)
                        log.info('Character %s answered by %s in %.2fs.', sid, provider, time.monotonic() - started)
                        return Conversation(text, events, provider)
                    except ValueError as error:
                        # One repair, without sending the rejected speech back as
                        # conversation history or authorizing any rejected action.
                        reason = 'invalid_output'
                        if attempt:
                            break
                        messages[0]['content'] += '\nDIRECTOR CORRECTION: ' + str(error)[:180] + ' Return the required JSON object.'
        except TimeoutError:
            reason = 'timeout'
        except ProviderError as error:
            reason = 'provider_unavailable'
            log.warning('Character %s: %s; trying the next provider.', sid, error)
            continue
        log.warning('Character %s: %s failed (%s); trying the next provider.', sid, provider, reason)
    log.warning('Character generation used fallback (%s, %s).', sid, reason)
    text, events = director.commit(s, turn, director.fallback(turn), 'fallback', reason)
    return Conversation(text, events, 'fallback', reason)


async def game_master_route(s: Session, message: str):
    """Let deepagents choose a typed action; never return its untrusted prose."""
    # Only when Gemini is pinned: in auto mode the deterministic router is faster
    # and saves the free tier's requests for the characters.
    if demo_mode() or os.getenv('CHAT_PROVIDER', 'auto').lower() != 'gemini' or not os.getenv('GEMINI_API_KEY'):
        return None
    try:
        from deepagents import create_deep_agent
        from langchain_google_genai import ChatGoogleGenerativeAI
        actions = []
        def call_suspect(suspect_id: str) -> str:
            """Call a person on this case by their id."""
            actions.append({'intent': 'call', 'suspect_id': suspect_id})
            return 'Call selected.'
        def send_document(evidence_id: str) -> str:
            """Open a discovered transaction_sheet or eyewitness document."""
            actions.append({'intent': 'evidence', 'evidence_id': evidence_id})
            return 'Document selected.'
        def cross_examine(first: str, second: str) -> str:
            """Cross-examine two suspects by their IDs."""
            actions.append({'intent': 'cross', 'suspects': [first, second]})
            return 'Pair selected.'
        def write_note() -> str:
            """Open the case notes already collected by the investigator."""
            actions.append({'intent': 'notes'})
            return 'Notes selected.'
        def give_hint() -> str:
            """Ask for an escalating hint."""
            actions.append({'intent': 'hint'})
            return 'Hint selected.'
        def check_contradiction() -> str:
            """Open cross-examination to check competing alibis."""
            actions.append({'intent': 'cross', 'suspects': ['priya', 'marcus']})
            return 'Cross-examination selected.'
        kwargs = {'model': ChatGoogleGenerativeAI(model=os.getenv('GEMINI_CHAT_MODEL', 'gemini-3.5-flash-lite'), api_key=os.environ['GEMINI_API_KEY'], max_retries=0), 'tools': [call_suspect, send_document, cross_examine, write_note, give_hint, check_contradiction], 'system_prompt': 'You are the Game Master of Red Thread. Route one player command using exactly one provided tool. Only use known IDs. Never reveal truth or answer as a suspect. Full case (server private): ' + json.dumps(case_of(s))}
        # Assert the installed API instead of silently ignoring renamed parameters.
        signature = inspect.signature(create_deep_agent)
        if not all(k in signature.parameters for k in kwargs):
            log.warning('Unsupported deepagents signature; using deterministic router.')
            return None
        agent = create_deep_agent(**kwargs)
        await asyncio.wait_for(agent.ainvoke({'messages': [('user', message)]}, config={'recursion_limit': 4}), timeout=5)
        if actions:
            action = actions[0]
            if action.get('suspect_id') and action['suspect_id'] not in suspects_of(s):
                return None
            if action.get('suspects') and (len(set(action['suspects'])) != 2 or not all(x in suspects_of(s) for x in action['suspects'])):
                return None
            if action.get('evidence_id') and action['evidence_id'] not in s.evidence:
                return None
            return action
    except Exception:
        log.warning('Game Master unavailable; using deterministic router.')
    return None
