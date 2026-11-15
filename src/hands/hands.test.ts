import { describe, expect, it } from "vitest";
import { HOME, clampView, focusOn, panBy, zoomAt } from "./camera";
import {
  GestureEngine,
  isFist,
  isOpenPalm,
  isPeace,
  isShaka,
  pinchRatio,
  type Hand,
  type Intent,
} from "./gestures";
import { OneEuro } from "./oneEuro";
import { toBoard } from "./tracker";

const size = { w: 1000, h: 600 };

describe("board camera", () => {
  it("keeps the zoom point under the finger", () => {
    const v = zoomAt(HOME, 2, 300, 200, size);
    expect(v.scale).toBe(2);
    // Board point (300,200) still appears at screen (300,200).
    expect(v.x + 300 * v.scale).toBeCloseTo(300);
    expect(v.y + 200 * v.scale).toBeCloseTo(200);
  });

  it("never zooms out past the whole board or beyond 3×", () => {
    expect(zoomAt(HOME, 0.5, 500, 300, size)).toEqual(HOME);
    expect(zoomAt(HOME, 10, 500, 300, size).scale).toBe(3);
  });

  it("clamps panning so no empty space shows", () => {
    expect(panBy(HOME, 200, 200, size)).toEqual(HOME);
    const z = zoomAt(HOME, 2, 0, 0, size);
    expect(panBy(z, -5000, -5000, size)).toEqual({ scale: 2, x: -1000, y: -600 });
  });

  it("focuses a card in the centre of the frame", () => {
    const v = focusOn(HOME, { left: 425, top: 200, width: 150, height: 200 }, size);
    expect(v.scale).toBeCloseTo(2.1);
    expect(v.x + 500 * v.scale).toBeCloseTo(500);
    expect(v.y + 300 * v.scale).toBeCloseTo(300);
    // A card at the edge can't be centred past the board's edge.
    const edge = focusOn(HOME, { left: 0, top: 0, width: 150, height: 200 }, size);
    expect(clampView(edge, size)).toEqual(edge);
    expect(edge.x).toBe(0);
  });
});

describe("camera mapping", () => {
  it("mirrors x and uses only the central part of the frame", () => {
    const left = toBoard({ x: 0.82, y: 0.16 }, size);
    expect(left.x).toBeCloseTo(0);
    expect(left.y).toBeCloseTo(0);
    const right = toBoard({ x: 0.18, y: 0.84 }, size);
    expect(right.x).toBeCloseTo(1000);
    expect(right.y).toBeCloseTo(600);
  });
});

/** Synthetic hand: wrist at (cx, cy+0.2), thumb tip and index tip `gap` apart. */
function hand(cx: number, cy: number, gap: number, open = false): Hand {
  const pts: Hand = Array.from({ length: 21 }, () => ({ x: cx, y: cy + 0.1 }));
  pts[0] = { x: cx, y: cy + 0.2 }; // wrist
  pts[9] = { x: cx, y: cy }; // middle knuckle → palm length 0.2
  pts[4] = { x: cx - gap / 2, y: cy - 0.05 };
  pts[8] = { x: cx + gap / 2, y: cy - 0.05 };
  // Finger PIP joints sit between knuckle and tip; tips far when open.
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    pts[pip] = { x: pts[tip === 8 ? 8 : tip].x, y: cy - 0.03 };
    if (tip !== 8) pts[tip] = { x: cx, y: open ? cy - 0.15 : cy + 0.05 };
  }
  if (open) pts[8] = { x: cx + gap / 2, y: cy - 0.15 };
  return pts;
}

/** Most tests use pinch-shaped synthetic hands. */
function pinchEngine() {
  const e = new GestureEngine();
  e.clickStyle = "pinch";
  return e;
}

/**
 * Synthetic finger gun: index pointing up, other fingers curled, thumb either
 * up (away from the index finger) or pressed onto its side.
 */
function gun(cx: number, cy: number, thumbDown: boolean): Hand {
  const pts: Hand = Array.from({ length: 21 }, () => ({ x: cx, y: cy + 0.1 }));
  pts[0] = { x: cx, y: cy + 0.2 };
  pts[9] = { x: cx, y: cy };
  pts[5] = { x: cx + 0.03, y: cy + 0.01 };
  pts[6] = { x: cx + 0.03, y: cy - 0.06 };
  pts[7] = { x: cx + 0.03, y: cy - 0.1 };
  pts[8] = { x: cx + 0.03, y: cy - 0.14 };
  for (const [tip, pip] of [[12, 10], [16, 14], [20, 18]]) {
    pts[pip] = { x: cx, y: cy - 0.03 };
    pts[tip] = { x: cx, y: cy + 0.05 };
  }
  pts[4] = thumbDown ? { x: cx, y: cy - 0.03 } : { x: cx - 0.1, y: cy - 0.05 };
  return pts;
}

