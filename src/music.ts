// Background music: the thriller/tension track, looped at 30% volume. It starts
// when the player clicks "Open case file" (a click, so browsers allow sound; if
// one still refuses, it starts on the next click or key press). The game's mute
// button silences it too.
import { useGame } from "./store";

const SRC = "/audio/thriller-tension.mp3";
export const MUSIC_VOLUME = 0.3;

let track: HTMLAudioElement | null = null;
let started = false;

function player() {
  if (!track) {
    track = new Audio(SRC);
    track.loop = true;
    track.preload = "auto";
    track.volume = MUSIC_VOLUME;
  }
  return track;
}

function play() {
  if (useGame.getState().muted) return Promise.resolve(false);
  return player()
    .play()
    .then(() => true)
    .catch(() => false);
}

/** Start the music now, or on the first interaction if the browser blocks autoplay. */
export function startMusic() {
  if (started) return;
  started = true;
  void play().then((ok) => {
    if (ok) return;
    const unlock = () => {
      void play().then((played) => {
        if (!played && !useGame.getState().muted) return; // keep waiting
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      });
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  });

  // Follow the game's mute button.
  useGame.subscribe((state, previous) => {
    if (state.muted === previous.muted) return;
    if (state.muted) player().pause();
    else void play();
  });
}
