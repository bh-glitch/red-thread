"""Expressive Qwen3-TTS on Apple Silicon. Inference uses only local files."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from threading import RLock
import wave

MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit'
REVISION = 'f35faf19b0cc2160865af64ecf0f22f83d335135'
MODEL_DIR = Path(__file__).parent / 'models/qwen3-tts-1.7b-customvoice-4bit'
CACHE_DIR = Path(__file__).resolve().parents[1] / '.dist/qwen-audio'
# Style instructions distinguish characters sharing a preset. These are fictional
# performances; no recordings or cloned voices are required.
VOICES = {'sam': 'Aiden', 'marcus': 'Ryan', 'priya': 'Serena', 'elena': 'Vivian', 'theo': 'Dylan',
          'noah': 'Ryan', 'maya': 'Serena', 'oliver': 'Aiden', 'zara': 'Vivian'}
_model = None
_lock = RLock()


def warm():
    global _model
    if not available():
        return
    from mlx_audio.tts.utils import load_model
    with _lock:
        if _model is None:
            _model = load_model(str(MODEL_DIR.resolve()))


def available():
    return (
        os.getenv('QWEN_VOICE_ENABLED', 'true').lower() == 'true'
        and importlib.util.find_spec('mlx_audio') is not None
        and (MODEL_DIR / 'model.safetensors').is_file()
        and (MODEL_DIR / 'speech_tokenizer/model.safetensors').is_file()
    )


def create_audio(sid: str, text: str, instruction: str):
    """Serialize MLX work, retain weights, and reuse bounded on-disk WAVs."""
    global _model
    import numpy as np
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model

    key = hashlib.sha256(json.dumps([REVISION, VOICES[sid], instruction, text]).encode()).hexdigest()
    path = CACHE_DIR / f'{key}.wav'
    with _lock:
        if path.is_file():
            path.touch()
            return path.read_bytes()
        if _model is None:
            # Absolute local path: no hub lookup or hosted inference at runtime.
            _model = load_model(str(MODEL_DIR.resolve()))
        chunks = []
        for result in _model.generate(
            text=text, voice=VOICES[sid], instruct=instruction,
            lang_code='English', max_tokens=600, verbose=False,
        ):
            chunks.append(np.asarray(result.audio))
        if not chunks:
            raise ValueError('Local speech returned no audio')
        samples = np.concatenate(chunks)
        pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(_model.sample_rate)
            wav.writeframes(pcm)
        audio = output.getvalue()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.part')
        temporary.write_bytes(audio)
        temporary.replace(path)
        # Cache at most 128 MB across restarts, evicting the least recently used.
        files = sorted(CACHE_DIR.glob('*.wav'), key=lambda p: p.stat().st_mtime, reverse=True)
        size = 0
        for cached in files:
            size += cached.stat().st_size
            if size > 128 * 1024 * 1024:
                cached.unlink(missing_ok=True)
        mx.clear_cache()
        return audio