/** Synthetic fist: every fingertip folded onto the palm, thumb across it. */
function fist(cx: number, cy: number): Hand {
  const pts = hand(cx, cy, 0.15);
  pts[8] = { x: cx, y: cy + 0.05 };
  pts[4] = { x: cx - 0.03, y: cy + 0.03 };
  return pts;
}

function run(engine: GestureEngine, frames: [Hand[], number][]) {
  const out: Intent[] = [];
  // Camera units → board pixels, like the real overlay does.
  const map = (p: { x: number; y: number }) => ({ x: p.x * 1000, y: p.y * 600 });
  for (const [hands, t] of frames) out.push(...engine.update(hands, t, map));
  // press/release are covered by their own test; most tests check the rest.
  return out.filter((i) => i.type !== "press" && i.type !== "release");
}

describe("gestures", () => {
  it("measures pinch relative to hand size", () => {
    expect(pinchRatio(hand(0.5, 0.5, 0.02))).toBeLessThan(0.3);
    expect(pinchRatio(hand(0.5, 0.5, 0.15))).toBeGreaterThan(0.45);
    // Same gesture twice as far from the camera → same ratio.
    const near = hand(0.5, 0.5, 0.1);
    const far = near.map((p) => ({ x: p.x / 2, y: p.y / 2 }));
    expect(pinchRatio(far)).toBeCloseTo(pinchRatio(near));
  });

  it("pinch-tap clicks where you aimed", () => {
    const e = pinchEngine();
    const intents = run(e, [
      [[hand(0.5, 0.5, 0.15)], 0],
      [[hand(0.5, 0.5, 0.15)], 100],
      [[hand(0.5, 0.5, 0.02)], 150],
      [[hand(0.5, 0.5, 0.15)], 300],
    ]);
    expect(intents.map((i) => i.type)).toEqual(["tap"]);
  });

  it("ignores half-closed pinches between the thresholds (no flicker)", () => {
    const e = pinchEngine();
    const intents = run(e, [
      [[hand(0.5, 0.5, 0.15)], 0],
      [[hand(0.5, 0.5, 0.02)], 50],
      [[hand(0.5, 0.5, 0.075)], 100], // ratio ≈ 0.375: still pinched
      [[hand(0.5, 0.5, 0.02)], 150],
      [[hand(0.5, 0.5, 0.15)], 200],
    ]);
    expect(intents.filter((i) => i.type === "tap")).toHaveLength(1);
  });

  it("pinch-drag pans instead of clicking", () => {
    const e = pinchEngine();
    const frames: [Hand[], number][] = [[[hand(0.5, 0.5, 0.15)], 0], [[hand(0.5, 0.5, 0.02)], 30]];
    for (let i = 1; i <= 15; i++) frames.push([[hand(0.5 + i * 0.02, 0.5, 0.02)], 30 + i * 30]);
    frames.push([[hand(0.8, 0.5, 0.15)], 600]);
    const intents = run(e, frames);
    expect(intents.some((i) => i.type === "pan")).toBe(true);
    expect(intents.some((i) => i.type === "tap")).toBe(false);
  });

  it("holding a pinch still zooms onto the target, without clicking it", () => {
    const e = pinchEngine();
    const frames: [Hand[], number][] = [[[hand(0.5, 0.5, 0.15)], 0]];
    for (let t = 30; t <= 1100; t += 30) frames.push([[hand(0.5, 0.5, 0.02)], t]);
    frames.push([[hand(0.5, 0.5, 0.15)], 1150]);
    expect(run(e, frames).map((i) => i.type)).toEqual(["focus"]);
  });

  it("two pinching hands moving apart zoom in", () => {
    const e = pinchEngine();
    const intents = run(e, [
      [[hand(0.4, 0.5, 0.02), hand(0.6, 0.5, 0.02)], 0],
      [[hand(0.35, 0.5, 0.02), hand(0.65, 0.5, 0.02)], 33],
    ]);
    const zoom = intents.find((i) => i.type === "zoom");
    expect(zoom && zoom.type === "zoom" && zoom.factor).toBeGreaterThan(1.4);
    expect(intents.some((i) => i.type === "tap")).toBe(false);
  });

  it("an open palm held still resets the zoom once", () => {
    const e = pinchEngine();
    const palm = hand(0.5, 0.5, 0.2, true);
    expect(isOpenPalm(palm)).toBe(true);
    const frames: [Hand[], number][] = [];
    for (let t = 0; t <= 1500; t += 50) frames.push([[palm], t]);
    expect(run(e, frames).map((i) => i.type)).toEqual(["reset"]);
  });

  it("losing the hand mid-pinch never fires a click", () => {
    const e = pinchEngine();
    const intents = run(e, [
      [[hand(0.5, 0.5, 0.02)], 0],
      [[], 100],
      [[], 400],
      [[hand(0.5, 0.5, 0.15)], 450],
    ]);
    expect(intents).toEqual([]);
  });
});

