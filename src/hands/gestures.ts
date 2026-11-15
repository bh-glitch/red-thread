// Turns raw hand landmarks into intents. Pure and frame-driven so it can be
// unit-tested with synthetic hands. Hands come in camera space (any uniform
// scale, z optional); `map` converts a camera point to screen pixels. Hand shape
// (pinch, palm, fist) is judged in camera space — in 3D when depth is available —
// so the screen's aspect ratio never distorts it.
import { OneEuro2D } from "./oneEuro";

export type Pt = { x: number; y: number; z?: number };
/** 21 MediaPipe landmarks in uniform camera space. */
export type Hand = Pt[];
export type MapFn = (p: Pt) => Pt;

export type Intent =
  | { type: "tap"; at: Pt }
  /** Pinch closed / opened: for hold-to-talk buttons like the call mic. */
  | { type: "press"; at: Pt }
  | { type: "release" }
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number; at: Pt }
  | { type: "focus"; at: Pt }
  | { type: "reset" }
  /** Dialog only: open palm held still = close (hang up / back). */
  | { type: "close" }
  /** Dialog only: a fist works like holding Space — talk while held. */
  | { type: "talkStart" }
  | { type: "talkEnd" };

export type CursorState = {
  visible: boolean;
  at: Pt;
  pinched: boolean;
  talking: boolean;
  /** 0..1 progress of a hold gesture. */
  hold: number;
  holdKind: "click" | "focus" | "reset" | "close" | null;
  hands: number;
};

// Thresholds (relative to hand size, so they work near or far from the camera).
export const PINCH_ON = 0.36; // thumb–index gap / palm length
export const PINCH_OFF = 0.52; // looser release = no flicker (hysteresis)
// "Point and shoot": thumb tip to the side of the index finger (knuckle→middle
// joint), relative to palm length. Pressed below ON, released above OFF.
export const THUMB_ON = 0.32;
export const THUMB_OFF = 0.5;

/**
 * How you click:
 *  • "peace" (default) — hold a peace sign (index + middle up, ring + pinky
 *    curled) still for 1 s. The cursor follows your knuckles, which don't move
 *    when your fingers change shape, so it stays on target.
 *  • "pinch" — touch thumb tip to index tip and let go.
 *  • "thumb" — finger gun: tap the thumb onto the side of the index finger.
 * In every style a pinch still drags (pan) and pinch-holds zoom on the board.
 */
export type ClickStyle = "peace" | "thumb" | "pinch";
const PEACE_HOLD_MS = 1000;
const PEACE_MOVE_PX = 40; // drifting further than this restarts the 1 s count
const PEACE_GRACE_MS = 150; // brief tracking dropouts don't reset the count
const BOARD_TAP_MAX_MS = 700;
const DRAG_START_PX = 26;
const FOCUS_HOLD_MS = 1000;
const RESET_HOLD_MS = 700;
const CLOSE_HOLD_MS = 1000;
const PALM_STILL_PX = 45; // the palm must stay roughly still to count
const FIST_ON_MS = 160;
const FIST_OFF_MS = 220;
const LOST_GRACE_MS = 180;
/** After a board pinch ends, keep looking for a second hand this long (ms). */
const TWO_HAND_ARM_MS = 1500;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a: Pt, b: Pt) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const palmLength = (hand: Hand) => dist3(hand[0], hand[9]) || 1;

/** Distance from p to the segment a–b (3D). */
function segDist3(p: Pt, a: Pt, b: Pt) {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: (b.z ?? 0) - (a.z ?? 0) };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: (p.z ?? 0) - (a.z ?? 0) };
  const len = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z || 1;
  const k = Math.min(1, Math.max(0, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len));
  return Math.hypot(ap.x - ab.x * k, ap.y - ab.y * k, ap.z - ab.z * k);
}

/** Thumb tip's distance to the side of the index finger (knuckle → middle joint). */
export function thumbPressRatio(hand: Hand) {
  return segDist3(hand[4], hand[5], hand[6]) / palmLength(hand);
}

export function pressRatio(hand: Hand, style: ClickStyle) {
  return style === "thumb" ? thumbPressRatio(hand) : pinchRatio(hand);
}
const pressOn = (style: ClickStyle) => (style === "thumb" ? THUMB_ON : PINCH_ON);
const pressOff = (style: ClickStyle) => (style === "thumb" ? THUMB_OFF : PINCH_OFF);

export function pinchRatio(hand: Hand) {
  return dist3(hand[4], hand[8]) / palmLength(hand);
}

