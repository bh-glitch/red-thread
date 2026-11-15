import pytest


@pytest.fixture(autouse=True)
def offline_providers(monkeypatch, tmp_path):
    """Tests never spend a real key's quota or change the user's local configuration."""
    monkeypatch.setenv('DEMO_MODE', 'true')
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.setenv('GEMINI_VOICE_ENABLED', 'true')
    monkeypatch.setenv('TTS_PROVIDER', 'gemini')
    monkeypatch.setenv('KOKORO_ENABLED', 'false')
    monkeypatch.setenv('QWEN_VOICE_ENABLED', 'false')
    monkeypatch.setenv('LEDGER_SESSION_DB', '')
    monkeypatch.setenv('CHAT_PROVIDER', 'ollama')
    monkeypatch.setenv('VOICE_PREFETCH_ENABLED', 'false')
    monkeypatch.setenv('VOICE_WARMUP_ENABLED', 'false')
    monkeypatch.setenv('VOICE_CACHE_DIR', str(tmp_path / 'voice-cache'))
