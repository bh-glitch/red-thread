// One zoom/pan "camera" for the board, shared by keyboard, mouse/trackpad and
// hand gestures. Every input edits a target view; springs make all of them feel
// the same.
import { useCallback, useEffect, useRef } from "react";
import { useSpring } from "framer-motion";
import {
  HOME,
  clampView,
  focusOn,
  panBy,
  zoomAt,
  type Size,
  type View,
} from "./camera";

const SPRING = { stiffness: 320, damping: 34, mass: 0.6 };

export function useBoardCamera(el: HTMLElement | null, enabled: boolean) {
  const viewport = useRef(el);
  viewport.current = el;
  const view = useRef<View>(HOME);
  const x = useSpring(0, SPRING);
  const y = useSpring(0, SPRING);
  const scale = useSpring(1, SPRING);

  const size = useCallback((): Size => {
    const node = viewport.current;
    return { w: node?.clientWidth ?? 1, h: node?.clientHeight ?? 1 };
  }, []);

  const set = useCallback(
    (next: View) => {
      view.current = next;
      x.set(next.x);
      y.set(next.y);
      scale.set(next.scale);
    },
    [x, y, scale],
  );

  const api = useRef({
    zoomAt: (factor: number, px: number, py: number) =>
      set(zoomAt(view.current, factor, px, py, size())),
    zoomCenter: (factor: number) => {
      const s = size();
      set(zoomAt(view.current, factor, s.w / 2, s.h / 2, s));
    },
    panBy: (dx: number, dy: number) => set(panBy(view.current, dx, dy, size())),
    /** Zoom onto an element inside the board. */
    focus: (el: Element) => {
      const root = viewport.current;
      if (!root) return;
      const b = root.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const left = b.left + root.clientLeft,
        top = b.top + root.clientTop;
      set(
        focusOn(
          view.current,
          { left: r.left - left, top: r.top - top, width: r.width, height: r.height },
          size(),
        ),
      );
    },
    reset: () => set(HOME),
    get zoomed() {
      return view.current.scale > 1.01;
    },
  });

  // Keep the view valid when the board is resized (window, "Expand board").
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => {
      set(clampView(view.current, size()));
      // Short windows: shrink the pinned cards so they fit the board's height
      // (the layout is designed for ~590px of board; never below 55%).
      const fit = Math.min(1, Math.max(0.55, el.clientHeight / 590));
      el.style.setProperty("--board-fit", fit.toFixed(3));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, set, size]);

  // Keyboard: + / - zoom, 0 resets, arrows pan while zoomed in.
  useEffect(() => {
    if (!enabled) return;
    function key(event: KeyboardEvent) {
      const t = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        t?.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      const a = api.current;
      const step = 90;
      const actions: Record<string, () => void> = {
        "+": () => a.zoomCenter(1.25),
        "=": () => a.zoomCenter(1.25),
        "-": () => a.zoomCenter(0.8),
        _: () => a.zoomCenter(0.8),
        "0": () => a.reset(),
        ArrowLeft: () => a.panBy(step, 0),
        ArrowRight: () => a.panBy(-step, 0),
        ArrowUp: () => a.panBy(0, step),
        ArrowDown: () => a.panBy(0, -step),
      };
      const action = actions[event.key];
      if (!action) return;
      if (event.key.startsWith("Arrow") && !a.zoomed) return;
      event.preventDefault();
      action();
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);

  // Trackpad pinch / ctrl+wheel zooms at the pointer; plain wheel pans while
  // zoomed. At normal size the wheel scrolls the page as before.
  useEffect(() => {
    if (!el || !enabled) return;
    function wheel(event: WheelEvent) {
      const a = api.current;
      const b = el!.getBoundingClientRect();
      if (event.ctrlKey) {
        event.preventDefault();
        a.zoomAt(
          Math.exp(-event.deltaY * 0.01),
          event.clientX - b.left - el!.clientLeft,
          event.clientY - b.top - el!.clientTop,
        );
      } else if (a.zoomed) {
        event.preventDefault();
        a.panBy(-event.deltaX, -event.deltaY);
      }
    }
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [el, enabled]);

  // Mouse drag on empty cork pans while zoomed (buttons still click normally).
  useEffect(() => {
    if (!el || !enabled) return;
    let drag: { x: number; y: number; id: number } | null = null;
    function down(event: PointerEvent) {
      if (!api.current.zoomed || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
      el!.setPointerCapture(event.pointerId);
      el!.classList.add("board-dragging");
    }
    function move(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      api.current.panBy(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
    }
    function up(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      el!.classList.remove("board-dragging");
    }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [el, enabled]);

  return { x, y, scale, api: api.current };
}

export type BoardCamera = ReturnType<typeof useBoardCamera>;
