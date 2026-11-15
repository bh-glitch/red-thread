/** Infrequent weather cues. Disposing cancels even a delayed thunderclap. */
export function startStorm(
  flash: (visible: boolean) => void,
  rumble: () => (() => void) | undefined,
) {
  let fade: ReturnType<typeof setTimeout> | undefined;
  let delayedRumble: ReturnType<typeof setTimeout> | undefined;
  let stopRumble: (() => void) | undefined;
  const interval = setInterval(() => {
    flash(true);
    fade = setTimeout(() => flash(false), 180);
    delayedRumble = setTimeout(() => {
      stopRumble?.();
      stopRumble = rumble();
    }, 1200);
  }, 7000);

  return () => {
    clearInterval(interval);
    clearTimeout(fade);
    clearTimeout(delayedRumble);
    stopRumble?.();
    flash(false);
  };
}
