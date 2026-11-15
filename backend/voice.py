"""Gemini-first expressive speech with a warm local backup and bounded caches."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import os
import re
import time
import wave
from collections import OrderedDict
import httpx
from . import local_voice, qwen_voice, speech_cache

DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts'
TIMEOUT_SECONDS = 12
QWEN_TIMEOUT_SECONDS = 60
EMOTIONAL_PRESSURE = .35
MAX_CACHE_BYTES = 12 * 1024 * 1024
MAX_CACHE_ENTRIES = 40
CACHE_TTL = 900
log = logging.getLogger(__name__)
_cache: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
_pending: dict[str, asyncio.Task] = {}
_gemini_retry_at = 0.0
_gemini_last_reason = ''
GEMINI_GRACE_SECONDS = 4.5
BACKUP_START_SECONDS = 2.5
_background: set[asyncio.Task] = set()
_http_clients: dict[object, httpx.AsyncClient] = {}

PERSONAS = {
    'sam': 'An approachable, thoughtful bookkeeper. A light conversational voice; a little self-conscious, with warmth and a quick breath before difficult answers.',
    'marcus': 'A grounded delivery driver. Relaxed, slightly gravelly delivery, plain-spoken and direct; defensive when embarrassed, never sinister.',
    'priya': 'A composed operations manager. Clear, precise, unhurried professional delivery. Controlled at first; strain should emerge gradually, never from the opening line.',
    'elena': 'A tired bakery owner. Warm, protective, a little husky; worry catches in her voice when the staff or rent are mentioned.',
    'theo': 'A young IT contractor. Quiet, dry and matter-of-fact; brief awkward pauses when admitting something embarrassing.',
    # Case 002 · Seven Minutes in the Dark
    'noah': 'A 22-year-old best friend. Warm, quick, a little sarcastic; protective of Ethan, and noticeably defensive when money comes up.',
    'maya': 'A 22-year-old ex-girlfriend. Confident, measured and guarded; sharp when cornered, with real worry underneath.',
    'oliver': 'A 23-year-old roommate. Calm, precise and analytical; smooth technical explanations, tightening very slightly under pressure.',
    'zara': 'A 22-year-old party organizer. Bright, sociable and persuasive; practical, but uncomfortable when asked how close she is to Ethan.',
}


class VoiceUnavailable(Exception):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def local_provider():
    return 'qwen' if qwen_voice.available() else 'kokoro' if local_voice.available() else 'browser'


def voice_status():
    configured = bool(os.getenv('GEMINI_API_KEY', '').strip())
    enabled = os.getenv('GEMINI_VOICE_ENABLED', 'true').lower() == 'true'
    local = local_provider()
    requested = os.getenv('TTS_PROVIDER', 'gemini').lower()
    provider = 'browser'
    if requested == 'qwen' and qwen_voice.available():
        provider = 'qwen'
    elif requested == 'kokoro' and local_voice.available():
        provider = 'kokoro'
    elif requested in ('auto', 'gemini'):
        provider = 'gemini' if configured and enabled and time.monotonic() >= _gemini_retry_at else local
    return {
        'provider': provider,
        'configured': True if provider in ('qwen', 'kokoro') else configured,
        'enabled': True if provider in ('qwen', 'kokoro') else enabled,
        'model': 'Qwen3-TTS 1.7B CustomVoice (local, 4-bit)' if provider == 'qwen' or requested == 'qwen' else 'Kokoro-82M (local)' if provider == 'kokoro' or requested == 'kokoro' else os.getenv('GEMINI_TTS_MODEL') or DEFAULT_MODEL,
        'local_available': local != 'browser',
        'primary_provider': requested,
        'fallback_reason': _gemini_last_reason if time.monotonic() < _gemini_retry_at and provider != 'gemini' else '',
        'timeout_ms': 70000,
    }


def delivery_instruction(sid: str, pressure: float):
    if pressure < EMOTIONAL_PRESSURE:
        delivery = 'Conversational and steady. Let ordinary punctuation breathe. No extra stammering.'
    elif pressure < .7:
        delivery = 'A little guarded. Brief pauses before sensitive phrases, one restrained hesitation, a subtle breath. Keep the words easy to understand.'
    else:
        delivery = 'Under pressure: a slightly uneven breath, a small catch before a denial, and short self-corrections. Speak the written repetitions as natural false starts. Do not exaggerate or stutter on every word.'
    if sid == 'sam':
        delivery += ' His nerves come from embarrassment; keep him helpful and human.'
    elif sid == 'marcus':
        delivery += ' Keep him direct. Prefer a hesitant pause to a repeated syllable.'
    return PERSONAS[sid] + ' Speak in English, like a private telephone interview. ' + delivery + ' Read the supplied text exactly. No additional words, music or sound effects.'


def delivery_prompt(sid: str, text: str, pressure: float):
    return (
        '# Audio profile\n' + PERSONAS[sid] + '\n'
        '# Scene\nA private telephone interview in a quiet financial investigation. One speaker only, close-mic, no music or sound effects.\n'
        '# Delivery\n' + delivery_instruction(sid, pressure) + '\n'
        'Read only the transcript verbatim. Preserve its words, numbers, ellipses, and false starts. Never add dialogue, facts, or a confession. Do not read these directions aloud.\n'
        '# Transcript\n' + text
    )


def to_wav(raw: bytes, mime_type: str):
    """Gemini preview output is PCM; accept already-wrapped WAV without double headers."""
    if raw[:4] == b'RIFF' and raw[8:12] == b'WAVE':
        with wave.open(io.BytesIO(raw), 'rb') as wav:
            if wav.getnframes() < 1:
                raise VoiceUnavailable('invalid_audio')
        return raw
    if not (mime_type.startswith('audio/L16') or mime_type.startswith('audio/l16') or mime_type.startswith('audio/pcm')):
        raise VoiceUnavailable('invalid_audio')
    match = re.search(r'rate=(\d+)', mime_type)
    rate = int(match.group(1)) if match else 24000
    if not raw or len(raw) % 2 or not 8000 <= rate <= 48000:
        raise VoiceUnavailable('invalid_audio')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(raw)
    return output.getvalue()


async def generate_audio(model: str, voice: str, prompt: str):
    from google import genai
    from google.genai import types
    try:
        if model.startswith('gemini-3.8-'):
            return await generate_modern_gemini(model, voice, prompt)
        # google-genai 3.x defaults to v1. Preview TTS speechConfig is supported
        # by v1beta; relying on the SDK default yields an unrelated-looking 400.
        http = types.HttpOptions(api_version='v1beta', timeout=TIMEOUT_SECONDS * 1000, retry_options=types.HttpRetryOptions(attempts=1))
        async with genai.Client(api_key=os.environ['GEMINI_API_KEY'], http_options=http).aio as client:
            result = await asyncio.wait_for(client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_modalities=['AUDIO'],
                    speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))),
                ),
            ), timeout=TIMEOUT_SECONDS)
        for candidate in result.candidates or []:
            for part in candidate.content.parts if candidate.content else []:
                data = part.inline_data
                if data and data.data:
                    return to_wav(data.data, data.mime_type or '')
        raise VoiceUnavailable('empty_audio')
    except VoiceUnavailable:
        raise
    except (TimeoutError, httpx.TimeoutException):
        raise VoiceUnavailable('timeout') from None
    except httpx.NetworkError:
        raise VoiceUnavailable('network') from None
    except Exception as error:
        code = getattr(error, 'code', None)
        reason = {400: 'invalid_request', 429: 'rate_limited', 401: 'authentication', 403: 'authentication', 404: 'model_unavailable', 503: 'service_unavailable'}.get(code, 'provider_error')
        # Never log provider exception strings: they may include request credentials.
        log.warning('Gemini voice unavailable (%s).', reason)
        raise VoiceUnavailable(reason) from None


def http_client():
    loop = asyncio.get_running_loop()
    if loop not in _http_clients:
        _http_clients[loop] = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, limits=httpx.Limits(max_connections=6, max_keepalive_connections=4, keepalive_expiry=60))
    return _http_clients[loop]


async def generate_modern_gemini(model, voice, prompt):
    directions, marker, transcript = prompt.partition('# Transcript\n')
    style = directions.partition('# Delivery\n')[2].partition('\nRead only the transcript')[0] if marker else 'Natural conversational English.'
    response = await http_client().post(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers={'x-goog-api-key': os.environ['GEMINI_API_KEY']},
        json={
            'model': model,
            'input': [{'type': 'user_input', 'content': [{'type': 'text', 'text': transcript if marker else prompt, 'annotations': [{'type': 'speech_metadata', 'style': style}]}]}],
            'response_format': {'type': 'audio'},
            'generation_config': {'speech_config': [{'voice': voice}]},
        },
    )
    if response.is_error:
        reason = {400: 'invalid_request', 401: 'authentication', 403: 'authentication', 404: 'model_unavailable', 429: 'rate_limited', 503: 'service_unavailable'}.get(response.status_code, 'provider_error')
        raise VoiceUnavailable(reason)
    result = response.json()
    for step in reversed(result.get('steps', [])):
        for item in step.get('content', []):
            if item.get('type') == 'audio' and item.get('data'):
                return to_wav(base64.b64decode(item['data']), item.get('mime_type', 'audio/wav'))
    raise VoiceUnavailable('empty_audio')


def identity(sid, text, pressure, voice, provider):
    model = (os.getenv('GEMINI_TTS_MODEL') or DEFAULT_MODEL) if provider == 'gemini' else qwen_voice.REVISION if provider == 'qwen' else 'kokoro-82m'
    prompt = delivery_prompt(sid, text, pressure) if provider in ('gemini', 'qwen') else text
    if provider == 'qwen':
        voice = qwen_voice.VOICES[sid]
    key = hashlib.sha256((provider + '\0' + model + '\0' + voice + '\0' + prompt).encode()).hexdigest()
    return model, voice, prompt, key


async def _cached_speech(sid: str, text: str, pressure: float, voice: str, provider: str):
    model, voice, prompt, key = identity(sid, text, pressure, voice, provider)
    now = time.monotonic()
    for stale in [k for k, (created, _) in _cache.items() if now - created > CACHE_TTL]:
        _cache.pop(stale)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key][1]
    if provider == 'gemini':
        saved = speech_cache.get(key)
        if saved:
            return saved
    async def render():
        if provider == 'gemini':
            audio = await generate_audio(model, voice, prompt)
            speech_cache.put(key, audio)
        elif provider == 'qwen':
            audio = await asyncio.wait_for(asyncio.to_thread(qwen_voice.create_audio, sid, text, delivery_instruction(sid, pressure)), timeout=QWEN_TIMEOUT_SECONDS)
        else:
            audio = await asyncio.wait_for(asyncio.to_thread(local_voice.create_audio, sid, text), timeout=TIMEOUT_SECONDS)
        if len(audio) <= MAX_CACHE_BYTES:
            _cache[key] = (time.monotonic(), audio)
            while len(_cache) > MAX_CACHE_ENTRIES or sum(len(value[1]) for value in _cache.values()) > MAX_CACHE_BYTES:
                _cache.popitem(last=False)
        return audio
    if key not in _pending:
        _pending[key] = asyncio.create_task(render())
        def finished(task):
            _pending.pop(key, None)
            if not task.cancelled():
                task.exception()  # Consume errors even if a disconnected client stopped awaiting.
        _pending[key].add_done_callback(finished)
    return await asyncio.shield(_pending[key])


def background(coroutine):
    task = asyncio.create_task(coroutine)
    _background.add(task)
    def finished(done):
        _background.discard(done)
        if not done.cancelled():
            done.exception()
    task.add_done_callback(finished)
    return task


def pause_primary(reason):
    global _gemini_retry_at, _gemini_last_reason
    seconds = 300 if reason == 'rate_limited' else 600 if reason in ('authentication', 'model_unavailable', 'invalid_request') else 30
    deadline = time.monotonic() + seconds
    if deadline > _gemini_retry_at:
        _gemini_retry_at, _gemini_last_reason = deadline, reason


async def render_speech(sid: str, text: str, pressure: float, voice: str):
    status = voice_status()
    requested = os.getenv('TTS_PROVIDER', 'gemini').lower()
    if requested in ('gemini', 'auto') and os.getenv('GEMINI_API_KEY') and os.getenv('GEMINI_VOICE_ENABLED', 'true').lower() == 'true':
        # Already generated Gemini speech remains usable even during quota cooldown.
        key = identity(sid, text, pressure, voice, 'gemini')[3]
        cached = _cache.get(key)
        saved = cached[1] if cached and time.monotonic() - cached[0] <= CACHE_TTL else speech_cache.get(key)
        if saved:
            return saved, 'gemini'
    provider = status['provider']
    if provider == 'browser':
        if requested in ('qwen', 'kokoro'):
            raise VoiceUnavailable('local_unavailable')
        raise VoiceUnavailable('not_configured' if not status['configured'] else 'disabled')
    if provider != 'gemini':
        try:
            return await _cached_speech(sid, text, pressure, voice, provider), provider
        except Exception:
            raise VoiceUnavailable('local_unavailable') from None
    backup_provider = local_provider()
    backup = None
    cloud = background(_cached_speech(sid, text, pressure, voice, 'gemini'))
    def cloud_finished(task):
        if not task.cancelled():
            error = task.exception()
            if isinstance(error, VoiceUnavailable):
                pause_primary(error.reason)
    cloud.add_done_callback(cloud_finished)
    try:
        done, _ = await asyncio.wait({cloud}, timeout=BACKUP_START_SECONDS)
        if cloud in done:
            return cloud.result(), 'gemini'
        if backup_provider != 'browser':
            # Start local work while Gemini is in flight, rather than waiting for
            # a cloud timeout and THEN paying a full local generation delay.
            backup = background(_cached_speech(sid, text, pressure, voice, backup_provider))
        done, _ = await asyncio.wait({cloud}, timeout=max(0, GEMINI_GRACE_SECONDS - BACKUP_START_SECONDS))
        if cloud in done:
            return cloud.result(), 'gemini'
        if backup is None:
            raise VoiceUnavailable('timeout')
        done, _ = await asyncio.wait({cloud, backup}, return_when=asyncio.FIRST_COMPLETED)
        if cloud in done:
            return cloud.result(), 'gemini'
        pause_primary('timeout')
        return backup.result(), backup_provider
    except VoiceUnavailable as error:
        pause_primary(error.reason)
        if backup_provider == 'browser':
            raise
        try:
            audio = await backup if backup is not None else await _cached_speech(sid, text, pressure, voice, backup_provider)
            return audio, backup_provider
        except Exception:
            raise VoiceUnavailable('local_unavailable') from None
    except Exception:
        pause_primary('provider_error')
        if backup_provider != 'browser':
            try:
                return await _cached_speech(sid, text, pressure, voice, backup_provider), backup_provider
            except Exception:
                pass
        raise VoiceUnavailable('provider_error') from None


def prefetch_speech(sid, text, pressure, voice):
    if os.getenv('VOICE_PREFETCH_ENABLED', 'true').lower() == 'true' and voice_status()['provider'] != 'browser':
        background(render_speech(sid, text, pressure, voice))


def warm_local_backup():
    if os.getenv('VOICE_WARMUP_ENABLED', 'true').lower() == 'true' and qwen_voice.available():
        background(asyncio.to_thread(qwen_voice.warm))


async def close_voice():
    loop = asyncio.get_running_loop()
    tasks = [task for task in list(_background) if task.get_loop() is loop]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    client = _http_clients.pop(loop, None)
    if client:
        await client.aclose()


async def synthesize(sid: str, text: str, pressure: float, voice: str):
    return (await render_speech(sid, text, pressure, voice))[0]
