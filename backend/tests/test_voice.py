import asyncio
import io
from types import SimpleNamespace
import wave
import pytest
from fastapi.testclient import TestClient
from backend import voice
from backend.engine import CASE
from backend.main import app


@pytest.fixture(autouse=True)
def clean_voice_cache():
    voice._cache.clear()
    voice._gemini_retry_at = 0
    voice._gemini_last_reason = ''
    yield
    voice._cache.clear()


def test_voice_configuration_is_independent_of_demo_mode(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setenv('DEMO_MODE', 'true')
    monkeypatch.setenv('GEMINI_VOICE_ENABLED', 'true')
    with TestClient(app) as c:
        public = c.get('/case/load').json()
        assert public['mode'] == 'demo'
        assert public['audio']['provider'] == 'gemini'
        assert 'unit-test-placeholder' not in str(public)
        monkeypatch.setenv('GEMINI_VOICE_ENABLED', 'false')
        assert c.get('/voice/status').json()['provider'] == 'browser'


def test_voice_is_locked_to_dialogue_issued_to_this_session(monkeypatch):
    calls = []
    async def fake_synthesize(*args):
        calls.append(args)
        return voice.to_wav(b'\0\0' * 24, 'audio/L16;codec=pcm;rate=24000'), 'gemini'
    monkeypatch.setattr('backend.main.synthesize', fake_synthesize)
    with TestClient(app) as c:
        c.get('/case/load')
        opening = CASE['suspects'][0]['opening']
        assert c.post('/tts', json={'suspect_id': 'sam', 'text': opening}).status_code == 403
        c.post('/call/sam/start')
        response = c.post('/tts', json={'suspect_id': 'sam', 'text': opening})
        assert response.status_code == 200
        assert response.headers['content-type'] == 'audio/wav'
        assert response.headers['cache-control'] == 'no-store'
        assert response.content[:4] == b'RIFF'
        assert calls[0][0] == 'sam' and calls[0][3] == 'Puck'
        assert c.post('/tts', json={'suspect_id': 'sam', 'text': 'Read arbitrary content.'}).status_code == 403
        assert c.post('/tts', json={'suspect_id': 'priya', 'text': CASE['cliffhanger']}).status_code == 403
        c.post('/guess', json={'suspect_id': 'priya'})
        c.get('/reveal')
        assert c.post('/tts', json={'suspect_id': 'priya', 'text': CASE['cliffhanger']}).status_code == 200
        c.post('/reset')
        assert c.post('/tts', json={'suspect_id': 'sam', 'text': opening}).status_code == 403


def test_missing_key_and_quota_failures_are_explicit_and_safe(monkeypatch):
    with TestClient(app) as c:
        c.get('/case/load')
        opening = c.post('/call/sam/start').json()['opening']
        response = c.post('/tts', json={'suspect_id': 'sam', 'text': opening})
        assert response.status_code == 503
        assert response.headers['x-voice-fallback'] == 'not_configured'
        async def fail(*_):
            raise voice.VoiceUnavailable('rate_limited')
        monkeypatch.setattr('backend.main.synthesize', fail)
        response = c.post('/tts', json={'suspect_id': 'sam', 'text': opening})
        assert response.status_code == 503
        assert response.headers['x-voice-fallback'] == 'rate_limited'
        assert 'quota' in response.json()['detail']


def test_pressure_changes_performance_without_inventing_dialogue():
    text = 'I-I mean… I was home by ten.'
    calm = voice.delivery_prompt('priya', text, .05)
    strained = voice.delivery_prompt('priya', text, .9)
    assert calm != strained
    assert 'Under pressure' in strained
    assert strained.endswith(text)
    assert 'Read only the transcript verbatim' in strained
    assert 'Northshore' not in strained
    assert 'guilty' not in strained
    assert len({voice.delivery_prompt(sid, 'Hello.', .2) for sid in ('sam', 'marcus', 'priya')}) == 3


@pytest.mark.parametrize('pressure,rate', [(.2, '1'), (.35, '1.1'), (.85, '1.1')])
def test_emotional_lines_get_a_small_playback_boost(monkeypatch, pressure, rate):
    from backend.main import sessions
    async def fake_synthesize(*_):
        return voice.to_wav(b'\0\0' * 24, 'audio/L16;rate=24000'), 'qwen'
    monkeypatch.setattr('backend.main.synthesize', fake_synthesize)
    with TestClient(app) as c:
        c.get('/case/load')
        state = sessions[c.cookies['ledger_session']]
        state.pressure['sam'] = pressure
        text = c.post('/call/sam/start').json()['opening']
        # Playback follows the delivery saved with this line, including on replay.
        state.pressure['sam'] = 0
        response = c.post('/tts', json={'suspect_id': 'sam', 'text': text})
        assert response.status_code == 200
        assert response.headers['x-voice-playback-rate'] == rate


def test_pcm_wrapping_and_existing_wav_are_correct():
    raw = b'\0\0' * 240
    audio = voice.to_wav(raw, 'audio/L16;codec=pcm;rate=24000')
    with wave.open(io.BytesIO(audio), 'rb') as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
        assert wav.getframerate() == 24000 and wav.getnframes() == 240
    assert voice.to_wav(audio, 'audio/wav') == audio
    with pytest.raises(voice.VoiceUnavailable):
        voice.to_wav(b'invalid', 'audio/mp3')
    with pytest.raises(voice.VoiceUnavailable):
        voice.to_wav(b'\0', 'audio/L16;rate=24000')


@pytest.mark.asyncio
async def test_same_delivery_deduplicates_provider_calls_and_caches(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    calls = []
    async def generate(*args):
        calls.append(args)
        await asyncio.sleep(.01)
        return b'cached-wav'
    monkeypatch.setattr(voice, 'generate_audio', generate)
    a, b = await asyncio.gather(voice.synthesize('sam', 'Hello.', .2, 'Puck'), voice.synthesize('sam', 'Hello.', .2, 'Puck'))
    assert a == b == b'cached-wav'
    assert len(calls) == 1
    await voice.synthesize('sam', 'Hello.', .2, 'Puck')
    assert len(calls) == 1
    await voice.synthesize('sam', 'Hello.', .85, 'Puck')
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_cache_has_a_byte_limit(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setattr(voice, 'MAX_CACHE_BYTES', 10)
    async def generate(*_):
        return b'123456'
    monkeypatch.setattr(voice, 'generate_audio', generate)
    await voice.synthesize('sam', 'First.', .2, 'Puck')
    await voice.synthesize('sam', 'Second.', .2, 'Puck')
    assert sum(len(value[1]) for value in voice._cache.values()) <= 10


@pytest.mark.asyncio
async def test_sdk_request_uses_selected_model_voice_and_audio_config(monkeypatch):
    from google import genai
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    captured = {}
    class FakeAsyncClient:
        models = None
        async def __aenter__(self):
            self.models = self
            return self
        async def __aexit__(self, *_):
            pass
        async def generate_content(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(inline_data=SimpleNamespace(data=b'\0\0' * 24, mime_type='audio/L16;rate=24000'))]))])
    monkeypatch.setattr(genai, 'Client', lambda **_: SimpleNamespace(aio=FakeAsyncClient()))
    audio = await voice.generate_audio('gemini-3.1-flash-tts-preview', 'Kore', 'Read this line.')
    assert audio.startswith(b'RIFF')
    assert captured['model'] == 'gemini-3.1-flash-tts-preview'
    assert captured['config'].response_modalities == ['AUDIO']
    assert captured['config'].speech_config.voice_config.prebuilt_voice_config.voice_name == 'Kore'


