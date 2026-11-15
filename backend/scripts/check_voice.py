"""Render a short sample for every character using the selected speech engine."""
import asyncio
import io
import time
import wave
from pathlib import Path
from dotenv import load_dotenv
from backend.engine import SUSPECTS
from backend.voice import synthesize, voice_status, VoiceUnavailable
from backend.local_voice import VOICES
from backend.qwen_voice import VOICES as QWEN_VOICES

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / '.env', override=True)
SAMPLES = {
    'sam': ('Y-yes, detective. I can send the sheet. Just… give me a second.', .55),
    'marcus': ('Look, I was outside fixing the van. I can tell you what I saw.', .25),
    'priya': ('I-I mean… I was home by ten. Every night. Why would that change?', .85),
    'elena': ('I just wanted to protect the staff. Please… you have to understand.', .55),
    'theo': ('My maintenance session ended at nine-ten. I can explain the server.', .3),
}


async def main():
    if voice_status()['provider'] == 'browser':
        if voice_status()['model'].startswith(('Kokoro', 'Qwen')):
            raise SystemExit('Local voice models are not ready. Run make setup first.')
        raise SystemExit('No Gemini key configured. Run make voice-setup first.')
    output = ROOT / '.dist/voice-samples'
    output.mkdir(parents=True, exist_ok=True)
    print('Checking', voice_status()['model'], f'with {len(SAMPLES)} short voice samples…')
    for sid, (text, pressure) in SAMPLES.items():
        started = time.monotonic()
        try:
            audio = await synthesize(sid, text, pressure, SUSPECTS[sid]['voice'])
        except VoiceUnavailable as error:
            remedies = {
                'local_unavailable': 'Local speech could not start. Run make setup to verify its dependencies and model files.',
                'invalid_request': 'Google rejected the request format. Preview TTS must use the v1beta API.',
                'authentication': 'Google rejected the key or project access. Check your saved key in .env.',
                'rate_limited': 'The project voice quota is exhausted. Wait for its quota to reset before retrying.',
                'model_unavailable': 'This TTS model is not available to your project.',
                'network': 'The connection to Google failed. Check your network connection.',
                'timeout': 'The selected voice engine took too long to generate the clip.',
                'service_unavailable': 'Google voice is temporarily unavailable. Try again later.',
            }
            raise SystemExit(f'Voice check failed ({error.reason}). ' + remedies.get(error.reason, 'The selected voice engine is unavailable.')) from None
        path = output / f'{sid}.wav'
        path.write_bytes(audio)
        selected_voice = QWEN_VOICES[sid] if voice_status()['provider'] == 'qwen' else VOICES[sid] if voice_status()['provider'] == 'kokoro' else SUSPECTS[sid]['voice']
        with wave.open(io.BytesIO(audio), 'rb') as wav:
            duration = wav.getnframes() / wav.getframerate()
        print(f'{SUSPECTS[sid]["name"]} ({selected_voice}): {path} — {duration:.1f}s audio, {time.monotonic() - started:.1f}s generation', flush=True)
    print('Voice check passed. Open the WAV files to compare delivery.')


if __name__ == '__main__':
    asyncio.run(main())