describe("two-hand tracking is armed only while pinching", () => {
  it("asks for a second hand during a board pinch, then lets it go", () => {
    const e = pinchEngine();
    e.update([hand(0.5, 0.5, 0.15)], 0);
    expect(e.wantsTwoHands).toBe(false); // just pointing: one hand is enough
    e.update([hand(0.5, 0.5, 0.02)], 50);
    expect(e.wantsTwoHands).toBe(true); // pinching: a zoom might start
    e.update([hand(0.5, 0.5, 0.15)], 100);
    e.update([hand(0.5, 0.5, 0.15)], 1000);
    expect(e.wantsTwoHands).toBe(true); // short grace to bring the other hand in
    e.update([hand(0.5, 0.5, 0.15)], 2000);
    expect(e.wantsTwoHands).toBe(false);
  });

  it("never in calls", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    e.update([hand(0.5, 0.5, 0.02)], 0);
    expect(e.wantsTwoHands).toBe(false);
  });

  it("a second hand arriving doesn't trigger zoom-onto-card", () => {
    const e = pinchEngine();
    const frames: [Hand[], number][] = [[[hand(0.4, 0.5, 0.15)], 0]];
    for (let t = 30; t <= 1500; t += 30)
      frames.push([[hand(0.4, 0.5, 0.02), hand(0.7, 0.5, 0.15)], t]);
    expect(run(e, frames).map((i) => i.type)).toEqual([]);
  });
});

describe("dialog mode (calls and popups)", () => {
  it("press/release bracket a pinch, for hold-to-talk", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const types: string[] = [];
    for (const [hands, t] of [
      [[hand(0.5, 0.5, 0.15)], 0],
      [[hand(0.5, 0.5, 0.02)], 50],
      [[hand(0.5, 0.5, 0.02)], 2000],
      [[hand(0.5, 0.5, 0.15)], 2050],
    ] as [Hand[], number][])
      types.push(...e.update(hands, t).map((i) => i.type));
    // A long hold in a dialog is not a zoom. (It still reports a tap; the
    // overlay ignores taps on hold-to-talk buttons like the mic.)
    expect(types).toEqual(["press", "tap", "release"]);
  });

  it("losing the hand while holding still releases (the mic stops)", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const types: string[] = [];
    for (const [hands, t] of [
      [[hand(0.5, 0.5, 0.15)], 0],
      [[hand(0.5, 0.5, 0.02)], 30],
      [[], 100],
      [[], 400],
    ] as [Hand[], number][])
      types.push(...e.update(hands, t).map((i) => i.type));
    expect(types).toEqual(["press", "release"]);
  });

  it("a slow pinch still clicks in a dialog", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const frames: [Hand[], number][] = [[[hand(0.5, 0.5, 0.15)], 0]];
    for (let t = 30; t <= 1200; t += 30) frames.push([[hand(0.5, 0.5, 0.02)], t]);
    frames.push([[hand(0.5, 0.5, 0.15)], 1250]);
    expect(run(e, frames).map((i) => i.type)).toEqual(["tap"]);
  });

  it("an open palm held still hangs up, once", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const palm = hand(0.5, 0.5, 0.2, true);
    const frames: [Hand[], number][] = [];
    for (let t = 0; t <= 2000; t += 50) frames.push([[palm], t]);
    expect(run(e, frames).map((i) => i.type)).toEqual(["close"]);
  });

  it("moving an open hand around (pointing) never hangs up", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const frames: [Hand[], number][] = [];
    for (let i = 0; i <= 60; i++)
      frames.push([[hand(0.3 + (i % 20) * 0.02, 0.5, 0.2, true)], i * 50]);
    expect(run(e, frames)).toEqual([]);
  });

  it("a fist talks while held, like holding Space", () => {
    const e = pinchEngine();
    e.mode = "dialog";
    const frames: [Hand[], number][] = [[[hand(0.5, 0.5, 0.15)], 0]];
    for (let t = 50; t <= 1500; t += 50) frames.push([[fist(0.5, 0.5)], t]);
    frames.push([[hand(0.5, 0.5, 0.15)], 1550]);
    frames.push([[hand(0.5, 0.5, 0.15)], 1800]);
    const types = run(e, frames).map((i) => i.type);
    // No click on the way in or out of the fist.
    expect(types).toEqual(["talkStart", "talkEnd"]);
  });

  it("a fist does nothing on the board (🤙 is the board's talk sign)", () => {
    const e = pinchEngine();
    const frames: [Hand[], number][] = [];
    for (let t = 0; t <= 1000; t += 50) frames.push([[fist(0.5, 0.5)], t]);
    expect(run(e, frames).filter((i) => i.type.startsWith("talk"))).toEqual([]);
  });

  it("tells fists, pinches and open palms apart", () => {
    expect(isFist(fist(0.5, 0.5))).toBe(true);
    expect(isFist(hand(0.5, 0.5, 0.02))).toBe(false); // pinch, other fingers curled
    expect(isFist(hand(0.5, 0.5, 0.2, true))).toBe(false);
    expect(isOpenPalm(fist(0.5, 0.5))).toBe(false);
  });
});

