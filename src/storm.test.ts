import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStorm } from "./storm";

describe("storm ambience lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("strikes every seven seconds, then fades before the delayed thunder", () => {
    const flash = vi.fn();
    const rumble = vi.fn();
    const stop = startStorm(flash, rumble);
    vi.advanceTimersByTime(6999);
    expect(flash).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flash).toHaveBeenLastCalledWith(true);
    expect(rumble).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(flash).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1020);
    expect(rumble).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5800);
    expect(flash).toHaveBeenLastCalledWith(true);
    stop();
  });

  it("cancels pending thunder when a call, hidden tab or mute interrupts", () => {
    const flash = vi.fn();
    const rumble = vi.fn();
    const stop = startStorm(flash, rumble);
    vi.advanceTimersByTime(7300);
    stop();
    vi.advanceTimersByTime(60000);
    expect(rumble).not.toHaveBeenCalled();
    expect(flash).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a playing rumble and releases every timer on disposal", () => {
    const silence = vi.fn();
    const stop = startStorm(vi.fn(), () => silence);
    vi.advanceTimersByTime(8200);
    stop();
    expect(silence).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps light cues working when audio is muted or unavailable", () => {
    const flash = vi.fn();
    const stop = startStorm(flash, () => undefined);
    vi.advanceTimersByTime(15000);
    expect(flash.mock.calls.filter(([visible]) => visible)).toHaveLength(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
