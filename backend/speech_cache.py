"""Bounded, private disk cache for completed cloud speech."""
import io
import os
from pathlib import Path
import wave


def directory():
    return Path(os.getenv('VOICE_CACHE_DIR') or Path(__file__).resolve().parents[1] / '.dist/gemini-audio')


def get(key):
    path = directory() / f'{key}.wav'
    try:
        data = path.read_bytes()
        with wave.open(io.BytesIO(data), 'rb') as wav:
            if wav.getnframes() < 1:
                return None
        path.touch()
        return data
    except (OSError, EOFError, wave.Error):
        return None


def put(key, data):
    # Provider tests can use sentinels; never persist those as playable speech.
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        return
    root = directory()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f'{key}.wav'
    temporary = path.with_suffix('.part')
    temporary.write_bytes(data)
    temporary.replace(path)
    used = 0
    for cached in sorted(root.glob('*.wav'), key=lambda p: p.stat().st_mtime, reverse=True):
        used += cached.stat().st_size
        if used > 64 * 1024 * 1024:
            cached.unlink(missing_ok=True)
