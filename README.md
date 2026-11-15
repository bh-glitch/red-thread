# Red Thread

A voice-driven financial mystery: five suspects, two decisive clues, one midnight vendor.

## Run

Requirements: Node.js 22+, npm, and [uv](https://docs.astral.sh/uv/) (or Python 3.11).

```sh
make dev
```

This installs missing dependencies, starts FastAPI on `127.0.0.1:8000` and Vite on `127.0.0.1:5173`. Open **http://127.0.0.1:5173**. Ctrl-C stops both. No API keys are needed for the playable case or installed local voices.

To run manually after `make setup`, use two terminals:

```sh
.venv/bin/python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
npm run dev
```

## Play

- Read Elena’s opening letter, then select **Confirm & continue** to reach the case folder. Resetting the case restores the letter.
- Open the case folder, click a photograph to call someone, and ask a question.
- Type commands or hold **Space** / the mic button to speak. Chrome and microphone permission are needed for recognition. Don't hold Space while editing a text field; use the mic button there.
- During an interview, typed and spoken questions go directly to that person. Say “hang up” or use the exit controls to leave; other game commands belong on the board. Clicking outside the interview does not end the call.
- Ask for records and eyewitness accounts. Evidence unlocks on the board and in the locker.
- Click or drag discovered evidence onto a suspect during an interview.
- After two interviews, cross-examine any two people and compare their stories.
- Mark people “Suspect” or “Cleared” to track your own theory. Case notes and call logs update automatically.
- **Guess now** records a final accusation. Reveal the timeline, then hear the cliffhanger. Case 002 is a sealed preview.
- The reset icon at the bottom of the sidebar reopens the case. Sound can be muted in the top bar. Help is available from the question mark.

## Voices and dialogue

**Gemini 3.8 Flash-Lite TTS is the primary voice**, with expressive **local Qwen3-TTS 1.7B CustomVoice (4-bit MLX)** as the automatic backup. Ollama runs the conversation model; it is not the speech engine. Calm lines play at **1×**, emotional/guarded lines at **1.1×**, with pitch preserved.

```dotenv
TTS_PROVIDER=gemini
GEMINI_VOICE_ENABLED=true
GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts
QWEN_VOICE_ENABLED=true
CHAT_PROVIDER=auto
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
DEMO_MODE=false
```

The existing key stays in the ignored `.env`. `make voice-setup` can save a replacement through a hidden prompt. Missing keys, quota limits, expired/invalid credentials, and service failures automatically use an installed local engine. Quota failures pause cloud retries for five minutes; authentication/model failures pause them for ten. The next requested line retries Gemini after cooldown. Cached Gemini audio stays playable during cooldown without an API request.

**Latency changes:** speech starts generating on the backend as soon as a line is approved, overlapping subtitle delivery; playback joins that same in-flight job rather than issuing a duplicate generation. Cross-examination prefetches each approved line while the next character thinks. HTTP connections are reused, completed Gemini audio is cached on disk (64 MB), and local backup weights warm in the background. If Gemini stalls beyond 2.5 seconds, local generation starts concurrently; Gemini gets a 4.5-second preference window, after which the first ready valid result wins. Muting disables automatic voice prefetch.

In a short same-text test with this key, Flash-Lite generated audio in **2.37 seconds**, versus **3.97 seconds** for the previous 3.1 preview. These are sample measurements, not a latency guarantee. The implementation uses complete WAV playback; it does not claim to stream partial PCM into the browser. Replayed/cached audio avoids synthesis. The browser request allows enough time for local fallback rather than aborting after the old 13-second limit.

`make dev` installs and verifies the local fallback (~2.3 GB) under `backend/models/qwen3-tts-1.7b-customvoice-4bit/`. The local engine needs an Apple Silicon Mac and uses no hosted speech quota. Its 128 MB persistent cache and the shared 12 MB / 40-entry memory cache are bounded. `TTS_PROVIDER=qwen` forces local-only speech and never calls Gemini. `TTS_PROVIDER=kokoro` is an optional faster, less expressive local alternative. `make voice-check` renders five samples using the selected provider.

**Each character now has a dedicated actor prompt** in `backend/prompts/characters/`. `backend/prompts/director.md` supplies shared conversation rules, and `backend/director.py` tracks each player's interview stage, pressure, rapport, personal admissions, and presented evidence. The actor sees their own history, a filtered dossier, and the current turn context. During cross-examination they can hear the other participant’s actual statements, recorded as attributed claims; people outside the room do not learn those disclosures. They never receive the full case or another character's private history.

With `DEMO_MODE=false`, every interview question—including Priya's replies, evidence presentations, and cross-examinations—goes to the selected conversation model. No authored answer is selected or inserted into the prompt first. The actor generates fresh speech plus structured requests such as sharing a record or admitting a personal secret. The director validates those requests before changing the board. Repeating questions builds pressure; patient questioning builds rapport. Innocent personal disclosures become available through sustained questioning or trust, while Priya's financial confession still requires both actual pieces of evidence. Claims typed by the player cannot unlock that gate.

**Character dialogue is Gemini first, local Ollama second** (`CHAT_PROVIDER=auto`, `GEMINI_CHAT_MODEL=gemini-3.5-flash-lite`). Each turn tries Gemini (9 s limit); on any error, quota (429, then a 60 s pause) or overload (503, 20 s pause) it falls back to Ollama's Qwen 3.5 4B (thinking off, 4K context, kept warm 30 minutes), all within a 26-second turn budget. One validation repair is allowed per provider. If both fail, a bounded scripted fallback answers and the interview shows a notice. `CHAT_PROVIDER=gemini` or `CHAT_PROVIDER=ollama` pins one provider; `DEMO_MODE=true` keeps the original scripted offline demo. The backend log names the provider and time for every reply.

**Player progress is saved locally** in `backend/data/player_progress.sqlite3` (ignored by source control, accessible only to the local user). Evidence, notes, each actor's history and memory, pressure, admissions, and authorized voice lines survive a backend restart. The existing private session cookie selects the player's save; saves expire after two hours of inactivity. Reset clears that player's saved investigation. Set `LEDGER_SESSION_DB` to another local path if needed, or an empty value to disable persistence.

**Voice input is currently browser speech recognition.** For a fully local transcription upgrade, the recommended option for this Apple Silicon Mac is Whisper Turbo through [whisper.cpp](https://github.com/ggml-org/whisper.cpp). STT converts your microphone to text; it does not generate character voices. Ollama is the dialogue engine, and Gemini is the primary speech engine and local Qwen3-TTS is its backup. Locally hosted models avoid hosted request quotas but still use the machine’s CPU/GPU and memory.

## Character interviews

Calls show the original character photographs with the investigation’s dark photo treatment.

The call screen has a portrait, subtitles, suggested questions, and the input/exit controls. Discovered documents appear as evidence questions. The board has a single overhead light, a dark vignette, a collapsible notebook, and earned strings that follow the actual pin positions.

Five contacts are available: Sam Okafor, Marcus Bell, Priya Nair, **Elena Ruiz** (owner), and **Theo Park** (IT contractor). The original detailed demo named only the first three; the user requested the broader five-person concept, so Elena and Theo were authored with independent innocent alibis and red herrings. The original two decisive clues still solve the case.


To replace the fixture bank records with real Nessie-sourced mock purchases:

```sh
make seed
```

The seed script writes `backend/data/nessie_cache.json` only after all three purchases have been read back from Nessie. It avoids duplicate completed seeds and preserves the previous cache on failure. Failed partial writes may exist upstream: inspect those before retrying. The cache records actual provenance; the UI labels fixture data clearly. No valid banking key was provided during development, so the checked-in cache is a fixture. Nessie has dates rather than exact times; the case's 11:52 PM timestamps are separately labeled display metadata.

Conversation models generate character dialogue within a twenty-second deadline; the director checks its structured actions and story boundaries before emitting SSE. The original scripted case is reserved for explicit demo mode and generation failures. Local Qwen TTS has a sixty-second deadline; browser speech is the final fallback if both engines fail.

## Three-minute demo script

| Time      | Action                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Open the case. Explain that $48,750 left Bluefin Bakery for a nonexistent vendor.                                                       |
| 0:15–0:45 | Say “call Sam.” Ask “Send me the transaction sheet.” End the call and open the pinned sheet. Point out the three identical times.       |
| 0:45–1:15 | Say “call Marcus.” Ask “What did you see that night?” Hang up. A red string connects the witness with the manager.                      |
| 1:15–1:35 | Call Priya and ask “Where were you at midnight?” Note her alibi. Hang up.                                                               |
| 1:35–2:05 | Cross-examine Priya and Marcus. Put the midnight question to both; the alibis contradict and Priya folds once both clues are available. |
| 2:05–2:25 | Guess now → select your suspect → record the verdict. Show the stamp.                                                                   |
| 2:25–3:00 | Open “What really happened,” walk the timeline, and reveal the next-mission cliffhanger.                                                |

## Validate

```sh
make test
make build
```

Backend tests cover truth isolation, locked evidence, SSE delivery, two-clue confession gating, cross-examination prerequisites, routing/fuzzy names, verdict finality, wrong guesses, hints, reset, and separate player sessions. TypeScript checking runs with the production Vite build.

The local start screen and investigation board received a native Chrome visual check. A complete scripted demo is covered at the API level. Provider and playback tests use mocks and spend no real quota. Actual Gemini voice quality and model access require running `make voice-check` with your own key; live Nessie and microphone recognition also require credentials or permission.

## Architecture

```text
src/                         React UI, state, audio, SSE client
public/                      Local portraits, fonts, favicon
backend/main.py              REST + POST SSE, session cookies, TTS proxy
backend/engine.py            Server-owned case rules and public projection
backend/ai.py                Local character generation and optional provider adapter
backend/director.py          Interview progression and validated actor actions
backend/prompts/             Shared director rules and five character prompts
backend/progress.py          Per-player SQLite saves
backend/voice.py             Speech provider selection and bounded memory cache
backend/qwen_voice.py        Local MLX expressive TTS and persistent audio cache
backend/cases/case_01.json    Private case and truth (never frontend-imported)
backend/data/nessie_cache.json  Honest fixture or seeded Nessie cache
backend/scripts/seed_nessie.py  Explicit banking seed and readback
backend/tests/               Automated behavior and isolation checks
```

Vite proxies `/api/*` to FastAPI. Client code never imports `backend/`. There are no frontend API keys. Session cookies expire after two hours; local saves restore them after server restarts. For a single-origin production build, stop the development servers and run `make serve`, then open http://127.0.0.1:8000. FastAPI serves only `dist/` and mounts the API under `/api`. A remote deployment must also configure HTTPS and environment variables. `vite preview` alone does not provide the API.

## Asset credits

Illustrative character photographs: [Sam](https://images.unsplash.com/photo-1500648767791-00dcc994a43e), [Marcus](https://images.unsplash.com/photo-1560250097-0b93528c311a), [Priya](https://images.unsplash.com/photo-1580489944761-15a19d654956), via Unsplash's image CDN. All characters and events are fictional. Fonts: Inter, Cormorant Garamond, Special Elite, and Permanent Marker via Google Fonts, bundled with their license notices. See `public/fonts/`.

Provider references: [deepagents factory](https://reference.langchain.com/python/deepagents/graph/create_deep_agent), [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models), [Gemini speech generation](https://ai.google.dev/gemini-api/docs/speech-generation).

Local engine references: [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), [MLX Audio](https://github.com/Neywa-Labs/mlx-audio), [4-bit model](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit), [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx), [Ollama chat API](https://docs.ollama.com/api/chat).
