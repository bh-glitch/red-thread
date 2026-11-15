"""Download the exact Kokoro release weights, validate SHA-256, and keep them local."""
import hashlib
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1] / 'models'
RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/'
FILES = {
    'kokoro-v1.0.int8.onnx': 'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for filename, expected in FILES.items():
        target = ROOT / filename
        if target.exists() and digest(target) == expected:
            print(filename, 'ready.')
            continue
        temporary = target.with_suffix(target.suffix + '.part')
        print('Downloading', filename, '(one-time download)…')
        with httpx.stream('GET', RELEASE + filename, follow_redirects=True, timeout=60) as response:
            response.raise_for_status()
            with temporary.open('wb') as out:
                for chunk in response.iter_bytes():
                    out.write(chunk)
        if digest(temporary) != expected:
            temporary.unlink(missing_ok=True)
            raise SystemExit('Model checksum mismatch. No existing model was replaced.')
        temporary.replace(target)
    print('Local Kokoro voices are ready. TTS_PROVIDER=kokoro keeps all speech local.')
    print('For local dialogue, start Ollama and set OLLAMA_MODEL to an installed chat model.')


if __name__ == '__main__':
    main()