/** All four fingers extended (tips farther from the wrist than their PIP joints). */
export function isOpenPalm(hand: Hand) {
  return (
    [
      [8, 6],
      [12, 10],
      [16, 14],
      [20, 18],
    ].every(
      ([tip, pip]) => dist3(hand[tip], hand[0]) > dist3(hand[pip], hand[0]) * 1.15,
    ) && pinchRatio(hand) > 0.7
  );
}

const extended = (hand: Hand, tip: number, pip: number) =>
  dist3(hand[tip], hand[0]) > dist3(hand[pip], hand[0]) * 1.12;
const curled = (hand: Hand, tip: number, pip: number) =>
  dist3(hand[tip], hand[0]) < dist3(hand[pip], hand[0]);

/**
 * "Call me" / shaka 🤙: thumb and pinky out, index, middle and ring curled.
 * Held = talk (like holding Space), on the board and in calls.
 */
export function isShaka(hand: Hand) {
  const palm = palmLength(hand);
  return (
    extended(hand, 20, 18) &&
    curled(hand, 8, 6) &&
    curled(hand, 12, 10) &&
    curled(hand, 16, 14) &&
    dist3(hand[4], hand[5]) > palm * 0.55 // thumb sticking out, away from the index knuckle
  );
}

/** Peace sign: index and middle fingers up, ring and pinky curled (thumb ignored). */
export function isPeace(hand: Hand) {
  return extended(hand, 8, 6) && extended(hand, 12, 10) && curled(hand, 16, 14) && curled(hand, 20, 18);
}

/**
 * Index, middle and ring fingertips folded onto the palm. A pinch (even an
 * "OK" sign) keeps the index tip out in front of the palm, so it doesn't count.
 */
