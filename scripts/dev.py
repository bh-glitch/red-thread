#!/usr/bin/env python3
"""Start both development servers and stop both on Ctrl-C."""
from pathlib import Path
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
PYTHON = ROOT / '.venv/bin/python'


def run(command):
    subprocess.run(command, cwd=ROOT, check=True)


def setup():
    if not shutil.which('node') or not shutil.which('npm'):
        raise SystemExit('Install Node.js 22+ and npm, then run make dev again.')
    if not PYTHON.exists():
        if shutil.which('uv'):
            run(['uv', 'venv', '--python', '3.11', '.venv'])
        elif shutil.which('python3.11'):
            run(['python3.11', '-m', 'venv', '.venv'])
        else:
            raise SystemExit('Install uv (https://docs.astral.sh/uv/) or Python 3.11, then run make dev again.')
    if subprocess.run([str(PYTHON), '-c', 'import fastapi, uvicorn, deepagents, langchain_google_genai, kokoro_onnx, mlx_audio'], capture_output=True).returncode:
        command = ['uv', 'pip', 'install', '--python', str(PYTHON)] if shutil.which('uv') else [str(PYTHON), '-m', 'pip', 'install']
        run(command + ['-r', 'backend/requirements.lock.txt'])
    if not (ROOT / 'node_modules/.package-lock.json').exists():
        run(['npm', 'ci'])
    # Install and verify local voice weights automatically, before either server
    # starts. Existing valid files are reused and require no network connection.
    run([str(PYTHON), '-m', 'backend.scripts.setup_voice'])
    # Hand control assets (MediaPipe WASM + hand model) are served locally.
    run(['node', 'scripts/setup_hands.mjs'])


def main():
    setup()
    if '--setup' in sys.argv:
        return
    for port in (8000, 5173):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise SystemExit(f'Port {port} is already in use. Stop that server first. Game preview: http://127.0.0.1:5173')
    children = []
    def cleanup(*_args):
        for process in children:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for process in children:
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        sys.exit(0)
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    try:
        children.append(subprocess.Popen([str(PYTHON), '-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload'], start_new_session=True))
        children.append(subprocess.Popen(['npm', 'run', 'dev'], start_new_session=True))
        print('\nRed Thread → http://127.0.0.1:5173\nCtrl-C stops both servers.\n', flush=True)
        while all(process.poll() is None for process in children):
            time.sleep(.5)
    finally:
        cleanup()


if __name__ == '__main__':
    main()
