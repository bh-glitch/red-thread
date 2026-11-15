import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  CircleHelp,
  CloudRain,
  Clock3,
  FileText,
  Fingerprint,
  FolderClosed,
  Hand,
  Headphones,
  Lightbulb,
  LockKeyhole,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, stream } from "./api";
import { useGame } from "./store";
import { sound, speak, speakSequence, stopSpeech } from "./audio";
import { startMusic } from "./music";
import type { CaseData, Evidence, Message, Reveal, Suspect } from "./types";
import BoardStrings from "./BoardStrings";
import OpeningLetter from "./OpeningLetter";
import HandControl from "./hands/HandControl";
import { useBoardCamera } from "./hands/useBoardCamera";
import HandGuide from "./hands/HandGuide";
import RainRoom from "./RainRoom";

const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: {
        results: { isFinal: boolean; 0: { transcript: string } }[];
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

let openModals = 0;
function Modal({
  children,
  className = "",
  onClose,
  label,
  dismissOnBackdrop = true,
  focusDialog = false,
}: {
  children: ReactNode;
  className?: string;
  onClose: () => void;
  label: string;
  dismissOnBackdrop?: boolean;
  focusDialog?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'button, input, select, [tabindex="0"]',
    );
    if (focusDialog) ref.current?.focus();
    else first?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, [tabindex="0"]',
          ) ?? [],
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    // The page behind a call or popup must not scroll.
    openModals += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", key);
      openModals -= 1;
      if (!openModals) document.documentElement.classList.remove("modal-open");
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`modal ${className}`}
        initial={{ opacity: 0, y: 25, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function Pin({ color = "red" }: { color?: string }) {
  return <span className={`pin ${color}`} aria-hidden="true" />;
}
function Typewriter({ text, fast = false }: { text: string; fast?: boolean }) {
  const [length, setLength] = useState(0);
  useEffect(() => {
    setLength(0);
    const timer = window.setInterval(
      () => setLength((n) => Math.min(n + (fast ? 5 : 2), text.length)),
      fast ? 12 : 22,
    );
    return () => window.clearInterval(timer);
  }, [text, fast]);
  return (
    <span
      onClick={() => setLength(text.length)}
      title="Click to show the full briefing"
    >
      {text.slice(0, length)}
      {length < text.length && <span className="type-cursor">▏</span>}
    </span>
  );
}

export default function App() {
  const {
    data,
    started,
    briefingAccepted,
    acceptBriefing,
    setData,
    start,
    sync,
    setSidebar,
    muted,
    voiceStatus,
    voiceNotice,
    toggleSound,
    tags,
    tag,
    clear,
  } = useGame();
  const [loadError, setLoadError] = useState("");
  const [active, setActive] = useState<Suspect | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState("");
  const [hint, setHint] = useState<{ text: string; level: number } | null>(
    null,
  );
  const [document, setDocument] = useState<Evidence | null>(null);
  const [guessing, setGuessing] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{
    correct: boolean;
    stamp: string;
    suspect_id: string;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [ending, setEnding] = useState(false);
  const [nextMission, setNextMission] = useState(false);
  const [crossing, setCrossing] = useState(false);
  const [pair, setPair] = useState(["priya", "marcus"]);
  const [crossStatements, setCrossStatements] = useState<
    { suspect_id: string; text: string }[]
  >([]);
  const [contradiction, setContradiction] = useState(false);
  const [crossDone, setCrossDone] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(false);
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);
  const [showBrief, setShowBrief] = useState(false);
  const [switchingCase, setSwitchingCase] = useState(false);
  const [caseDirection, setCaseDirection] = useState<1 | -1>(1);
  const [handsOn, setHandsOn] = useState(false);
  const [showHandGuide, setShowHandGuide] = useState(false);
  const [hideHandGuide, setHideHandGuide] = useState(() => {
    try {
      return localStorage.getItem("hand-guide-hidden") === "1";
    } catch {
      return false;
    }
  });
  function rememberHideHandGuide(hide: boolean) {
    setHideHandGuide(hide);
    try {
      localStorage.setItem("hand-guide-hidden", hide ? "1" : "0");
    } catch {
      // Private windows may block storage; the guide just shows again.
    }
  }
  function toggleHands() {
    // Turning hand control on shows the guide first (unless dismissed for good).
    if (!handsOn && !hideHandGuide) setShowHandGuide(true);
    setHandsOn((on) => !on);
  }
  // Board input (zoom/pan keys, hand gestures) only while nothing covers it.
  const boardCovered =
    !!active ||
    connecting ||
    guessing ||
    !!document ||
    crossing ||
    showHelp ||
    showHandGuide ||
    showBrief ||
    showReset ||
    !!reveal ||
    !!verdict;
  const boardCamera = useBoardCamera(boardEl, started && !boardCovered);

  const speech = useRef<Recognition | null>(null);
  const transcript = useRef("");
  const listeningTarget = useRef<string | null>(null);
  const submitRef = useRef<(message: string) => void>(() => {});
  const streamController = useRef<AbortController | null>(null);
  const latest = useRef({ busy, active, started, blocked: false });
  latest.current = {
    busy,
    active,
    started,
    blocked:
      guessing ||
      !!document ||
      crossing ||
      showHelp ||
      showHandGuide ||
      showBrief ||
      showReset ||
      !!reveal ||
      !!verdict,
  };

  async function load() {
    try {
      setLoadError("");
      // Reloading the page starts the case over; a normal visit resumes it.
      const navigation = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const fresh =
        navigation?.type === "reload"
          ? await api<CaseData>("/reset", {})
          : await api<CaseData>("/case/load");
      setData(fresh);
      if (fresh.state.visited.length) start();
      if (fresh.state.guessed) {
        start();
        setReveal(await api<Reveal>("/reveal"));
      }
    } catch {
      setLoadError("The case server is offline. Run make dev, then reconnect.");
    }
  }
  useEffect(() => {
    void load();
    return () => {
      stopSpeech();
      streamController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 12000);
    return () => clearTimeout(timer);
  }, [hint]);
  useEffect(() => {
    const Speech =
      (window as SpeechWindow).SpeechRecognition ??
      (window as SpeechWindow).webkitSpeechRecognition;
    setSupported(!!Speech);
    if (!Speech) return;
    const recognition = new Speech();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let finalText = "",
        liveText = "";
      for (let i = 0; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text + " ";
        else liveText += text;
      }
      transcript.current = (finalText + liveText).trim();
      setInterim(transcript.current);
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error !== "aborted" && event.error !== "no-speech")
        setToast(
          event.error === "not-allowed"
            ? "Microphone access is blocked. Allow it in Chrome, or type your question below."
            : "Couldn’t hear that. You can always type your question.",
        );
      transcript.current = "";
    };
    recognition.onend = () => {
      setListening(false);
      const text = transcript.current;
      transcript.current = "";
      setInterim("");
      // A recording belongs to the screen where it began. Never send a late
      // interview transcript to the board's command router after leaving a call.
      if (
        text &&
        listeningTarget.current === (latest.current.active?.id ?? null)
      )
        submitRef.current(text);
    };
    speech.current = recognition;
    let spaceHeld = false;
    function down(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.code === "Space" &&
        !event.repeat &&
        !/INPUT|TEXTAREA|SELECT/.test(target.tagName) &&
        !target.isContentEditable &&
        !latest.current.blocked &&
        latest.current.started &&
        !latest.current.busy
      ) {
        event.preventDefault();
        event.stopPropagation();
        spaceHeld = true;
        beginListening();
      }
    }
    function up(event: KeyboardEvent) {
      if (event.code === "Space" && spaceHeld) {
        // Suppress native button activation on release (the Back button used
        // to receive focus when a call opened).
        event.preventDefault();
        event.stopPropagation();
        spaceHeld = false;
        speech.current?.stop();
      }
    }
    function blur() {
      spaceHeld = false;
      speech.current?.stop();
    }
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      recognition.onend = null;
      recognition.abort();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  function beginListening() {
    if (!speech.current || busy) return;
    stopSpeech();
    listeningTarget.current = latest.current.active?.id ?? null;
    transcript.current = "";
    setInterim("");
    try {
      speech.current.start();
      setListening(true);
    } catch {
      /* Already capturing. */
    }
  }
  function endListening() {
    speech.current?.stop();
  }
  function notify(error: unknown) {
    setToast(
      error instanceof Error
        ? error.message
        : "Something interrupted the investigation. Try again.",
    );
  }

  async function call(person: Suspect) {
    if (connecting || busy) return;
    stopSpeech();
    setConnecting(true);
    try {
      const response = await api(`/call/${person.id}/start`, { voice: !muted });
      sync(response.state);
      setActive(person);
      setMessages([{ role: "suspect", text: response.opening }]);
      setPartial("");

      setInput("");
      sound("phone");
      void speak(response.opening, person.id);
    } catch (error) {
      notify(error);
    } finally {
      setConnecting(false);
    }
  }
  async function hangup() {
    transcript.current = "";
    speech.current?.abort();
    setListening(false);
    streamController.current?.abort();
    stopSpeech();
    setActive(null);
    setBusy(false);
    setPartial("");
    setInput("");
    sound("paper");
    try {
      const response = await api("/hangup", {});
      sync(response.state);
      setToast("Interview saved to your case notes.");
    } catch (error) {
      notify(error);
    }
  }
  async function ask(message: string, evidenceId?: string) {
    const person = active;
    if (!person || busy) return;
    stopSpeech();
    setBusy(true);
    setPartial("");
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    const controller = new AbortController();
    streamController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      await stream(
        `/call/${person.id}/say`,
        { message, evidence_id: evidenceId, voice: !muted },
        (kind, payload) => {
          if (kind === "token") setPartial((p) => p + payload.text);
          if (kind === "evidence_unlocked") {
            sound("pin");
            setToast("New evidence pinned to your board.");
          }
          if (kind === "done") {
            if (payload.dialogue?.source === "fallback")
              setToast(
                "The conversation model couldn’t answer this turn. Using the case fallback.",
              );
            sync(payload.state, payload.links, payload.evidence_catalog);
            setMessages((m) => [...m, { role: "suspect", text: payload.text }]);
            setPartial("");
            void speak(payload.text, person.id);
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) notify(error);
      else if (latest.current.active)
        setToast("The call timed out. Try your question again.");
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  async function getHint() {
    try {
      setHint(await api("/hint", {}));
    } catch (error) {
      notify(error);
    }
  }
  async function openEvidence(id: string) {
    try {
      setDocument(await api<Evidence>(`/evidence/${id}`));
      sound("paper");
    } catch (error) {
      notify(error);
    }
  }
  function openCross(
    selected = data?.cross_pair ?? data?.suspects.slice(0, 2).map((p) => p.id) ?? [],
  ) {
    if ((data?.state.visited.length ?? 0) < 2) {
      setToast("Interview two people to unlock cross-examination.");
      return;
    }
    stopSpeech();
    setPair(selected);
    setCrossStatements([]);
    setContradiction(false);
    setCrossDone(false);
    setCrossing(true);
  }
  async function runCross() {
    if (busy || crossDone) return;
    setBusy(true);
    const spoken: { suspect_id: string; text: string }[] = [];
    try {
      await stream(
        "/cross",
        {
          suspects: pair,
          question: "Where were you around midnight?",
          voice: !muted,
        },
        (kind, payload) => {
          if (kind === "statement") {
            if (payload.dialogue?.source === "fallback")
              setToast(
                "The conversation model couldn’t answer this turn. Using the case fallback.",
              );
            spoken.push(payload);
            setCrossStatements((p) => [...p, payload]);
          }
          if (kind === "contradiction") {
            setContradiction(true);
            sound("pin");
          }
          if (kind === "done") {
            sync(payload.state);
            setCrossDone(true);
          }
        },
        AbortSignal.timeout(75000),
      );
      void speakSequence(spoken);
    } catch (error) {
      notify(error);
    } finally {
      setBusy(false);
    }
  }
  function openGuess(id?: string) {
    stopSpeech();
    setSelection(id ?? null);
    setGuessing(true);
  }
  async function confirmGuess() {
    if (!selection || reviewing) return;
    setReviewing(true);
    try {
      const [result] = await Promise.all([
        api("/guess", { suspect_id: selection }),
        delay(1500),
      ]);
      setVerdict(result);
      setGuessing(false);
      setActive(null);
      sound("stamp");
    } catch (error) {
      notify(error);
    } finally {
      setReviewing(false);
    }
  }
  async function showReveal() {
    try {
      setReveal(await api<Reveal>("/reveal"));
      setVerdict(null);
      sound("paper");
    } catch (error) {
      notify(error);
    }
  }
  async function switchCase(caseId: string, direction: 1 | -1) {
    setSwitchingCase(true);
    setCaseDirection(direction);
    stopSpeech();
    try {
      const fresh = await api<CaseData>("/case/select", { case_id: caseId });
      sound("paper");
      setData(fresh);
    } catch (error) {
      notify(error);
    } finally {
      setSwitchingCase(false);
    }
  }
  async function reset() {
    stopSpeech();
    streamController.current?.abort();
    try {
      const fresh = await api<CaseData>("/reset", {});
      clear();
      setData(fresh);
      setActive(null);
      setMessages([]);
      setVerdict(null);
      setReveal(null);
      setEnding(false);
      setNextMission(false);
      setGuessing(false);
      setShowReset(false);
      setCrossing(false);
      setDocument(null);
      setHint(null);
      setBusy(false);
      setInput("");
    } catch (error) {
      notify(error);
    }
  }
  async function submit(message: string) {
    if (!message.trim() || busy || connecting) return;
    if (active) {
      if (
        /^(?:please\s+)?(?:hang\s*up|end\s+(?:the\s+)?call|back\s+to\s+(?:the\s+)?board)(?:\s+please)?[.!?]*$/i.test(
          message.trim(),
        )
      )
        await hangup();
      else await ask(message);
      return;
    }
    setInput("");
    try {
      const command = await api("/command", { message });
      switch (command.intent) {
        case "call": {
          const p = data?.suspects.find((p) => p.id === command.suspect_id);
          if (p) await call(p);
          break;
        }
        case "hangup":
          await hangup();
          break;
        case "hint":
          await getHint();
          break;
        case "cross":
          openCross(command.suspects);
          break;
        case "evidence":
          await openEvidence(command.evidence_id);
          break;
        case "guess":
          openGuess(command.suspect_id);
          break;
        case "say":
          await ask(message);
          break;
        case "notes":
          setSidebar("notes");
          break;
        default:
          setToast(command.message);
      }
    } catch (error) {
      notify(error);
    }
  }
  submitRef.current = submit;
  function formSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(input);
  }

  if (!data)
    return (
      <div className="loading-screen">
        <Fingerprint size={44} />
        <span className="eyebrow">RED THREAD</span>
        <p>{loadError || "Retrieving case 001…"}</p>
        {loadError && (
          <button className="primary" onClick={load}>
            Reconnect <RotateCcw size={15} />
          </button>
        )}
      </div>
    );
  if (!briefingAccepted && !started)
    return (
      <OpeningLetter
        data={data}
        onSwitchCase={switchCase}
        switching={switchingCase}
        direction={caseDirection}
        onConfirm={() => {
          acceptBriefing();
          sound("paper");
        }}
      />
    );
  const unlocked = data.state.evidence;
  const rainyCase = data.id === "case_02";
  const overlay =
    !!active ||
    guessing ||
    !!document ||
    crossing ||
    !!verdict ||
    !!reveal ||
    showHelp ||
    showReset;
  const lastMessage =
    partial ||
    [...messages].reverse().find((m) => m.role === "suspect")?.text ||
    "";

  return (
    <>
      <div className={`app-shell${rainyCase ? " storm-case" : ""}`} inert={overlay || undefined}>
        <header className="topbar">
          <a
            href="#"
            className="brand"
            onClick={(event) => {
              event.preventDefault();
              setShowReset(true);
            }}
            aria-label="Red Thread home"
          >
            <div className="brand-symbol">
              <Fingerprint size={31} strokeWidth={1.3} />
            </div>
            <span className="brand-name">
              <span className="brand-red">Red</span> Thread
              <svg className="brand-thread" viewBox="0 0 120 10" aria-hidden="true">
                <path d="M2 6 C 20 1, 34 9, 52 5 S 86 1, 100 6 S 114 8, 118 4" />
              </svg>
            </span>
          </a>
          <div className="top-case">
            <span className="case-id">CASE NO. {data.number}</span>
            <span className="top-separator" />
            <span>{data.title}</span>
          </div>
          <div className="top-actions">
            <span className="status">
              <i />
              {started ? "INVESTIGATION ACTIVE" : "NEW CASE ASSIGNED"}
            </span>
            <button
              className="icon-button sound-control"
              aria-label={muted ? "Enable sound" : "Mute sound"}
              onClick={() => {
                toggleSound();
                if (!muted) stopSpeech();
              }}
            >
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <button
              className="icon-button"
              aria-label="How to play"
              onClick={() => setShowHelp(true)}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        {!started ? (
          <main className="start-screen">
            <div className="room-glow" />
            <div className="start-grain" />
            <div className="start-copy">
              <span className="eyebrow">
                <span className="tiny-line" /> A FINANCIAL MYSTERY
              </span>
              <h1>
                Every number
                <br />
                tells a story.
                <br />
                <em>Someone is lying.</em>
              </h1>
              <p>
                Follow the money. Question everyone.
                <br />
                Find the truth hiding between the lines.
              </p>
              <div className="start-features">
                <span>
                  <Mic size={14} /> VOICE-DRIVEN
                </span>
                <span>
                  <Clock3 size={14} /> 3 MINUTE CASE
                </span>
              </div>
            </div>
            <motion.div
              className="case-folder"
              initial={{ opacity: 0, rotate: -5, y: 25 }}
              animate={{ opacity: 1, rotate: -2, y: 0 }}
              transition={{ duration: 0.7 }}
            >
              <div className="folder-tab">CASE FILE / {data.number}</div>
              <div className="folder-paper">
                <div className="paper-heading">
                  <span>FINANCIAL CRIMES DIVISION</span>
                  <Fingerprint size={30} strokeWidth={1} />
                </div>
                <div className="classified-stamp">CONFIDENTIAL</div>
                <span className="eyebrow">{data.location}</span>
                <h2>
                  {data.title}
                  <span>.</span>
                </h2>
                <div className="folder-rule" />
                <p className="briefing-text">
                  <Typewriter text={data.briefing} fast />
                </p>
                <div className="missing-amount">
                  <span>UNACCOUNTED FOR</span>
                  <strong>{money(data.amount)}</strong>
                </div>
                <button
                  className="primary folder-open"
                  onClick={() => {
                    start();
                    sound("paper");
                    startMusic(); // background music begins with the case file
                  }}
                >
                  Open case file <ArrowRight size={18} />
                </button>
                <div className="folder-foot">
                  <span>{data.suspects.length} SUSPECTS</span>
                  <span>{data.evidence_catalog.length} CLUES</span>
                  <span>1 TRUTH</span>
                </div>
              </div>
              <div className="paperclip" aria-hidden="true" />
            </motion.div>
            <div className="start-bottom">
              <span>
                <Headphones size={16} /> Best experienced with headphones
              </span>
              <span className="start-edition">
                THE FIRST INVESTIGATION <span>01 / 01</span>
              </span>
            </div>
          </main>
        ) : (
          <div className="workspace">
            <main className="investigation">
              {rainyCase && <RainRoom paused={boardCovered} />}
              <div className="board-toolbar">
                <div>
                  <div className="board-eyebrow">
                    <span className="eyebrow">CASE {data.number}</span>
                    <span className="live-dot" />{" "}
                    <span className="case-date">{data.date}</span>
                  </div>
                  <h1>{data.title}</h1>
                  <p>Someone is lying.</p>
                </div>
                <div className="board-actions">
                  <button
                    className="hint-button brief-button"
                    onClick={() => setShowBrief(true)}
                  >
                    <FolderClosed size={17} />
                    <span>Case brief</span>
                  </button>
                  <button className="hint-button" onClick={getHint}>
                    <Lightbulb size={17} />
                    <span>Need a hint?</span>
                  </button>
                  <button className="guess-button" onClick={() => openGuess()}>
                    <Fingerprint size={17} /> GUESS NOW <ArrowRight size={16} />
                  </button>
                </div>
              </div>
              {rainyCase && (
                <div className="storm-atmosphere">
                  <div className="storm-location">
                    <CloudRain size={23} strokeWidth={1.2} aria-hidden="true" />
                    <span>POCONO MOUNTAINS, PA<small>November 14 · A house in the woods</small></span>
                  </div>
                  <p>The storm outside.<br /><em>The silence inside.</em></p>
                  <div className="storm-blackout"><span>11:47 — 11:54 PM</span><small>SEVEN MINUTES IN THE DARK</small></div>
                </div>
              )}
              <div
                className="board-outer"
              >
                <div className="board-frame">
                  {rainyCase && <span className="storm-board-label">THE CASE SO FAR <span>PERSONS & EVIDENCE</span></span>}
                  <div
                    className={`cork-board ${handsOn ? "hands-on" : ""}`}
                    ref={setBoardEl}
                  >
                    <div className="lamp-beam" aria-hidden="true" />
                    <div className="board-grain" />
                    <div className="board-tape top-tape" />
                    <motion.div
                      className="board-camera"
                      ref={boardRef}
                      style={{
                        x: boardCamera.x,
                        y: boardCamera.y,
                        scale: boardCamera.scale,
                        transformOrigin: "0 0",
                      }}
                    >
                    <div className="board-caption">
                      <span>{data.board?.caption ?? data.victim_business.name.toUpperCase()}</span>
                      <span>PERSONS OF INTEREST</span>
                    </div>
                    <BoardStrings board={boardRef} links={data.links} />
                    <div
                      className="suspect-row"
                      style={{
                        gridTemplateColumns: `repeat(${data.suspects.length + (data.missing_person ? 1 : 0)}, minmax(0, 1fr))`,
                      }}
                    >
                      {data.missing_person && (
                        <motion.article
                          className="suspect-card missing-card"
                          initial={{ opacity: 0, y: 30, rotate: 4 }}
                          animate={{ opacity: 1, y: 0, rotate: 4 }}
                          transition={{ delay: 0.1 }}
                        >
                          <Pin color="red" />
                          <div className="polaroid">
                            <div className="portrait-button missing-photo">
                              <img
                                src={data.missing_person.portrait}
                                alt={data.missing_person.name}
                                draggable={false}
                              />
                              <span className="missing-stamp">MISSING</span>
                            </div>
                            <div className="polaroid-caption">
                              <h2>{data.missing_person.name}</h2>
                              <p>{data.missing_person.role}</p>
                            </div>
                          </div>
                          <span className="missing-note">{data.missing_person.note}</span>
                        </motion.article>
                      )}
                      {data.suspects.map((person, i) => (
                        <motion.article
                          className={`suspect-card suspect-${person.id}`}
                          data-suspect-id={person.id}
                          key={person.id}
                          initial={{
                            opacity: 0,
                            y: 30,
                            rotate: [-6, 3, -3, 5, -4][i % 5],
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                            rotate: [-6, 3, -3, 5, -4][i % 5],
                          }}
                          transition={{ delay: 0.15 + i * 0.12 }}
                          whileHover={{
                            y: -8,
                            rotate: 0,
                            transition: { duration: 0.2 },
                          }}
                          onClick={(event) => {
                            // The whole card calls; its own buttons (photo,
                            // Suspect/Cleared tags) handle their clicks.
                            if ((event.target as HTMLElement).closest("button"))
                              return;
                            if (!connecting) call(person);
                          }}
                        >
                          <Pin color={i === 1 ? "olive" : "red"} />
                          <div className="polaroid">
                            <button
                              className="portrait-button"
                              onClick={() => call(person)}
                              disabled={connecting}
                              aria-label={`Call ${person.name}`}
                            >
                              <img
                                src={person.portrait}
                                alt={person.name}
                                draggable={false}
                              />
                              <span className="photo-shade" />
                              <span className="photo-index">
                                0{i + 1} / PERSON OF INTEREST
                              </span>
                              {data.state.visited.includes(person.id) && (
                                <span className="questioned-badge">
                                  <CheckCheck size={13} /> QUESTIONED
                                </span>
                              )}
                              <span className="call-hover">
                                <Phone size={21} />
                                <span>Call {person.name.split(" ")[0]}</span>
                              </span>
                            </button>
                            <div className="polaroid-caption">
                              <h2>{person.name}</h2>
                              <p>{person.role}</p>
                            </div>
                          </div>
                          <div className="card-tools">
                            <button
                              className={
                                tags[person.id] === "suspect"
                                  ? "marked-suspect"
                                  : ""
                              }
                              onClick={() => tag(person.id, "suspect")}
                              aria-label={`Mark ${person.name} as suspect`}
                            >
                              {tags[person.id] === "suspect" ? (
                                <Check size={11} />
                              ) : (
                                <Plus size={11} />
                              )}{" "}
                              Suspect
                            </button>
                            <span />
                            <button
                              className={
                                tags[person.id] === "cleared"
                                  ? "marked-clear"
                                  : ""
                              }
                              onClick={() => tag(person.id, "cleared")}
                              aria-label={`Mark ${person.name} as cleared`}
                            >
                              {tags[person.id] === "cleared" ? (
                                <Check size={11} />
                              ) : (
                                <ShieldCheck size={11} />
                              )}{" "}
                              Cleared
                            </button>
                          </div>
                        </motion.article>
                      ))}
                    </div>
                    <div className="board-bottom-items">
                      <div className="pinned-brief">
                        <Pin color="red" />
                        <span className="brief-stamp">{data.board?.note.stamp ?? "MISSING"}</span>
                        <p>{data.board?.note.amount ?? money(data.amount)}</p>
                        <span className="case-scribble">{data.board?.note.caption}</span>
                        {/* Red thread wrapped round the note: the money is the heart of the case. */}
                        <svg
                          className="brief-thread"
                          viewBox="0 0 240 160"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <path className="behind" d="M-8 14 C -14 4, -10 -2, -2 -4" />
                          <path className="behind" d="M250 150 C 256 158, 252 164, 244 166" />
                          <path d="M-8 16 C 60 6, 150 22, 252 10" />
                          <path d="M-10 146 C 80 156, 170 140, 250 150" />
                          <path d="M204 -10 C 196 50, 212 110, 202 170" />
                          <path d="M214 -8 C 222 40, 206 120, 216 168" />
                          <path className="loose" d="M204 14 C 186 30, 178 46, 170 70" />
                          <circle cx="207" cy="13" r="5" />
                        </svg>
                      </div>
                      {data.evidence_catalog.map((entry, index) => {
                        const card = entry.card;
                        if (!card) return <div key={entry.id} />;
                        if (card.kind === "sticky")
                          return (
                            <motion.button
                              key={entry.id}
                              className="witness-sticky"
                              data-evidence-id={entry.id}
                              initial={{ scale: 0.6, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              onClick={() => openEvidence(entry.id)}
                            >
                              <span className="sticky-tape" />
                              <span className="eyebrow">{card.heading}</span>
                              <p>{card.quote}</p>
                              <span>{card.by}</span>
                            </motion.button>
                          );
                        return (
                          <motion.button
                            key={entry.id}
                            className="pinned-document"
                            data-evidence-id={entry.id}
                            initial={{ y: -50, opacity: 0, rotate: index % 2 ? 6 : -12 }}
                            animate={{ y: 0, opacity: 1, rotate: index % 2 ? 3 : -5 }}
                            onClick={() => openEvidence(entry.id)}
                          >
                            <Pin />
                            <span className="doc-topline">
                              {card.topline} <FileText size={14} />
                            </span>
                            <strong>{card.title}</strong>
                            <div className="mini-table">
                              <span>{card.subheading}</span>
                              {card.rows.map((row, r) => (
                                <div key={r}>
                                  <span>{row[0]}</span>
                                  <b>{row[1]}</b>
                                  <span>{row[2]}</span>
                                </div>
                              ))}
                            </div>
                            <span className="document-total">
                              {card.total_label ?? "TOTAL"} <b>{card.total}</b>
                            </span>
                            <span className="document-cta">
                              EXAMINE EVIDENCE <ArrowRight size={12} />
                            </span>
                          </motion.button>
                        );
                      })}
                    </div>
                    </motion.div>
                    <HandControl
                      on={handsOn}
                      paused={boardCovered}
                      viewport={boardEl}
                      camera={boardCamera}
                      onError={(message) => {
                        setHandsOn(false);
                        setToast(message);
                      }}
                    />
                    <span className="board-screw screw-one" />
                    <span className="board-screw screw-two" />
                    <span className="board-screw screw-three" />
                    <span className="board-screw screw-four" />
                  </div>
                </div>
                <div className="board-underbar">
                  <span className="clue-slots" aria-label={`${unlocked.length} of ${data.evidence_catalog.length} key clues found`}>
                    <span className="clue-slots-title">
                      KEY CLUES {unlocked.length}/{data.evidence_catalog.length}
                    </span>
                    {data.evidence_catalog.map(({ id, type }) =>
                      unlocked.includes(id) ? (
                        <button
                          key={id}
                          className="clue-slot found"
                          onClick={() => openEvidence(id)}
                        >
                          <Check size={12} />
                          {type}
                        </button>
                      ) : (
                        <span key={id} className="clue-slot" title="Not found yet — keep questioning">
                          ? Undiscovered
                        </span>
                      ),
                    )}
                  </span>
                  <span className="hand-controls">
                    <button
                      className={handsOn ? "hand-toggle is-on" : "hand-toggle"}
                      onClick={toggleHands}
                      aria-pressed={handsOn}
                    >
                      <Hand size={16} />
                      {handsOn ? "Hand control: on" : "Hand control: off"}
                    </button>
                    <button
                      className="hand-guide-button"
                      onClick={() => setShowHandGuide(true)}
                    >
                      <CircleHelp size={15} /> Hand guide
                    </button>
                  </span>
                  <button
                    className="cross-button underbar-cross"
                    disabled={data.state.visited.length < 2}
                    onClick={() => openCross()}
                  >
                    <Users size={17} />
                    <span>Cross-examine</span>
                    {data.state.visited.length < 2 ? (
                      <LockKeyhole size={13} />
                    ) : (
                      <ArrowRight size={14} />
                    )}
                  </button>
                </div>
              </div>
              <div className="board-footer">
                <div className="board-tip">
                  <span className="tip-icon">
                    <Phone size={16} />
                  </span>
                  <p>
                    <strong>A conversation can change everything.</strong>
                    <span>Click a photograph to make your first call.</span>
                  </p>
                </div>
              </div>
            </main>
          </div>
        )}
        {started && (
          <footer className="command-dock">
            <div className={`mic-orb ${listening ? "recording" : ""}`}>
              <button
                aria-label={
                  supported ? "Hold to speak" : "Voice input requires Chrome"
                }
                data-hand-hold
                disabled={!supported || busy}
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Hand control presses have no real pointer to capture.
                  }
                  beginListening();
                }}
                onPointerUp={endListening}
                onPointerCancel={endListening}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.repeat) beginListening();
                }}
                onKeyUp={(event) => {
                  if (event.key === "Enter") endListening();
                }}
              >
                {supported ? <Mic size={20} /> : <MicOff size={20} />}
              </button>
            </div>
            <form onSubmit={formSubmit}>
              <label className="sr-only" htmlFor="board-command">
                Type a command
              </label>
              <input
                id="board-command"
                value={listening ? interim : input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={
                  listening
                    ? "Listening… release to send"
                    : "Type a command, or hold Space to speak…"
                }
                autoComplete="off"
                disabled={busy || listening}
              />
              <span className="command-suggestion">
                Try{" "}
                <button type="button" onClick={() => call(data.suspects[0])}>
                  “call Sam”
                </button>
              </span>
              <button
                className="send-command"
                type="submit"
                aria-label="Send command"
                disabled={!input.trim() || busy}
              >
                <ArrowRight size={18} />
              </button>
            </form>
            <div className="ptt-label">
              <span
                className={`connection-dot ${listening ? "recording-dot" : ""}`}
              />
              <span>
                {listening
                  ? "LISTENING"
                  : supported
                    ? "PUSH TO TALK"
                    : "TYPE TO INVESTIGATE"}
              </span>
              {supported && <kbd>SPACE</kbd>}
            </div>
          </footer>
        )}
      </div>

      <AnimatePresence>
        {hint && (
          <motion.aside
            key="hint"
            className="hint-popover"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <Lightbulb size={22} />
            <div>
              <span className="eyebrow">
                A NUDGE IN THE RIGHT DIRECTION · {hint.level}/3
              </span>
              <p>{hint.text}</p>
            </div>
            <button
              className="icon-button"
              onClick={() => setHint(null)}
              aria-label="Dismiss hint"
            >
              <X size={16} />
            </button>
          </motion.aside>
        )}
        {toast && (
          <motion.div
            key="toast"
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <span className="toast-dot" />
            {toast}
            <button
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
        {active && !guessing && !crossing && !document && (
          <Modal
            key="call"
            className="call-modal interview-modal"
            onClose={hangup}
            label={`Interview ${active.name}`}
            dismissOnBackdrop={false}
            focusDialog
          >
            <div className="interview-heading">
              <button
                className="icon-button"
                onClick={hangup}
                aria-label="Back to board"
              >
                <ArrowLeft size={19} />
              </button>
              <div>
                <h2>{active.name}</h2>
                <span>{active.role}</span>
              </div>
              <button
                className="text-button interview-accuse"
                onClick={() => openGuess(active.id)}
              >
                Accuse <Fingerprint size={16} />
              </button>
              <button
                className="end-interview"
                onClick={hangup}
                aria-label="End call"
              >
                <PhoneOff size={19} />
              </button>
            </div>
            <div className="interview-scene">
              <div
                className="interview-portrait"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData("evidence");
                  if (unlocked.includes(id))
                    void ask("Explain this evidence.", id);
                }}
              >
                <img
                  className="interview-photo"
                  src={active.portrait}
                  alt={active.name}
                />
              </div>
              <div className="interview-words">
                <p className="interview-subtitle" aria-live="polite">
                  “{lastMessage}
                  {partial && <span className="type-cursor">▏</span>}”
                </p>
                <div className="interview-wait" role="status">
                  {busy
                    ? "Thinking…"
                    : voiceStatus === "generating"
                      ? "Connecting voice…"
                      : ""}
                </div>
                <div className="interview-questions">
                  {active.questions.map((question) => (
                    <button
                      key={question}
                      disabled={busy}
                      onClick={() => ask(question)}
                    >
                      {question}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                  {unlocked.map((id) => (
                    <button
                      className="present-question"
                      key={id}
                      disabled={busy}
                      onClick={() => ask("Explain this evidence.", id)}
                    >
                      <FileText size={13} />
                      {id === "transaction_sheet"
                        ? "Present transaction sheet"
                        : "Present witness statement"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <form className="interview-input" onSubmit={formSubmit}>
              <button
                type="button"
                className={`call-mic ${listening ? "recording" : ""}`}
                aria-label="Hold to speak"
                data-hand-hold
                disabled={!supported || busy}
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Hand control presses have no real pointer to capture.
                  }
                  beginListening();
                }}
                onPointerUp={endListening}
                onPointerCancel={endListening}
              >
                <Mic size={19} />
              </button>
              <label className="sr-only" htmlFor="interview-input">
                Ask a question
              </label>
              <input
                id="interview-input"
                value={listening ? interim : input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={listening ? "Listening…" : "Ask a question…"}
                disabled={busy || listening}
                autoComplete="off"
              />
              <button
                className="icon-button"
                type="button"
                disabled={busy || muted}
                onClick={() => void speak(lastMessage, active.id)}
                aria-label="Replay voice"
                title={voiceNotice || "Replay voice"}
              >
                <Volume2 size={17} />
              </button>
              <button
                className="icon-button"
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send question"
              >
                <Send size={18} />
              </button>
            </form>
          </Modal>
        )}

        {document && (
          <Modal
            key="evidence"
            className="evidence-modal paper-modal"
            label={document.title}
            onClose={() => setDocument(null)}
          >
            <button
              className="modal-close"
              aria-label="Close document"
              onClick={() => setDocument(null)}
            >
              <X size={21} />
            </button>
            <div className="document-header">
              <Fingerprint size={29} />
              <span>
                FINANCIAL CRIMES DIVISION
                <br />
                EVIDENCE NO.{" "}
                {document.number ?? "001"}
              </span>
              <span className="document-stamp">ON FILE</span>
            </div>
            <span className="eyebrow">{document.type}</span>
            <h2>{document.title}</h2>
            <p className="document-summary">{document.summary}</p>
            {document.transactions ? (
              <>
                <div className="document-bank">
                  <strong>{document.business}</strong>
                  <span>{document.period}</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Vendor</th>
                        <th>Time</th>
                        <th className="align-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {document.transactions.map((row) => (
                        <tr key={row.id}>
                          <td>{row.date.slice(5).replace("-", "/")}</td>
                          <td>
                            {row.merchant}
                            <small>{row.id}</small>
                          </td>
                          <td>
                            {row.flagged ||
                            !document.transactions!.some((t) => t.flagged) ? (
                              <mark>{row.display_time}</mark>
                            ) : (
                              row.display_time
                            )}
                          </td>
                          <td className="align-right">{money(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>
                          {document.transactions.some((t) => t.flagged)
                            ? "FLAGGED TRANSFER"
                            : "TOTAL TRANSFERRED"}
                        </td>
                        <td className="align-right">
                          {money(
                            document.transactions
                              .filter(
                                (t, _i, rows) =>
                                  t.flagged || !rows.some((r) => r.flagged),
                              )
                              .reduce((total, row) => total + row.amount, 0),
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="paper-annotation">
                  {document.annotation}
                  <span>↖</span>
                </div>
                <p className="provenance">
                  <span
                    className={`provenance-dot ${document.provenance === "nessie" || document.source !== "nessie" ? "verified" : ""}`}
                  />
                  {document.provenance === "nessie"
                    ? "NESSIE API · VERIFIED TRANSACTION IDS"
                    : document.source !== "nessie"
                      ? "CASE FILE · RECORD ON FILE"
                      : "SCRIPTED DEMO DATA · NESSIE NOT CONNECTED"}
                </p>
                <p className="document-notice">{document.notice}</p>
              </>
            ) : document.log ? (
              <>
                <div className="document-bank">
                  <strong>{document.type}</strong>
                  <span>{document.period}</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Device</th>
                        <th>Event</th>
                      </tr>
                    </thead>
                    <tbody>
                      {document.log.map((row, i) => (
                        <tr key={i}>
                          <td>{row.flagged ? <mark>{row.time}</mark> : row.time}</td>
                          <td>{row.device}</td>
                          <td>{row.event}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="paper-annotation">
                  {document.annotation}
                  <span>↖</span>
                </div>
              </>
            ) : (
              <>
                <blockquote>“{document.statement}”</blockquote>
                <p className="witness-signature">
                  {document.witness?.split(" · ")[0]}
                </p>
                <span className="witness-credit">{document.witness}</span>
                <div className="paper-annotation">{document.annotation}</div>
              </>
            )}
            <div className="document-bottom">
              <span>CHAIN OF CUSTODY · DETECTIVE’S COPY</span>
              <button
                className="paper-button"
                onClick={() => setDocument(null)}
              >
                Back to the board <ArrowRight size={15} />
              </button>
            </div>
          </Modal>
        )}

        {crossing && (
          <Modal
            key="cross"
            className="cross-modal"
            label="Cross-examination"
            onClose={() => {
              if (!busy) {
                stopSpeech();
                setCrossing(false);
              }
            }}
          >
            <div className="cross-heading">
              <div>
                <span className="eyebrow">TWO STORIES. ONE ROOM.</span>
                <h2>Let’s compare notes.</h2>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="Close cross-examination"
                onClick={() => {
                  stopSpeech();
                  setCrossing(false);
                }}
              >
                <X size={21} />
              </button>
            </div>
            <p className="cross-question">“Where were you around midnight?”</p>
            <div className="cross-pair">
              {pair.map((id, index) => {
                const person = data.suspects.find((s) => s.id === id)!;
                return (
                  <div className="cross-person" key={index}>
                    <div className="cross-portrait">
                      <img src={person.portrait} alt={person.name} />
                      <div className="photo-shade" />
                      <span>0{data.suspects.indexOf(person) + 1}</span>
                    </div>
                    <label>
                      <span className="sr-only">
                        {index === 0 ? "First person" : "Second person"}
                      </span>
                      <select
                        value={id}
                        disabled={busy || crossDone}
                        onChange={(event) => {
                          const copy = [...pair];
                          copy[index] = event.target.value;
                          setPair(copy);
                        }}
                      >
                        {data.suspects
                          .filter((p) => p.id !== pair[1 - index])
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <span className="cross-role">{person.role}</span>
                    {crossStatements
                      .filter((statement) => statement.suspect_id === id)
                      .map((statement, i) => (
                        <motion.p
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`cross-statement ${contradiction ? "contradicted" : ""}`}
                          key={i}
                        >
                          “{statement.text}”
                        </motion.p>
                      ))}
                  </div>
                );
              })}
              <span className="versus">×</span>
            </div>
            {contradiction && (
              <motion.div
                className="contradiction-banner"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <Radio size={20} />
                <div>
                  <strong>These stories don’t add up.</strong>
                  <p>
                    Home by 10 PM. Office light on at midnight. Someone is
                    lying.
                  </p>
                </div>
              </motion.div>
            )}
            {crossDone ? (
              <div className="cross-result">
                <span>
                  <CheckCheck size={16} /> Added to your case notes
                </span>
                <button
                  className="primary"
                  onClick={() => {
                    setCrossing(false);
                    openGuess();
                  }}
                >
                  Ready to make a call? <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              <button
                className="primary begin-cross"
                disabled={busy}
                onClick={runCross}
              >
                {busy
                  ? "Listening to both accounts…"
                  : "Put the question to both"}{" "}
                <Users size={17} />
              </button>
            )}
          </Modal>
        )}

        {guessing && (
          <Modal
            key="guess"
            className="guess-modal"
            label="Record your verdict"
            onClose={() => {
              if (!reviewing) setGuessing(false);
            }}
          >
            <button
              className="modal-close"
              disabled={reviewing}
              aria-label="Return to investigation"
              onClick={() => setGuessing(false)}
            >
              <X size={21} />
            </button>
            <span className="eyebrow">THE MOMENT OF TRUTH</span>
            <h2>
              Who’s behind
              <br />
              the missing money?
            </h2>
            <p>Trust the evidence. Make your accusation.</p>
            <div className="verdict-choices">
              {data.suspects.map((person) => (
                <button
                  className={selection === person.id ? "chosen" : ""}
                  key={person.id}
                  disabled={reviewing}
                  onClick={() => setSelection(person.id)}
                >
                  <img src={person.portrait} alt="" />
                  <strong>{person.name}</strong>
                  <span>{person.role}</span>
                  <i>{selection === person.id && <Check size={14} />}</i>
                </button>
              ))}
            </div>
            <button
              className="guess-button confirm-guess"
              disabled={!selection || reviewing}
              onClick={confirmGuess}
            >
              {reviewing ? (
                <>
                  <span className="spinner" /> REVIEWING EVIDENCE…
                </>
              ) : (
                <>
                  <Fingerprint size={19} /> Record my verdict{" "}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
            <small className="verdict-warning">
              The case closes when you record your verdict.
            </small>
            <button
              className="text-button continue-investigating"
              disabled={reviewing}
              onClick={() => setGuessing(false)}
            >
              <ArrowLeft size={13} /> Keep investigating
            </button>
          </Modal>
        )}

        {verdict && (
          <Modal
            key="verdict"
            className={`verdict-modal ${verdict.correct ? "correct" : "incorrect"}`}
            label="Case verdict"
            onClose={() => {}}
          >
            <span className="eyebrow">CASE NO. 001 · VERDICT RECORDED</span>
            <div className="verdict-photo">
              <img
                src={
                  data.suspects.find((p) => p.id === verdict.suspect_id)!
                    .portrait
                }
                alt="Accused suspect"
              />
              <span>
                {data.suspects.find((p) => p.id === verdict.suspect_id)!.name}
              </span>
              <motion.div
                className="rubber-stamp"
                initial={{ scale: 3, opacity: 0, rotate: -23 }}
                animate={{ scale: 1, opacity: 1, rotate: -12 }}
                transition={{
                  delay: 0.3,
                  type: "spring",
                  stiffness: 350,
                  damping: 20,
                }}
              >
                {verdict.correct ? (
                  <>
                    <strong>GUILTY</strong>
                    <span>CASE CLOSED</span>
                  </>
                ) : (
                  <>
                    <strong>WRONG</strong>
                    <span>SUSPECT</span>
                  </>
                )}
              </motion.div>
            </div>
            <h2>
              {verdict.correct
                ? "The numbers don’t lie."
                : "There’s more to the story."}
            </h2>
            <p>
              {verdict.correct
                ? "You followed the paper trail and found the truth."
                : "The real story was hiding between the lines."}
            </p>
            <button className="primary" onClick={showReveal}>
              What really happened <ArrowRight size={17} />
            </button>
          </Modal>
        )}

        {reveal && (
          <Modal
            key="reveal"
            className={`reveal-modal ${ending ? "ending-modal" : ""}`}
            label={ending ? "The next chapter" : "What really happened"}
            onClose={() => {}}
          >
            {!ending ? (
              <>
                <span className="eyebrow">THE SEALED ACCOUNT · NOW OPEN</span>
                <h2>What really happened.</h2>
                <p className="reveal-intro">
                  The paper trail was there all along.
                </p>
                <div className="truth-timeline">
                  {reveal.truth_timeline.map((point, i) => (
                    <motion.article
                      key={point.t}
                      initial={{ opacity: 0, x: -15 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.35 }}
                    >
                      <span className="timeline-dot" />
                      <time>{point.t}</time>
                      <h3>{point.title}</h3>
                      <p>{point.event}</p>
                      {i === 2 && (
                        <div className="reveal-transactions">
                          {reveal.transactions.map((row, j) => (
                            <span key={j}>
                              {row.date.slice(5)} <b>{row.display_time}</b>{" "}
                              {money(row.amount)}
                            </span>
                          ))}
                        </div>
                      )}
                    </motion.article>
                  ))}
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setEnding(true);
                    void speak(reveal.cliffhanger, reveal.guilty_id);
                  }}
                >
                  But one thing still doesn’t add up… <ArrowRight size={16} />
                </button>
              </>
            ) : (
              <>
                <div className="ending-portrait">
                  <img
                    src={
                      data.suspects.find((s) => s.id === reveal.guilty_id)!
                        .portrait
                    }
                    alt="The culprit"
                  />
                </div>
                <span className="eyebrow">JUST BEFORE THE LINE GOES DEAD</span>
                <h2>
                  “<Typewriter text={reveal.cliffhanger} />”
                </h2>
                {nextMission ? (
                  <motion.div
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="next-case"
                  >
                    <span className="eyebrow">CASE 002 · COMING NEXT</span>
                    <h3>{reveal.next_mission.title}</h3>
                    <p>{reveal.next_mission.description}</p>
                    <span className="next-sealed">
                      <LockKeyhole size={13} /> THE NEXT FILE IS STILL SEALED
                    </span>
                  </motion.div>
                ) : (
                  <button
                    className="primary"
                    onClick={() => {
                      stopSpeech();
                      setNextMission(true);
                    }}
                  >
                    Next mission <ArrowRight size={17} />
                  </button>
                )}
                <button className="text-button replay-case" onClick={reset}>
                  <RotateCcw size={14} /> Reopen case 001
                </button>
              </>
            )}
          </Modal>
        )}

        {showHelp && (
          <Modal
            key="help"
            className="help-modal"
            label="How to investigate"
            onClose={() => setShowHelp(false)}
          >
            <button
              className="modal-close"
              onClick={() => setShowHelp(false)}
              aria-label="Close help"
            >
              <X size={21} />
            </button>
            <span className="eyebrow">A NOTE FOR THE DETECTIVE</span>
            <h2>Listen closely.</h2>
            <p>Someone has a story that doesn’t balance.</p>
            <div className="help-steps">
              <div>
                <Phone />
                <p>
                  <strong>Make a call.</strong> Click a photograph, type “call{" "}
                  {data?.suspects[0]?.name.split(" ")[0] ?? "Sam"}”, or hold Space
                  to speak.
                </p>
              </div>
              <div>
                <FileText />
                <p>
                  <strong>Ask for evidence.</strong> Request records and ask
                  witnesses what they saw. Documents pin to the board.
                </p>
              </div>
              <div>
                <Users />
                <p>
                  <strong>Compare their stories.</strong> Interview two people
                  to unlock cross-examination. Present your documents during a
                  call.
                </p>
              </div>
              <div>
                <Fingerprint />
                <p>
                  <strong>Make your accusation.</strong> Choose “Guess now” when
                  you’re ready to close the case.
                </p>
              </div>
            </div>
            <div className="help-footnote">
              <Mic size={16} /> Voice works in Chrome with microphone
              permission. Typed input works everywhere.
            </div>
            <button className="primary" onClick={() => setShowHelp(false)}>
              Back to the case <ArrowRight size={15} />
            </button>
          </Modal>
        )}
        {showBrief && data && (
          <Modal
            key="brief"
            className="help-modal brief-modal"
            label="The case so far"
            onClose={() => setShowBrief(false)}
          >
            <button
              className="modal-close"
              onClick={() => setShowBrief(false)}
              aria-label="Close case brief"
            >
              <X size={21} />
            </button>
            <span className="eyebrow">CASE {data.number} · {data.victim_business.name}</span>
            <h2>{data.opening_letter.subject}</h2>
            <div className="brief-letter">
              <p>Detective,</p>
              {data.opening_letter.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
              <p className="brief-sign">
                — {data.opening_letter.sender}, {data.opening_letter.role}
              </p>
            </div>
            <div className="brief-facts">
              <p>{data.briefing}</p>
              <span>
                UNACCOUNTED FOR <strong>{money(data.amount)}</strong>
              </span>
            </div>
            <button className="primary" onClick={() => setShowBrief(false)}>
              Back to the board <ArrowRight size={15} />
            </button>
          </Modal>
        )}
        {showHandGuide && (
          <Modal
            key="hand-guide"
            className="help-modal hand-guide"
            label="How to play with hand gestures"
            onClose={() => setShowHandGuide(false)}
          >
            <button
              className="modal-close"
              onClick={() => setShowHandGuide(false)}
              aria-label="Close hand guide"
            >
              <X size={21} />
            </button>
            <HandGuide
              onDone={() => setShowHandGuide(false)}
              hideNextTime={hideHandGuide}
              setHideNextTime={rememberHideHandGuide}
            />
          </Modal>
        )}
        {showReset && (
          <Modal
            key="reset"
            className="reset-modal"
            label="Reset the case"
            onClose={() => setShowReset(false)}
          >
            <span className="eyebrow">A CLEAN SLATE</span>
            <h2>Reopen the case?</h2>
            <p>Your evidence, notes, and interviews will be cleared.</p>
            <div className="reset-actions">
              <button
                className="text-button"
                onClick={() => setShowReset(false)}
              >
                Keep investigating
              </button>
              <button className="primary" onClick={reset}>
                <RotateCcw size={15} /> Reset case
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </>
  );
}