export function isFist(hand: Hand) {
  const palm = palmLength(hand);
  const centre = [0, 5, 9, 13, 17].reduce<Pt>(
    (c, i) => ({
      x: c.x + hand[i].x / 5,
      y: c.y + hand[i].y / 5,
      z: (c.z ?? 0) + (hand[i].z ?? 0) / 5,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return (
    [8, 12, 16].every((tip) => dist3(hand[tip], centre) < palm * 0.62) &&
    [
      [12, 10],
      [16, 14],
    ].every(([tip, pip]) => dist3(hand[tip], hand[0]) < dist3(hand[pip], hand[0]))
  );
}

/**
 * Where the cursor is. Point-and-shoot: the index fingertip (blended a little
 * toward the next joint, which jitters less). Pinch: the thumb–index midpoint,
 * which barely moves as the two tips close.
 */
export function cursorPoint(hand: Hand, map: MapFn = (p) => p, style: ClickStyle = "pinch") {
  // Peace: the index and middle knuckles. Fingers can open and close freely
  // without moving the cursor at all.
  if (style === "peace") return map(mid(hand[5], hand[9]));
  if (style === "thumb")
    return map({
      x: hand[8].x * 0.75 + hand[7].x * 0.25,
      y: hand[8].y * 0.75 + hand[7].y * 0.25,
    });
  return map(mid(hand[4], hand[8]));
}

export class GestureEngine {
  /**
   * "board": tap, drag-pan, hold-to-focus, two-hand zoom, palm = zoom out.
   * "dialog" (a call or popup is open): tap, press/release, palm = close,
   * fist = talk.
   */
  mode: "board" | "dialog" = "board";
  clickStyle: ClickStyle = "peace";
  private peaceSince = 0;
  private peaceAnchor: Pt | null = null;
  private peaceAt: Pt = { x: 0, y: 0 };
  private peaceFired = false;
  private notPeaceSince = 0;
  /** A press only counts after the thumb/fingers were seen apart (no click from a hand that appears already closed). */
  private armed = false;
  // Light smoothing at rest, almost none when moving fast: less lag than before.
  private smooth = new OneEuro2D(1.6, 0.06);
  private history: { t: number; at: Pt }[] = [];
  private pinched = false;
  private downAt: Pt = { x: 0, y: 0 };
  private downT = 0;
  private dragging = false;
  private focusFired = false;
  private fistDuringPinch = false;
  private last: Pt | null = null;
  private palmSince = 0;
  private palmAnchor: Pt | null = null;
  private palmFired = false;
  private fistSince = 0;
  private notFistSince = 0;
  private talking = false;
  private twoHandDist = 0;
  private twoHandUntil = 0;
  private lastT = 0;
  private lostAt = 0;
  private cursor: CursorState = {
    visible: false,
    at: { x: 0, y: 0 },
    pinched: false,
    talking: false,
    hold: 0,
    holdKind: null,
    hands: 0,
  };

  get state() {
    return this.cursor;
  }

  /**
   * Whether the tracker should look for a second hand. Tracking two hands costs
   * ~5× per frame, so it's only on while a board pinch is held (or just ended)
   * or a two-hand zoom is in progress — the only times a two-hand zoom can start.
   */
  get wantsTwoHands() {
    return (
      this.mode === "board" &&
      (this.pinched || this.twoHandDist > 0 || this.lastT < this.twoHandUntil)
    );
  }

  /** Cursor position ~`ms` ago: the click lands where you aimed, not where the pinch dragged you. */
  private aimed(t: number, ms = 90) {
    for (let i = this.history.length - 1; i >= 0; i--)
      if (t - this.history[i].t >= ms) return this.history[i].at;
    return this.history[0]?.at ?? this.cursor.at;
  }

  update(hands: Hand[], t: number, map: MapFn = (p) => p): Intent[] {
    const out: Intent[] = [];
    this.lastT = t;
    if (this.mode === "board" && (this.pinched || this.twoHandDist > 0))
      this.twoHandUntil = t + TWO_HAND_ARM_MS;
    if (!hands.length) {
      if (!this.lostAt) this.lostAt = t;
      if (t - this.lostAt > LOST_GRACE_MS) {
        if (this.release()) out.push({ type: "release" });
        if (this.talking) out.push({ type: "talkEnd" });
        this.talking = false;
        this.fistSince = 0;
        this.armed = false;
      }
      this.cursor = {
        ...this.cursor,
        visible: false,
        talking: this.talking,
        hands: 0,
        hold: 0,
        holdKind: null,
      };
      return out;
    }
    this.lostAt = 0;

    // Two hands, both pinching: spread/close to zoom around their midpoint.
    if (hands.length >= 2 && this.mode === "board") {
      const [a, b] = hands;
      const on = pressOn(this.clickStyle);
      if (pressRatio(a, this.clickStyle) < on && pressRatio(b, this.clickStyle) < on) {
        const pa = cursorPoint(a, map, this.clickStyle),
          pb = cursorPoint(b, map, this.clickStyle);
        const d = dist(pa, pb);
        if (this.twoHandDist > 0 && d > 0) {
          const factor = d / this.twoHandDist;
          if (Math.abs(factor - 1) > 0.004)
            out.push({ type: "zoom", factor, at: mid(pa, pb) });
        }
        this.twoHandDist = d;
        if (this.pinched) out.push({ type: "release" });
        this.pinched = false; // two-hand zoom never ends in a click
        this.dragging = true;
        this.cursor = {
          ...this.cursor,
          visible: true,
          at: mid(pa, pb),
          pinched: true,
          hands: 2,
          hold: 0,
          holdKind: null,
        };
        return out;
      }
    }
    this.twoHandDist = 0;

    // With a second hand in view, keep following the one already driving the cursor.
    const hand =
      hands.length > 1 && this.cursor.visible
        ? hands.reduce((best, h) =>
            dist(cursorPoint(h, map, this.clickStyle), this.cursor.at) <
            dist(cursorPoint(best, map, this.clickStyle), this.cursor.at)
              ? h
              : best,
          )
        : hands[0];
    const at = this.smooth.filter(cursorPoint(hand, map, this.clickStyle), t);
    this.history.push({ t, at });
    while (this.history.length > 12) this.history.shift();
    const ratio = pressRatio(hand, this.clickStyle);
    if (ratio > pressOff(this.clickStyle)) this.armed = true;
    let hold = 0;
    let holdKind: CursorState["holdKind"] = null;

    // 🤙 = hold-to-talk everywhere; a fist also talks in calls. Debounced both ways.
    {
      if (isShaka(hand) || (this.mode === "dialog" && isFist(hand))) {
        this.notFistSince = 0;
        if (!this.fistSince) this.fistSince = t;
        if (!this.talking && t - this.fistSince >= FIST_ON_MS) {
          this.talking = true;
          out.push({ type: "talkStart" });
        }
        if (this.pinched) this.fistDuringPinch = true;
      } else {
        this.fistSince = 0;
        if (this.talking) {
          if (!this.notFistSince) this.notFistSince = t;
          if (t - this.notFistSince >= FIST_OFF_MS) {
            this.talking = false;
            out.push({ type: "talkEnd" });
          }
        }
      }
    }

    if (!this.pinched && this.armed && ratio < pressOn(this.clickStyle)) {
      this.pinched = true;
      this.armed = false;
      this.dragging = false;
      this.focusFired = false;
      this.fistDuringPinch = this.talking;
      this.downT = t;
      this.downAt = this.aimed(t);
      this.last = at;
      out.push({ type: "press", at: this.downAt });
    } else if (this.pinched && ratio > pressOff(this.clickStyle)) {
      // Dialogs: any pinch-and-open clicks, however slow. Board: quick taps only
      // (a long still pinch means "zoom onto this").
      const quick = this.mode === "dialog" || t - this.downT <= BOARD_TAP_MAX_MS;
      if (
        quick &&
        this.clickStyle !== "peace" &&
        !this.dragging &&
        !this.focusFired &&
        !this.fistDuringPinch &&
        !this.talking
      )
        out.push({ type: "tap", at: this.downAt });
      this.release();
      out.push({ type: "release" });
    } else if (this.pinched && this.mode === "board") {
      if (!this.dragging && dist(at, this.downAt) > DRAG_START_PX) this.dragging = true;
      if (this.dragging && this.last) {
        const dx = at.x - this.last.x,
          dy = at.y - this.last.y;
        if (dx || dy) out.push({ type: "pan", dx: -dx * 1.6, dy: -dy * 1.6 });
      } else if (hands.length > 1) {
        // A second hand is coming in for a two-hand zoom: don't zoom onto a card.
        this.downT = t;
      } else if (!this.focusFired) {
        hold = Math.min(1, (t - this.downT) / FOCUS_HOLD_MS);
        holdKind = "focus";
        if (hold >= 1) {
          this.focusFired = true;
          out.push({ type: "focus", at: this.downAt });
        }
      }
      this.last = at;
    }
    // (In dialogs a pinch only clicks; drifting a little while pinched is fine.)

    // Peace sign held still for 1 s = click (peace style).
    if (this.clickStyle === "peace") {
      const peace = !this.pinched && !this.talking && isPeace(hand);
      if (peace) {
        this.notPeaceSince = 0;
        if (!this.peaceSince || !this.peaceAnchor || dist(at, this.peaceAnchor) > PEACE_MOVE_PX) {
          this.peaceSince = t; // (re)start the count where the cursor is now
          this.peaceAnchor = at;
          this.peaceAt = this.aimed(t);
        }
      } else if (this.peaceSince) {
        if (!this.notPeaceSince) this.notPeaceSince = t;
        if (t - this.notPeaceSince > PEACE_GRACE_MS) {
          this.peaceSince = 0;
          this.peaceAnchor = null;
          this.peaceFired = false;
        }
      }
      if (this.peaceSince && !this.peaceFired) {
        hold = Math.min(1, (t - this.peaceSince) / PEACE_HOLD_MS);
        holdKind = "click";
        if (hold >= 1) {
          this.peaceFired = true; // one click per peace sign; drop it to click again
          out.push({ type: "tap", at: this.peaceAt });
        }
      }
    }

    // Open palm held still: board → zoom out; dialog → close it (hang up).
    if (!this.pinched && !this.talking && isOpenPalm(hand)) {
      const centre = map(hand[9]);
      if (
        !this.palmSince ||
        !this.palmAnchor ||
        dist(centre, this.palmAnchor) > PALM_STILL_PX
      ) {
        this.palmSince = t; // moved: start over, so pointing around doesn't trigger it
        this.palmAnchor = centre;
      }
      const needed = this.mode === "dialog" ? CLOSE_HOLD_MS : RESET_HOLD_MS;
      hold = Math.min(1, (t - this.palmSince) / needed);
      holdKind = this.mode === "dialog" ? "close" : "reset";
      if (hold >= 1 && !this.palmFired) {
        this.palmFired = true;
        out.push({ type: this.mode === "dialog" ? "close" : "reset" });
      }
    } else {
      this.palmSince = 0;
      this.palmAnchor = null;
      this.palmFired = false;
    }

    this.cursor = {
      visible: true,
      at,
      pinched: this.pinched,
      talking: this.talking,
      hold,
      holdKind,
      hands: hands.length,
    };
    return out;
  }

  /** Returns whether a pinch was held (so callers can emit "release"). */
  private release() {
    const was = this.pinched;
    this.pinched = false;
    this.dragging = false;
    this.fistDuringPinch = false;
    this.last = null;
    this.twoHandDist = 0;
    return was;
  }

  /** Forget everything (mode change). Returns the intents needed to clean up. */
  reset(): Intent[] {
    const out: Intent[] = [];
    if (this.release()) out.push({ type: "release" });
    if (this.talking) out.push({ type: "talkEnd" });
    this.talking = false;
    this.fistSince = 0;
    this.notFistSince = 0;
    this.armed = false;
    this.peaceSince = 0;
    this.peaceAnchor = null;
    this.peaceFired = false;
    this.smooth.reset();
    this.history = [];
    this.palmSince = 0;
    this.palmAnchor = null;
    this.palmFired = false;
    return out;
  }
}
