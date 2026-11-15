// Hand control overlay. A cursor follows your thumb–index pinch point and snaps
// onto nearby targets; pinch-and-open clicks. It works in two modes:
//  • board: pinch-drag pans, pinch-hold zooms onto a person, two-hand pinch
//    zooms, open palm zooms back out. A second hand is only tracked while you
//    pinch (tracking two costs ~5× per frame).
//  • dialog (a call or any popup is open): the cursor moves over that dialog and
//    targets its buttons. A fist talks (like holding Space); an open palm held
//    still closes the dialog (hangs up), so you never reach for the corner.
// Mouse and keyboard keep working alongside.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GestureEngine, type ClickStyle, type Intent, type Pt } from "./gestures";
import { HandTracker, toBoard } from "./tracker";
import type { BoardCamera } from "./useBoardCamera";
import "./hands.css";

/** Things a finger can click on the board. */
const BOARD_TARGETS =
  ".suspect-card:not(.missing-card), .card-tools > button, .pinned-document, .witness-sticky";
/** Things a finger can click inside a call or popup. */
const DIALOG_TARGETS =
  'button, input, select, textarea, a[href], [role="button"], [data-hand-target]';
/** Buttons that act while held (the call mic). */
const HOLD = "[data-hand-hold]";
/** How far outside a target the cursor is still pulled onto it (px). */
const MAGNET = { board: 34, dialog: 60 };
const HOVER = "hand-hover";
/** Once a target is outlined, the cursor must move this much further away to let go of it (px). */
const STICKY = 26;
/** Extra room around a dialog so its edge buttons are easy to reach (px). */
const DIALOG_PAD = 40;
/** Target rectangles are re-measured this often, not every frame (ms). */
const TARGET_REFRESH_MS = 120;

type Mode = "board" | "dialog" | "idle";
type Area = { left: number; top: number; w: number; h: number };
type Target = { el: HTMLElement; r: DOMRect };

function measure(root: Element, selector: string): Target[] {
  const list: Target[] = [];
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    if ((el as HTMLButtonElement).disabled) return;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) list.push({ el, r });
  });
  return list;
}

function gapTo(r: DOMRect, p: Pt) {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Sticky targeting: keep the outlined target while the cursor stays near it,
 * unless the cursor is clearly inside a different one. Small wobbles never
 * flip the outline to a neighbour.
 */
function pick(targets: Target[], p: Pt, magnet: number, current: HTMLElement | null) {
  const candidate = nearest(targets, p, magnet);
  if (!current || candidate === current) return candidate;
  const mine = targets.find((t) => t.el === current);
  if (!mine || !current.isConnected || (current as HTMLButtonElement).disabled) return candidate;
  if (gapTo(mine.r, p) > magnet + STICKY) return candidate;
  const theirs = candidate && targets.find((t) => t.el === candidate);
  return theirs && gapTo(theirs.r, p) === 0 && gapTo(mine.r, p) > 0 ? candidate : current;
}

function nearest(targets: Target[], p: Pt, magnet: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const { el, r } of targets) {
    if ((el as HTMLButtonElement).disabled || !el.isConnected) continue;
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    const gap = Math.hypot(dx, dy);
    if (gap > magnet) continue;
    // Inside beats nearby; among overlapping targets prefer the smaller one
    // (the "Suspect" tag over the photo it sits under).
    const score = gap === 0 ? -1 / (r.width * r.height) : gap;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** The dialog on top, if a call or popup is open. */
function topDialog() {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  return all[all.length - 1] ?? null;
}

function pointer(el: Element, type: "pointerdown" | "pointerup", at: Pt) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      pointerId: 7001,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
    }),
  );
}

