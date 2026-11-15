"""Local Kokoro-82M speech. No API key, hosted service, or per-request quota."""
from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
from threading import RLock
import wave

MODEL_DIR = Path(__file__).parent / 'models'
VOICES = {'sam': 'am_adam', 'marcus': 'am_michael', 'priya': 'af_kore', 'elena': 'af_sarah', 'theo': 'am_echo',
          'noah': 'am_michael', 'maya': 'af_kore', 'oliver': 'am_adam', 'zara': 'af_sarah'}
_engine = None
_lock = RLock()


def available():
    return (
        os.getenv('KOKORO_ENABLED', 'true').lower() == 'true'
        and importlib.util.find_spec('kokoro_onnx') is not None
        and (MODEL_DIR / 'kokoro-v1.0.int8.onnx').is_file()
        and (MODEL_DIR / 'voices-v1.0.bin').is_file()
    )


def create_audio(sid: str, text: str):
    global _engine
    from kokoro_onnx import Kokoro
    import numpy as np
    with _lock:
        if _engine is None:
            _engine = Kokoro(str(MODEL_DIR / 'kokoro-v1.0.int8.onnx'), str(MODEL_DIR / 'voices-v1.0.bin'))
        samples, sample_rate = _engine.create(text, voice=VOICES[sid], speed=1.0, lang='en-us', sentence_pause=.22, clause_pause=.12)
    pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()