describe("point and shoot (optional click)", () => {
  it("thumb down onto the index finger clicks", () => {
    const e = new GestureEngine();
    e.clickStyle = "thumb";
    const intents = run(e, [
      [[gun(0.5, 0.5, false)], 0],
      [[gun(0.5, 0.5, false)], 100],
      [[gun(0.5, 0.5, true)], 150],
      [[gun(0.5, 0.5, false)], 300],
    ]);
    expect(intents.map((i) => i.type)).toEqual(["tap"]);
  });

  it("the cursor stays put while the thumb clicks", () => {
    const e = new GestureEngine();
    e.clickStyle = "thumb";
    const map = (p: { x: number; y: number }) => ({ x: p.x * 1000, y: p.y * 600 });
    for (let t = 0; t <= 300; t += 30) e.update([gun(0.5, 0.5, false)], t, map);
    const before = { ...e.state.at };
    e.update([gun(0.5, 0.5, true)], 330, map);
    expect(Math.hypot(e.state.at.x - before.x, e.state.at.y - before.y)).toBeLessThan(1);
  });

  it("a hand that appears with the thumb already down doesn't click", () => {
    const e = new GestureEngine();
    e.clickStyle = "thumb";
    const intents = run(e, [
      [[gun(0.5, 0.5, true)], 0],
      [[gun(0.5, 0.5, true)], 100],
      [[gun(0.5, 0.5, false)], 200],
    ]);
    expect(intents).toEqual([]);
  });

  it("a finger gun is neither a fist nor an open palm", () => {
    expect(isFist(gun(0.5, 0.5, false))).toBe(false);
    expect(isFist(gun(0.5, 0.5, true))).toBe(false);
    expect(isOpenPalm(gun(0.5, 0.5, false))).toBe(false);
  });
});

/** Synthetic peace sign: index + middle up, ring + pinky curled. */
function peace(cx: number, cy: number): Hand {
  const pts = gun(cx, cy, false);
  pts[10] = { x: cx - 0.01, y: cy - 0.06 };
  pts[12] = { x: cx - 0.01, y: cy - 0.14 };
  return pts;
}

