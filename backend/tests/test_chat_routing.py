"""Gemini-first character dialogue with local Ollama fallback (no real API calls)."""
import pytest
from backend import ai, director, engine


@pytest.fixture
def auto(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'false')
    monkeypatch.setenv('CHAT_PROVIDER', 'auto')
    monkeypatch.setenv('GEMINI_API_KEY', 'test-key')
    monkeypatch.setattr(ai, '_gemini_paused_until', 0.0)
    calls = []

    def install(gemini, ollama):
        async def fake_gemini(messages):
            calls.append('gemini')
            return await gemini()

        async def fake_ollama(messages, schema):
            calls.append('ollama')
            return await ollama()

        monkeypatch.setattr(ai, '_gemini', fake_gemini)
        monkeypatch.setattr(ai, '_ollama', fake_ollama)
        return calls
    return install


def reply(text):
    async def make():
        return director.ActorReply(reply=text, stance='cooperate', actions=[])
    return make


def fail(message):
    async def make():
        raise ai.ProviderError(message)
    return make


@pytest.mark.asyncio
async def test_gemini_answers_first(auto):
    calls = auto(reply('I was home by ten, detective.'), reply('local'))
    result = await ai.converse(engine.Session(), 'sam', 'Where were you at midnight?')
    assert result.source == 'gemini' and calls == ['gemini']
    assert result.text == 'I was home by ten, detective.'


@pytest.mark.asyncio
async def test_ollama_takes_over_when_gemini_fails(auto):
    calls = auto(fail('gemini: 503 UNAVAILABLE'), reply('I was asleep. Ask Priya.'))
    result = await ai.converse(engine.Session(), 'sam', 'Where were you at midnight?')
    assert result.source == 'ollama' and calls == ['gemini', 'ollama']
    assert result.reason is None


@pytest.mark.asyncio
async def test_invalid_gemini_output_is_repaired_once_then_falls_back(auto):
    async def bad():
        raise ValueError('not JSON')
    calls = auto(bad, reply('Fine. I was at home.'))
    result = await ai.converse(engine.Session(), 'sam', 'Where were you?')
    assert calls == ['gemini', 'gemini', 'ollama'] and result.source == 'ollama'


@pytest.mark.asyncio
async def test_both_failing_uses_the_scripted_fallback(auto):
    auto(fail('gemini down'), fail('ollama down'))
    result = await ai.converse(engine.Session(), 'sam', 'Where were you?')
    assert result.source == 'fallback' and result.reason == 'provider_unavailable'


def test_rate_limit_pauses_gemini(auto, monkeypatch):
    assert ai.chat_providers() == ['gemini', 'ollama']
    ai._pause_gemini(RuntimeError('429 RESOURCE_EXHAUSTED'))
    assert ai.chat_providers() == ['ollama']


def test_provider_selection(monkeypatch):
    monkeypatch.setenv('CHAT_PROVIDER', 'auto')
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    assert ai.chat_providers() == ['ollama']  # no key: local only
    monkeypatch.setenv('GEMINI_API_KEY', 'k')
    monkeypatch.setenv('CHAT_PROVIDER', 'ollama')
    assert ai.chat_providers() == ['ollama']
    monkeypatch.setenv('CHAT_PROVIDER', 'gemini')
    assert ai.chat_providers() == ['gemini']
