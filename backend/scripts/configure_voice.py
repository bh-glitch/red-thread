"""Store a Gemini key through a local hidden prompt, never a command argument."""
from getpass import getpass
from pathlib import Path
import os
from dotenv import set_key
from backend.voice import DEFAULT_MODEL

ROOT = Path(__file__).resolve().parents[2]


def main():
    print('Create a key at https://aistudio.google.com/apikey')
    key = getpass('Paste your Gemini API key here (input is hidden): ').strip()
    if len(key) < 20 or any(char.isspace() for char in key):
        raise SystemExit('That does not look like an API key. Nothing was saved.')
    env = ROOT / '.env'
    if not env.exists():
        descriptor = os.open(env, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write((ROOT / '.env.example').read_text())
    env.chmod(0o600)
    set_key(env, 'GEMINI_API_KEY', key)
    set_key(env, 'GEMINI_VOICE_ENABLED', 'true')
    set_key(env, 'GEMINI_TTS_MODEL', DEFAULT_MODEL)
    set_key(env, 'TTS_PROVIDER', 'gemini')
    env.chmod(0o600)
    print('Saved to local .env. Your dialogue mode and other keys were preserved.')
    print('Run make voice-check to hear five samples. Restart make dev, then refresh the game.')


if __name__ == '__main__':
    main()