describe("peace sign held 1 s (default click)", () => {
  const map = (p: { x: number; y: number }) => ({ x: p.x * 1000, y: p.y * 600 });
  const frames = (make: (t: number) => Hand, from: number, to: number) => {
    const f: [Hand[], number][] = [];
    for (let t = from; t <= to; t += 30) f.push([[make(t)], t]);
    return f;
  };
  const types = (e: GestureEngine, f: [Hand[], number][]) =>
    f.flatMap(([h, t]) => e.update(h, t, map)).map((i) => i.type);

  it("clicks once after a 1 s hold, with the ring filling", () => {
    const e = new GestureEngine();
    expect(types(e, frames(() => gun(0.5, 0.5, false), 0, 300))).toEqual([]);
    expect(types(e, frames(() => peace(0.5, 0.5), 330, 1200))).toEqual([]);
    expect(e.state.holdKind).toBe("click");
    expect(e.state.hold).toBeGreaterThan(0.8);
    expect(types(e, frames(() => peace(0.5, 0.5), 1230, 3000))).toEqual(["tap"]);
  });

  it("dropping the sign early cancels; making it again clicks again", () => {
    const e = new GestureEngine();
    const f = [
      ...frames(() => peace(0.5, 0.5), 0, 600),
      ...frames(() => gun(0.5, 0.5, false), 630, 1200),
      ...frames(() => peace(0.5, 0.5), 1230, 2400),
      ...frames(() => gun(0.5, 0.5, false), 2430, 2700),
      ...frames(() => peace(0.5, 0.5), 2730, 3900),
    ];
    expect(types(e, f)).toEqual(["tap", "tap"]);
  });

  it("drifting across the screen restarts the count (no stray clicks)", () => {
    const e = new GestureEngine();
    expect(types(e, frames((t) => peace(0.3 + t / 4000, 0.5), 0, 1500))).toEqual([]);
  });

  it("the cursor follows the knuckles, so changing finger shape doesn't move it", () => {
    const e = new GestureEngine();
    types(e, frames(() => gun(0.5, 0.5, false), 0, 300));
    const before = { ...e.state.at };
    types(e, frames(() => peace(0.5, 0.5), 330, 400));
    expect(Math.hypot(e.state.at.x - before.x, e.state.at.y - before.y)).toBeLessThan(1);
  });

  it("is told apart from fists, open palms and pointing", () => {
    expect(isPeace(peace(0.5, 0.5))).toBe(true);
    expect(isPeace(gun(0.5, 0.5, false))).toBe(false);
    expect(isPeace(hand(0.5, 0.5, 0.2, true))).toBe(false);
    expect(isPeace(fist(0.5, 0.5))).toBe(false);
    expect(isFist(peace(0.5, 0.5))).toBe(false);
    expect(isOpenPalm(peace(0.5, 0.5))).toBe(false);
  });
});

/** Synthetic 🤙: thumb and pinky out, index/middle/ring curled. */
function shaka(cx: number, cy: number): Hand {
  const pts = fist(cx, cy);
  pts[18] = { x: cx + 0.06, y: cy - 0.02 };
  pts[20] = { x: cx + 0.1, y: cy - 0.08 };
  pts[4] = { x: cx - 0.14, y: cy - 0.04 };
  return pts;
}

describe("🤙 = hold to talk", () => {
  it("is recognised, and not confused with other signs", () => {
    expect(isShaka(shaka(0.5, 0.5))).toBe(true);
    expect(isShaka(fist(0.5, 0.5))).toBe(false);
    expect(isShaka(peace(0.5, 0.5))).toBe(false);
    expect(isShaka(hand(0.5, 0.5, 0.2, true))).toBe(false);
    expect(isPeace(shaka(0.5, 0.5))).toBe(false);
    expect(isOpenPalm(shaka(0.5, 0.5))).toBe(false);
  });

  it("talks while held on the board (voice commands), stops when dropped", () => {
    const e = new GestureEngine();
    const f: [Hand[], number][] = [[[gun(0.5, 0.5, false)], 0]];
    for (let t = 50; t <= 1500; t += 50) f.push([[shaka(0.5, 0.5)], t]);
    for (let t = 1550; t <= 2000; t += 50) f.push([[gun(0.5, 0.5, false)], t]);
    expect(run(e, f).map((i) => i.type)).toEqual(["talkStart", "talkEnd"]);
  });

  it("also talks in calls", () => {
    const e = new GestureEngine();
    e.mode = "dialog";
    const f: [Hand[], number][] = [];
    for (let t = 0; t <= 800; t += 50) f.push([[shaka(0.5, 0.5)], t]);
    expect(run(e, f).map((i) => i.type)).toEqual(["talkStart"]);
  });
});

describe("one euro filter", () => {
  it("smooths jitter on a still hand", () => {
    const f = new OneEuro();
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      const v = f.filter(100 + (i % 2 ? 3 : -3), i * 16);
      if (i > 10) maxDev = Math.max(maxDev, Math.abs(v - 100));
    }
    expect(maxDev).toBeLessThan(1.5);
  });
});
