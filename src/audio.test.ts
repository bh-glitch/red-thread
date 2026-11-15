import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speak, speakSequence, stopSpeech } from "./audio";
import { useGame } from "./store";
import type { CaseData } from "./types";

class FakeAudio {
  static players: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  playbackRate = 1;
  preservesPitch = false;
  constructor(public src: string) {
    FakeAudio.players.push(this);
  }
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}
class FakeUtterance {
  voice: unknown = null;
  pitch = 1;
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}
let browserLines: FakeUtterance[];
const audioResponse = () =>
  new Response(new Blob(["test-wav"]), {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  });

beforeEach(() => {
  browserLines = [];
  FakeAudio.players = [];
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    speechSynthesis: {
      cancel: vi.fn(),
      getVoices: () => [],
      speak: (line: FakeUtterance) => {
        browserLines.push(line);
        line.onstart?.();
      },
    },
  });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  useGame.setState({
    muted: false,
    voiceStatus: "idle",
    voiceNotice: "",
    data: {
      mode: "demo",
      audio: {
        provider: "gemini",
        configured: true,
        enabled: true,
        model: "gemini-3.1-flash-tts-preview",
      },
    } as CaseData,
  });
});
afterEach(() => {
  stopSpeech();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gemini voice playback", () => {
  it.each([1, 1.1])(
    "plays local Qwen audio at %sx with pitch preserved",
    async (rate) => {
      const data = useGame.getState().data!;
      useGame.setState({
        data: { ...data, audio: { ...data.audio, provider: "qwen" } },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(new Blob(["qwen-wav"]), {
            headers: {
              "Content-Type": "audio/wav",
              "X-Voice-Provider": "qwen",
              "X-Voice-Playback-Rate": String(rate),
            },
          }),
        ),
      );
      const done = speak("I-I mean… I was home.", "priya");
      await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(1));
      expect(useGame.getState().voiceStatus).toBe("qwen");
      expect(FakeAudio.players[0].playbackRate).toBe(rate);
      expect(FakeAudio.players[0].preservesPitch).toBe(true);
      expect(browserLines).toHaveLength(0);
      FakeAudio.players[0].onended?.();
      await done;
    },
  );
  it("plays the local backup when Gemini reaches quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["local-wav"]), {
          headers: {
            "X-Voice-Provider": "qwen",
            "X-Voice-Fallback": "rate_limited",
            "X-Voice-Playback-Rate": "1.1",
          },
        }),
      ),
    );
    const done = speak("I-I mean… I was home.", "priya");
    await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(1));
    expect(useGame.getState().voiceStatus).toBe("qwen");
    expect(useGame.getState().voiceNotice).toContain("local");
    expect(FakeAudio.players[0].playbackRate).toBe(1.1);
    expect(browserLines).toHaveLength(0);
    FakeAudio.players[0].onended?.();
    await done;
  });
  it("uses Gemini audio even when dialogue remains in demo mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", fetcher);
    const done = speak("Hello, detective.", "sam");
    await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      suspect_id: "sam",
      text: "Hello, detective.",
    });
    expect(useGame.getState().voiceStatus).toBe("gemini");
    FakeAudio.players[0].onended?.();
    await done;
    expect(FakeAudio.players[0].playbackRate).toBe(1);
    expect(FakeAudio.players[0].preservesPitch).toBe(true);
    expect(browserLines).toHaveLength(0);
  });
  it("does not play a delayed reply after hanging up", async () => {
    let deliver!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deliver = resolve;
          }),
      ),
    );
    const done = speak("Delayed reply.", "sam");
    stopSpeech();
    deliver(audioResponse());
    await done;
    expect(FakeAudio.players).toHaveLength(0);
    expect(browserLines).toHaveLength(0);
    expect(useGame.getState().voiceStatus).toBe("idle");
  });
  it("explains quota fallback and keeps the spoken text intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ detail: "Gemini voice quota reached." }),
            { status: 503 },
          ),
        ),
    );
    const done = speak("I-I mean… I was home.", "priya");
    await vi.waitFor(() => expect(browserLines).toHaveLength(1));
    expect(browserLines[0].text).toBe("I-I mean… I was home.");
    expect(useGame.getState().voiceNotice).toContain("quota");
    browserLines[0].onend?.();
    await done;
  });
  it("plays cross-examination in order without cutting off the first speaker", async () => {
    const fetcher = vi.fn().mockImplementation(async () => audioResponse());
    vi.stubGlobal("fetch", fetcher);
    const done = speakSequence([
      { suspect_id: "priya", text: "I was home." },
      { suspect_id: "marcus", text: "I saw you." },
    ]);
    await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    FakeAudio.players[0].onended?.();
    await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(2));
    expect(JSON.parse(fetcher.mock.calls[1][1].body).suspect_id).toBe("marcus");
    FakeAudio.players[1].onended?.();
    await done;
  });
  it("cancels the rest of a cross-examination when the player leaves", async () => {
    const fetcher = vi.fn().mockImplementation(async () => audioResponse());
    vi.stubGlobal("fetch", fetcher);
    const done = speakSequence([
      { suspect_id: "priya", text: "First." },
      { suspect_id: "marcus", text: "Second." },
    ]);
    await vi.waitFor(() => expect(FakeAudio.players).toHaveLength(1));
    stopSpeech();
    await done;
    expect(FakeAudio.players[0].paused).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("makes no provider request when sound is muted", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    useGame.setState({ muted: true });
    await speak("Muted.", "sam");
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLines).toHaveLength(0);
  });
});