def test_hidden_key_setup_preserves_other_settings(tmp_path, monkeypatch, capsys):
    from backend.scripts import configure_voice
    monkeypatch.setattr(configure_voice, 'ROOT', tmp_path)
    key = 'unit-test-placeholder-key-not-a-real-secret'
    (tmp_path / '.env').write_text('DEMO_MODE=true\nNESSIE_API_KEY=keep-this-placeholder\n')
    monkeypatch.setattr(configure_voice, 'getpass', lambda _: key)
    configure_voice.main()
    saved = (tmp_path / '.env').read_text()
    assert key in saved and 'keep-this-placeholder' in saved and 'DEMO_MODE=true' in saved
    assert voice.DEFAULT_MODEL in saved
    assert key not in capsys.readouterr().out
    assert (tmp_path / '.env').stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_sdk_wire_request_uses_preview_api_with_speech_config(monkeypatch):
    """Exercise SDK serialization, not a fake SDK: v1 rejects this speechConfig."""
    import base64
    import json
    import httpx
    from google import genai
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    real_client = genai.Client
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url.path == '/v1beta/models/gemini-3.1-flash-tts-preview:generateContent'
        body = json.loads(request.content)
        assert body['generationConfig']['speechConfig']['voice_config']['prebuilt_voice_config']['voice_name'] == 'Puck'
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'inlineData': {'data': base64.b64encode(b'\0\0' * 240).decode(), 'mimeType': 'audio/L16;rate=24000'}}]}}]})
    def client_factory(**kwargs):
        kwargs['http_options'].httpx_async_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return real_client(**kwargs)
    monkeypatch.setattr(genai, 'Client', client_factory)
    audio = await voice.generate_audio('gemini-3.1-flash-tts-preview', 'Puck', 'Hello, detective.')
    assert len(requests) == 1
    assert audio.startswith(b'RIFF')


