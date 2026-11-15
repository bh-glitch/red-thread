// Pure zoom/pan math for the investigation board. The board content is drawn
// with `translate(x, y) scale(scale)` and transform-origin 0 0, so a board point
// p appears on screen at x + p * scale (relative to the board's top-left).
export type View = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };

export const MIN_SCALE = 1;
export const MAX_SCALE = 3;
export const HOME: View = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the board covering its frame: no empty cork showing at the edges. */
export function clampView(view: View, size: Size): View {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  return {
    scale,
    x: clamp(view.x, size.w - size.w * scale, 0),
    y: clamp(view.y, size.h - size.h * scale, 0),
  };
}

/** Zoom by `factor`, keeping the screen point (px, py) fixed under the finger. */
export function zoomAt(
  view: View,
  factor: number,
  px: number,
  py: number,
  size: Size,
): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / view.scale;
  return clampView(
    { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k },
    size,
  );
}

export function panBy(view: View, dx: number, dy: number, size: Size): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, size);
}

/**
 * Centre a target (given in current screen coordinates relative to the board)
 * and zoom so it fills about 70% of the frame height.
 */
export function focusOn(
  view: View,
  target: { left: number; top: number; width: number; height: number },
  size: Size,
): View {
  // Convert the target back to unscaled board coordinates.
  const bx = (target.left + target.width / 2 - view.x) / view.scale;
  const by = (target.top + target.height / 2 - view.y) / view.scale;
  const bh = target.height / view.scale;
  const bw = target.width / view.scale;
  const scale = clamp(
    Math.min((size.h * 0.7) / bh, (size.w * 0.5) / bw),
    MIN_SCALE,
    MAX_SCALE,
  );
  return clampView(
    { scale, x: size.w / 2 - bx * scale, y: size.h / 2 - by * scale },
    size,
  );
}
