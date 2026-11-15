// One Euro filter (Casiez et al., 2012): strong smoothing when the hand is
// still (kills jitter), light smoothing when it moves fast (kills lag).
export class OneEuro {
  private prev: number | null = null;
  private dPrev = 0;
  private tPrev = 0;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, tMs: number) {
    if (this.prev === null) {
      this.prev = value;
      this.tPrev = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;
    const d = (value - this.prev) / dt;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dPrev = ad * d + (1 - ad) * this.dPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dPrev);
    const a = OneEuro.alpha(cutoff, dt);
    this.prev = a * value + (1 - a) * this.prev;
    return this.prev;
  }

  reset() {
    this.prev = null;
    this.dPrev = 0;
  }
}

export class OneEuro2D {
  private x: OneEuro;
  private y: OneEuro;
  constructor(minCutoff?: number, beta?: number) {
    this.x = new OneEuro(minCutoff, beta);
    this.y = new OneEuro(minCutoff, beta);
  }
  filter(p: { x: number; y: number }, tMs: number) {
    return { x: this.x.filter(p.x, tMs), y: this.y.filter(p.y, tMs) };
  }
  reset() {
    this.x.reset();
    this.y.reset();
  }
}