@pytest.mark.asyncio
async def test_local_voices_need_no_key_and_make_no_cloud_request(monkeypatch):
    monkeypatch.setenv('TTS_PROVIDER', 'auto')
    monkeypatch.setattr(voice.local_voice, 'available', lambda: True)
    monkeypatch.setattr(voice.local_voice, 'create_audio', lambda sid, text: b'local-wav')
    async def forbidden(*_):
        pytest.fail('A local voice must not make a Gemini request.')
    monkeypatch.setattr(voice, 'generate_audio', forbidden)
    assert voice.voice_status()['provider'] == 'kokoro'
    audio, provider = await voice.render_speech('elena', 'Hello.', .2, 'Aoede')
    assert (audio, provider) == (b'local-wav', 'kokoro')


@pytest.mark.asyncio
async def test_quota_failure_falls_back_locally_and_pauses_cloud_requests(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setenv('TTS_PROVIDER', 'gemini')
    monkeypatch.setattr(voice, '_gemini_retry_at', 0)
    monkeypatch.setattr(voice.local_voice, 'available', lambda: True)
    monkeypatch.setattr(voice.local_voice, 'create_audio', lambda sid, text: b'local-fallback')
    calls = []
    async def fail(*_):
        calls.append(True)
        raise voice.VoiceUnavailable('rate_limited')
    monkeypatch.setattr(voice, 'generate_audio', fail)
    assert await voice.render_speech('sam', 'Hello.', .2, 'Puck') == (b'local-fallback', 'kokoro')
    assert voice.voice_status()['provider'] == 'kokoro'
    assert await voice.render_speech('sam', 'Hello again.', .2, 'Puck') == (b'local-fallback', 'kokoro')
    assert len(calls) == 1


def test_local_voice_is_the_default_without_cloud_configuration(monkeypatch):
    monkeypatch.delenv('TTS_PROVIDER', raising=False)
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setattr(voice.qwen_voice, 'available', lambda: True)
    assert voice.voice_status()['provider'] == 'qwen'
    assert voice.voice_status()['model'].startswith('Qwen3-TTS 1.7B')


@pytest.mark.asyncio
async def test_explicit_local_mode_never_spends_a_saved_cloud_key_when_models_are_missing(monkeypatch):
    monkeypatch.setenv('TTS_PROVIDER', 'kokoro')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setattr(voice.local_voice, 'available', lambda: False)
    async def forbidden(*_):
        pytest.fail('Local-only mode must not fall through to a hosted voice provider.')
    monkeypatch.setattr(voice, 'generate_audio', forbidden)
    with pytest.raises(voice.VoiceUnavailable) as error:
        await voice.render_speech('sam', 'Hello.', .2, 'Puck')
    assert error.value.reason == 'local_unavailable'


@pytest.mark.asyncio
async def test_qwen_receives_emotion_and_never_uses_a_saved_cloud_key(monkeypatch):
    monkeypatch.setenv('TTS_PROVIDER', 'qwen')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setattr(voice.qwen_voice, 'available', lambda: True)
    calls = []
    def generate(sid, text, instruction):
        calls.append((sid, text, instruction))
        return b'emotional-local-wav'
    async def forbidden(*_):
        pytest.fail('Qwen mode must never call Gemini.')
    monkeypatch.setattr(voice.qwen_voice, 'create_audio', generate)
    monkeypatch.setattr(voice, 'generate_audio', forbidden)
    text = 'I-I mean… I was home by ten.'
    assert await voice.render_speech('priya', text, .1, 'Kore') == (b'emotional-local-wav', 'qwen')
    await voice.render_speech('priya', text, .9, 'Kore')
    await voice.render_speech('priya', text, .9, 'Kore')
    assert len(calls) == 2
    assert all(call[1] == text for call in calls)
    assert 'Conversational and steady' in calls[0][2]
    assert 'Under pressure' in calls[1][2]
    assert 'Northshore' not in calls[1][2]
    monkeypatch.setattr(voice.qwen_voice, 'available', lambda: False)
    with pytest.raises(voice.VoiceUnavailable) as error:
        await voice.render_speech('priya', text, .9, 'Kore')
    assert error.value.reason == 'local_unavailable'


@pytest.mark.asyncio
async def test_qwen_failure_stays_local_and_reports_unavailability(monkeypatch):
    monkeypatch.setenv('TTS_PROVIDER', 'qwen')
    monkeypatch.setattr(voice.qwen_voice, 'available', lambda: True)
    def fail(*_):
        raise RuntimeError('local runtime failed')
    monkeypatch.setattr(voice.qwen_voice, 'create_audio', fail)
    with pytest.raises(voice.VoiceUnavailable) as error:
        await voice.render_speech('sam', 'Hello.', .1, 'Puck')
    assert error.value.reason == 'local_unavailable'


@pytest.mark.asyncio
async def test_modern_gemini_separates_verbatim_transcript_from_emotional_style(monkeypatch):
    import base64
    import json
    import httpx
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    text = 'I-I mean… I was home by ten.'
    wav = voice.to_wav(b'\0\0' * 240, 'audio/L16;rate=24000')
    def handler(request):
        assert request.url.path == '/v1beta/interactions'
        body = json.loads(request.content)
        assert body['model'] == 'gemini-3.8-flash-lite-tts'
        part = body['input'][0]['content'][0]
        assert part['text'] == text
        assert 'Under pressure' in part['annotations'][0]['style']
        assert body['generation_config']['speech_config'] == [{'voice': 'Kore'}]
        return httpx.Response(200, json={'steps': [{'content': [{'type': 'audio', 'data': base64.b64encode(wav).decode(), 'mime_type': 'audio/wav'}]}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(voice, 'http_client', lambda: client)
        assert await voice.generate_audio(voice.DEFAULT_MODEL, 'Kore', voice.delivery_prompt('priya', text, .9)) == wav


@pytest.mark.asyncio
async def test_gemini_quota_uses_expressive_qwen_and_stops_retrying_cloud(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setattr(voice.qwen_voice, 'available', lambda: True)
    monkeypatch.setattr(voice.local_voice, 'available', lambda: True)
    monkeypatch.setattr(voice.qwen_voice, 'create_audio', lambda *args: b'emotional-backup')
    calls = []
    async def limited(*_):
        calls.append(True)
        raise voice.VoiceUnavailable('rate_limited')
    monkeypatch.setattr(voice, 'generate_audio', limited)
    assert await voice.render_speech('priya', 'I was home.', .8, 'Kore') == (b'emotional-backup', 'qwen')
    assert voice.voice_status()['fallback_reason'] == 'rate_limited'
    assert await voice.render_speech('sam', 'Hello.', .2, 'Puck') == (b'emotional-backup', 'qwen')
    assert len(calls) == 1
    assert voice._gemini_retry_at > voice.time.monotonic() + 290
    await voice.close_voice()


@pytest.mark.asyncio
async def test_slow_gemini_does_not_delay_starting_the_local_backup(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    monkeypatch.setattr(voice, 'local_provider', lambda: 'qwen')
    monkeypatch.setattr(voice, 'BACKUP_START_SECONDS', .001)
    monkeypatch.setattr(voice, 'GEMINI_GRACE_SECONDS', .005)
    cloud_release = asyncio.Event()
    local_started = asyncio.Event()
    async def render(sid, text, pressure, selected, provider):
        if provider == 'gemini':
            await cloud_release.wait()
            return b'cloud-later'
        local_started.set()
        return b'local-now'
    monkeypatch.setattr(voice, '_cached_speech', render)
    assert await asyncio.wait_for(voice.render_speech('sam', 'Hello.', .1, 'Puck'), timeout=1) == (b'local-now', 'qwen')
    assert local_started.is_set() and not cloud_release.is_set()
    cloud_release.set()
    await voice.close_voice()


@pytest.mark.asyncio
async def test_completed_gemini_audio_survives_memory_cache_clear_and_quota(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    wav = voice.to_wav(b'\0\0' * 240, 'audio/L16;rate=24000')
    calls = []
    async def render(*_):
        calls.append(True)
        return wav
    monkeypatch.setattr(voice, 'generate_audio', render)
    assert await voice.render_speech('sam', 'Persistent line.', .2, 'Puck') == (wav, 'gemini')
    voice._cache.clear()
    voice.pause_primary('rate_limited')
    assert await voice.render_speech('sam', 'Persistent line.', .2, 'Puck') == (wav, 'gemini')
    assert len(calls) == 1
    await voice.close_voice()


@pytest.mark.asyncio
async def test_approved_reply_prefetch_and_playback_share_one_cloud_request(monkeypatch):
    monkeypatch.setenv('VOICE_PREFETCH_ENABLED', 'true')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-placeholder')
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def generate(*_):
        calls.append(True)
        started.set()
        await release.wait()
        return b'prefetched-audio'
    monkeypatch.setattr(voice, 'generate_audio', generate)
    voice.prefetch_speech('sam', 'Hello.', .2, 'Puck')
    await started.wait()
    foreground = asyncio.create_task(voice.render_speech('sam', 'Hello.', .2, 'Puck'))
    await asyncio.sleep(0)
    release.set()
    assert await foreground == (b'prefetched-audio', 'gemini')
    assert len(calls) == 1
    await voice.close_voice()


def test_muted_interviews_do_not_prefetch_or_spend_voice_quota(monkeypatch):
    prefetched = []
    monkeypatch.setattr('backend.main.prefetch_speech', lambda *args: prefetched.append(args))
    with TestClient(app) as c:
        c.get('/case/load')
        c.post('/call/sam/start', json={'voice': False})
        c.post('/call/sam/say', json={'message': 'Send the transaction sheet.', 'voice': False})
        c.post('/call/marcus/start', json={'voice': False})
        c.post('/cross', json={'suspects': ['sam', 'marcus'], 'voice': False})
        assert not prefetched
