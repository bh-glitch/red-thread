"""Download a pinned MLX model once; subsequent setup can run offline."""
from pathlib import Path
import hashlib
import json
import platform

from backend.qwen_voice import MODEL_DIR, MODEL_ID, REVISION


def digest_file(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('This Qwen runtime needs an Apple Silicon Mac (MLX).')
    manifest = MODEL_DIR / 'ledger-manifest.json'
    if manifest.exists():
        expected = json.loads(manifest.read_text())
        if expected['revision'] == REVISION and all(
            (MODEL_DIR / name).is_file() and digest_file(MODEL_DIR / name) == digest
            for name, digest in expected['files'].items()
        ):
            print('Local expressive Qwen3-TTS ready (verified, no download needed).')
            return
    from huggingface_hub import snapshot_download
    print('Downloading Qwen3-TTS 1.7B CustomVoice 4-bit (~2.3 GB), once…', flush=True)
    snapshot_download(MODEL_ID, revision=REVISION, local_dir=MODEL_DIR, ignore_patterns=['.gitattributes'], max_workers=4)
    files = {
        str(path.relative_to(MODEL_DIR)): digest_file(path)
        for path in MODEL_DIR.rglob('*')
        if path.is_file() and '.cache' not in path.parts and path != manifest
    }
    manifest.write_text(json.dumps({'revision': REVISION, 'files': files}, indent=2) + '\n')
    print('Local expressive Qwen3-TTS ready. No API key or speech credits needed.')


if __name__ == '__main__':
    main()
