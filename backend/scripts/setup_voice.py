"""Install the explicitly selected local voice engine."""
import os
from pathlib import Path
from dotenv import load_dotenv


def main():
    load_dotenv(Path(__file__).resolve().parents[2] / '.env')
    provider = os.getenv('TTS_PROVIDER', 'gemini').lower()
    if provider == 'kokoro':
        from .setup_local import main as setup
    elif provider in ('qwen', 'auto', 'gemini'):
        from .setup_qwen import main as setup
    else:
        return
    setup()


if __name__ == '__main__':
    main()
