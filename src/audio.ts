import { useGame } from "./store";
let context: AudioContext | null = null;
let thunderBuffer: AudioBuffer | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let generation = 0;
let pendingRequest: AbortController | null = null;
let finishPlayback: (() => void) | null = null;
export function stopSpeech() {
  generation++;
  pendingRequest?.abort();
  pendingRequest = null;
  const finish = finishPlayback;
  finishPlayback = null;
  currentAudio?.pause();
  currentAudio = null;
  window.speechSynthesis?.cancel();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  finish?.();
  useGame.getState().setVoiceStatus("idle");
}
export function sound(type: "pin" | "phone" | "stamp" | "paper") {
  if (useGame.getState().muted) return;
  try {
    context ??= new AudioContext();
    void context.resume();
    const osc = context.createOscillator(),
      gain = context.createGain();
    osc.connect(gain);
    gain.connect(context.destination);
    osc.type = type === "stamp" ? "triangle" : "sine";
    osc.frequency.setValueAtTime(
      type === "phone"
        ? 440
        : type === "stamp"
          ? 100
          : type === "pin"
            ? 1000
            : 350,
      context.currentTime,
    );
    osc.frequency.exponentialRampToValueAtTime(50, context.currentTime + 0.12);
    gain.gain.setValueAtTime(
      type === "stamp" ? 0.25 : 0.06,
      context.currentTime,
    );
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    osc.start();
    osc.stop(context.currentTime + 0.2);
  } catch {
    /* Audio unavailable; all information is also visual. */
  }
}

/** Quiet distant thunder, made once locally and reused; returns an immediate stop. */
export function thunder(): (() => void) | undefined {
  // The case-opening sound unlocks this shared context from a user gesture.
  // Resumed games without an audio gesture remain silent until it is unlocked.
  if (useGame.getState().muted || !context || context.state !== "running") return;
  try {
    const duration = 5;
    if (!thunderBuffer) {
      thunderBuffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
      const samples = thunderBuffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < samples.length; i++) {
        const t = i / context.sampleRate;
        const white = Math.random() * 2 - 1;
        brown = (brown + .025 * white) / 1.025;
        const roll = .65 + .2 * Math.sin(t * 4.1) + .15 * Math.sin(t * 7.7);
        const envelope = Math.min(1, t / .55) * Math.pow(1 - t / duration, 1.6);
        samples[i] = (brown * 3.5 + white * .025) * envelope * roll;
      }
    }
    const source = context.createBufferSource();
    const low = context.createBiquadFilter();
    const high = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = thunderBuffer;
    low.type = "lowpass";
    low.frequency.setValueAtTime(430, context.currentTime);
    low.frequency.exponentialRampToValueAtTime(100, context.currentTime + duration);
    low.Q.value = .5;
    high.type = "highpass";
    high.frequency.value = 35;
    gain.gain.value = .24;
    source.connect(low);
    low.connect(high);
    high.connect(gain);
    gain.connect(context.destination);
    const disconnect = () => {
      source.disconnect();
      low.disconnect();
      high.disconnect();
      gain.disconnect();
    };
    source.onended = disconnect;
    source.start();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      source.stop();
      disconnect();
    };
  } catch {
    // Atmosphere is optional; audio support never blocks the investigation.
    return;
  }
}
async function playLine(text: string, sid: string, request: number) {
  const state = useGame.getState();
  const status = state.setVoiceStatus;
  let fallbackNotice = "";
  let playbackRate = 1;
  if (
    ["gemini", "qwen", "kokoro"].includes(state.data?.audio?.provider ?? "")
  ) {
    status("generating");
    const controller = new AbortController();
    pendingRequest = controller;
    const timer = window.setTimeout(
      () => controller.abort(),
      state.data?.audio?.timeout_ms ?? 70000,
    );
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspect_id: sid, text }),
        signal: controller.signal,
      });
      if (request !== generation) return;
      playbackRate =
        response.headers.get("X-Voice-Playback-Rate") === "1.1" ? 1.1 : 1;
      if (response.headers.get("X-Voice-Fallback"))
        fallbackNotice =
          "Gemini voice is temporarily unavailable. Using the local character voice.";
      if (response.ok) {
        const blob = await response.blob();
        if (request !== generation) return;
        window.clearTimeout(timer);
        pendingRequest = null;
        const url = URL.createObjectURL(blob);
        currentUrl = url;
        const player = new Audio(url);
        player.playbackRate = playbackRate;
        player.preservesPitch = true;
        currentAudio = player;
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            if (finishPlayback === finish) finishPlayback = null;
            resolve();
          };
          finishPlayback = finish;
          player.onended = () => {
            URL.revokeObjectURL(url);
            if (currentUrl === url) currentUrl = null;
            finish();
          };
          player.onerror = () => {
            finishPlayback = null;
            reject(new Error("Audio playback failed."));
          };
          void player
            .play()
            .then(() => {
              if (request === generation) {
                status(
                  response.headers.get("X-Voice-Provider") === "qwen"
                    ? "qwen"
                    : response.headers.get("X-Voice-Provider") === "kokoro"
                      ? "kokoro"
                      : "gemini",
                  fallbackNotice,
                );
              }
            })
            .catch(reject);
        });
        return;
      }
      try {
        const body = await response.json();
        fallbackNotice =
          typeof body.detail === "string"
            ? body.detail
            : "Character voice is unavailable.";
      } catch {
        fallbackNotice = "Character voice is unavailable.";
      }
    } catch {
      fallbackNotice =
        "Character voice couldn’t connect. Using the browser voice.";
    } finally {
      window.clearTimeout(timer);
      if (pendingRequest === controller) pendingRequest = null;
    }
  }
  if (request !== generation) return;
  if (!window.speechSynthesis) {
    status(
      "unavailable",
      "Audio is unavailable in this browser. Subtitles remain on.",
    );
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith("en"));
  const preferred = voices.find((v) =>
    sid === "priya"
      ? /Samantha|Karen|female|Victoria/i.test(v.name)
      : /Daniel|Alex|David|male/i.test(v.name),
  );
  utterance.voice =
    preferred ??
    voices[sid === "priya" ? Math.min(1, voices.length - 1) : 0] ??
    null;
  utterance.pitch = sid === "sam" ? 1.08 : sid === "marcus" ? 0.8 : 1.02;
  utterance.rate = playbackRate;
  status("browser", fallbackNotice);
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (finishPlayback === finish) finishPlayback = null;
      resolve();
    };
    finishPlayback = finish;
    utterance.onend = finish;
    utterance.onerror = (event) => {
      if (
        request === generation &&
        event.error !== "canceled" &&
        event.error !== "interrupted"
      )
        status(
          "unavailable",
          "Tap Replay voice to allow audio playback, or keep reading the subtitles.",
        );
      finish();
    };
    window.speechSynthesis.speak(utterance);
  });
}

export async function speak(text: string, sid = "sam") {
  stopSpeech();
  if (useGame.getState().muted) return;
  await playLine(text, sid, generation);
}

export async function speakSequence(
  lines: { suspect_id: string; text: string }[],
) {
  stopSpeech();
  const request = generation;
  for (const line of lines) {
    if (request !== generation || useGame.getState().muted) break;
    await playLine(line.text, line.suspect_id, request);
  }
}