export default function HandControl({
  on,
  clickStyle = "peace",
  paused,
  viewport,
  camera,
  onError,
}: {
  on: boolean;
  /** How a click is made. Fixed to the peace sign in the game. */
  clickStyle?: ClickStyle;
  /** Board input is off (e.g. connecting a call); dialogs still work. */
  paused: boolean;
  viewport: HTMLElement | null;
  camera: BoardCamera;
  onError: (message: string) => void;
}) {
  const cursor = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<"loading" | "nohand" | "talking" | Mode>("loading");
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const styleRef = useRef(clickStyle);
  styleRef.current = clickStyle;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    if (!on) return;
    const engine = new GestureEngine();
    let hovered: HTMLElement | null = null;
    let card: Element | null = null;
    let held: HTMLElement | null = null;
    /** What was outlined when the press began: exactly what the click hits. */
    let pressTarget: HTMLElement | null = null;
    let peaceLocked = false;
    let mode: Mode = "idle";
    let targets: Target[] = [];
    let measuredAt = 0;
    let lastStatus = "";
    let alive = true;

    function setHover(el: HTMLElement | null) {
      if (el === hovered) {
        // React may have rewritten className (e.g. the mic's "recording").
        hovered?.classList.add(HOVER);
        card?.classList.add(HOVER);
        return;
      }
      hovered?.classList.remove(HOVER);
      card?.classList.remove(HOVER);
      hovered = el;
      card = el?.closest(".suspect-card") ?? null;
      hovered?.classList.add(HOVER);
      card?.classList.add(HOVER);
    }
    function hold(el: HTMLElement | null, at: Pt) {
      if (!el || held) return;
      held = el;
      pointer(el, "pointerdown", at);
    }
    function letGo(at: Pt) {
      if (held) pointer(held, "pointerup", at);
      held = null;
    }
    function report(next: string) {
      if (next !== lastStatus) setStatus((lastStatus = next) as typeof status);
    }

    const tracker = new HandTracker((raw, t) => {
      const dot = cursor.current;
      if (!dot) return;

      // Work out where the hand is aiming this frame.
      const dialog = topDialog();
      const board = viewportRef.current;
      let next: Mode = "idle";
      let area: Area | null = null;
      if (dialog) {
        next = "dialog";
        const r = dialog.getBoundingClientRect();
        const left = Math.max(0, r.left - DIALOG_PAD);
        const top = Math.max(0, r.top - DIALOG_PAD);
        area = {
          left,
          top,
          w: Math.min(innerWidth, r.right + DIALOG_PAD) - left,
          h: Math.min(innerHeight, r.bottom + DIALOG_PAD) - top,
        };
      } else if (board && !pausedRef.current) {
        next = "board";
        const r = board.getBoundingClientRect();
        area = {
          left: r.left + board.clientLeft,
          top: r.top + board.clientTop,
          w: board.clientWidth,
          h: board.clientHeight,
        };
      }
      if (next !== mode) {
        engine.reset(); // coordinates change meaning between modes
        letGo(engine.state.at);
        setHover(null);
        mode = next;
        measuredAt = 0;
        if (mode !== "idle") engine.mode = mode;
      }
      if (meter.current)
        meter.current.textContent = `${tracker.stats.fps} fps · ${tracker.stats.detectMs.toFixed(0)} ms · ${tracker.stats.delegate}`;
      if (mode === "idle" || !area) {
        dot.dataset.visible = "false";
        report("idle");
        return;
      }

      const root = mode === "dialog" ? dialog! : board!;
      if (t - measuredAt > TARGET_REFRESH_MS) {
        targets = measure(root, mode === "dialog" ? DIALOG_TARGETS : BOARD_TARGETS);
        measuredAt = t;
      }
      const video = tracker.video;
      const aspect = video.videoWidth / (video.videoHeight || 1) || 4 / 3;
      const hands = raw.map((h) =>
        h.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z * aspect })),
      );
      const size = { w: area.w, h: area.h };
      const map = (p: Pt) => toBoard({ x: p.x / aspect, y: p.y }, size);
      if (engine.clickStyle !== styleRef.current) {
        engine.reset();
        engine.clickStyle = styleRef.current;
      }
      const intents: Intent[] = engine.update(hands, t, map);
      tracker.setNumHands(engine.wantsTwoHands ? 2 : 1);
      const s = engine.state;
      const local = {
        x: Math.min(size.w, Math.max(0, s.at.x)),
        y: Math.min(size.h, Math.max(0, s.at.y)),
      };
      const client = (p: Pt) => ({ x: area!.left + p.x, y: area!.top + p.y });
      const magnet = MAGNET[mode];
      const at = client(local);
      const outlined = hovered; // what the player saw outlined last frame
      const usable = (el: HTMLElement | null) =>
        el && el.isConnected && !(el as HTMLButtonElement).disabled ? el : null;
      // Peace-sign click: lock the outlined target when the 1 s count starts.
      const loading = s.holdKind === "click";
      if (loading && !peaceLocked) {
        peaceLocked = true;
        pressTarget = usable(outlined) ?? pick(targets, at, magnet, hovered);
      } else if (!loading && peaceLocked && !s.pinched) {
        peaceLocked = false;
        if (!intents.some((i) => i.type === "tap")) pressTarget = null;
      }
      // While pressed or loading, the outline is frozen: the click goes where you aimed.
      const target =
        !s.visible || s.talking
          ? null
          : peaceLocked
            ? pressTarget
            : s.pinched && hovered
              ? hovered
              : pick(targets, at, magnet, hovered);
      setHover(target);

      for (const intent of intents) {
        if (intent.type === "press") {
          pressTarget = usable(outlined) ?? nearest(targets, client(intent.at), magnet);
          if (pressTarget?.matches(HOLD)) hold(pressTarget, client(intent.at));
        } else if (intent.type === "release") {
          pressTarget = null;
          if (!s.talking) letGo(at);
        } else if (intent.type === "talkStart") {
          // 🤙 / fist = hold Space: press the call's mic, or on the board the
          // voice-command mic in the bottom bar, wherever the cursor is.
          const scope = mode === "dialog" ? dialog : document.querySelector(".command-dock");
          const mic = scope?.querySelector<HTMLElement>(`${HOLD}:not(:disabled)`);
          if (mic) {
            letGo(at);
            hold(mic, at);
          }
        } else if (intent.type === "talkEnd") {
          letGo(at);
        } else if (intent.type === "close") {
          // Same as pressing Escape: hangs up a call, closes any popup.
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        } else if (intent.type === "tap") {
          const hit = usable(pressTarget) ?? nearest(targets, client(intent.at), magnet);
          pressTarget = null;
          peaceLocked = false;
          if (!hit || hit.matches(HOLD)) continue;
          if (hit.matches("input, textarea, select")) hit.focus();
          else hit.click();
          measuredAt = 0; // the page probably changed
          dot.classList.remove("hand-tap");
          void dot.offsetWidth; // restart the ripple animation
          dot.classList.add("hand-tap");
        } else if (intent.type === "pan") camera.api.panBy(intent.dx, intent.dy);
        else if (intent.type === "zoom")
          camera.api.zoomAt(intent.factor, intent.at.x, intent.at.y);
        else if (intent.type === "reset") camera.api.reset();
        else if (intent.type === "focus") {
          const hit = usable(pressTarget) ?? nearest(targets, client(intent.at), magnet);
          const subject = hit?.closest(".suspect-card, .pinned-document, .witness-sticky");
          if (subject) camera.api.focus(subject);
          else camera.api.zoomAt(1.6, intent.at.x, intent.at.y);
          measuredAt = 0;
        }
      }
      // Panning/zooming moves the board's targets.
      if (mode === "board" && intents.some((i) => i.type === "pan" || i.type === "zoom"))
        measuredAt = 0;

      dot.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
      dot.style.setProperty("--hold", String(s.hold));
      dot.dataset.visible = String(s.visible);
      dot.dataset.pinched = String(s.pinched);
      dot.dataset.hold = s.holdKind ?? "";
      dot.dataset.target = String(!!target);
      dot.dataset.talking = String(!!held);
      report(held ? "talking" : s.visible ? mode : "nohand");
    });

    tracker
      .start()
      .then(() => {
        if (!alive) return tracker.stop();
        tracker.video.className = "hand-preview-video";
        preview.current?.prepend(tracker.video);
        report("nohand");
      })
      .catch((error: unknown) => {
        tracker.stop();
        if (!alive) return;
        const name = (error as { name?: string })?.name;
        errorRef.current(
          name === "NotAllowedError"
            ? "Camera permission was denied — hand control is off."
            : name === "NotFoundError"
              ? "No camera found — hand control is off."
              : "Hand tracking could not start. Run `npm run setup:hands`, then reload.",
        );
      });

    return () => {
      alive = false;
      letGo(engine.state.at);
      setHover(null);
      tracker.stop();
      tracker.video.remove();
      setStatus("loading");
    };
  }, [on, camera.api]);

  if (!on) return null;
  const label: Record<typeof status, string> = {
    loading: "Starting camera…",
    nohand: "Show your hand",
    idle: "Paused",
    board:
      clickStyle === "peace"
        ? "✌ 1 s: click · 🤙: speak a command"
        : clickStyle === "thumb"
          ? "Point · thumb down to click"
          : "Pinch to click",
    dialog:
      clickStyle === "peace"
        ? "✌ 1 s: choose · 🤙: talk · ✋: hang up"
        : clickStyle === "thumb"
          ? "Thumb: choose · Fist: talk · Palm: hang up"
          : "Pinch: choose · Fist: talk · Palm: hang up",
    talking: "Listening… drop the 🤙 to send",
  };
  // Portaled to <body> so the cursor floats above calls and popups too.
  return createPortal(
    <>
      <div className="hand-cursor" ref={cursor} data-visible="false" aria-hidden="true">
        <span className="hand-cursor-ring" />
        <span className="hand-cursor-dot" />
      </div>
      <div
        className={`hand-preview ${status === "idle" ? "is-paused" : ""} ${status === "talking" ? "is-talking" : ""}`}
        ref={preview}
      >
        <span className="hand-preview-meter" ref={meter} />
        <span className="hand-preview-label">{label[status]}</span>
      </div>
    </>,
    document.body,
  );
}
