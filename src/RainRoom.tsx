import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { thunder } from "./audio";
import { useGame } from "./store";
import { startStorm } from "./storm";

const DROPS = [
  { left: "9%", animationDuration: "31s", animationDelay: "-16s" },
  { left: "23%", animationDuration: "39s", animationDelay: "-3s" },
  { left: "42%", animationDuration: "34s", animationDelay: "-24s" },
  { left: "61%", animationDuration: "43s", animationDelay: "-11s" },
  { left: "79%", animationDuration: "36s", animationDelay: "-29s" },
  { left: "92%", animationDuration: "46s", animationDelay: "-8s" },
];

/** One still photograph and six tiny glass trails; no animation frame loop. */
const RainRoom = memo(function RainRoom({ paused }: { paused: boolean }) {
  const muted = useGame((state) => state.muted);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [flashing, setFlashing] = useState(false);
  const lastRegion = useRef(2);
  const [strike, setStrike] = useState({ x: 76, angle: 0, flip: 1, height: 80, width: 30, brightness: .7 });
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  useEffect(() => {
    if (paused || hidden) return;
    return startStorm((visible) => {
      if (visible) {
        // Pick a different third of the window each time, including after calls.
        const region = (lastRegion.current + 1 + Math.floor(Math.random() * 2)) % 3;
        lastRegion.current = region;
        setStrike({
          x: [17, 49, 81][region] + Math.random() * 8 - 4,
          angle: Math.random() * 14 - 7,
          flip: Math.random() < .5 ? -1 : 1,
          height: 68 + Math.random() * 20,
          width: 25 + Math.random() * 8,
          brightness: .66 + Math.random() * .12,
        });
      }
      setFlashing(visible);
    }, () => muted ? undefined : thunder());
  }, [paused, hidden, muted]);

  return (
    <div className={`rain-room${paused || hidden ? " is-paused" : ""}`} aria-hidden="true">
      <div className="rain-window">
        <img className="rain-photo" src="/scenes/pocono-rain-window.jpg" alt="" decoding="async" />
        <div className="rain-trails">
          {DROPS.map((style) => <i className="rain-drop" key={style.left} style={style} />)}
        </div>
        <div
          className={`rain-lightning${flashing ? " is-visible" : ""}`}
          style={{
            "--bolt-x": `${strike.x}%`,
            "--bolt-angle": `${strike.angle}deg`,
            "--bolt-flip": strike.flip,
            "--bolt-height": `${strike.height}%`,
            "--bolt-width": `${strike.width}%`,
            "--bolt-brightness": strike.brightness,
          } as CSSProperties}
        >
          <svg className="rain-bolt" viewBox="0 0 420 600" fill="none" preserveAspectRatio="xMidYMin meet">
            <defs>
              <path id="pocono-lightning-bolt" d="M239-10 224 27 234 43 207 78 219 91 187 134 198 151 170 188 184 205 153 249 167 267 136 311 148 327 117 377 131 389 99 443 112 459 78 519 89 531 54 595" />
              <path id="pocono-lightning-branches" d="m207 78 43 22 14 35 32 17 5 30 27 23m-130-54 39 23 5 29 26 16 13 37m-111-68-36 20-8 34-32 22-7 26m65 39 38 16 10 30 27 22 4 31m-78 32-33 11-14 27-25 13" />
            </defs>
            {/* Layered strokes provide a soft halo without an animated blur. */}
            <g stroke="#bdd4ef" strokeLinecap="round" strokeLinejoin="round">
              <use href="#pocono-lightning-bolt" strokeWidth="22" opacity=".04" />
              <use href="#pocono-lightning-bolt" strokeWidth="10" opacity=".12" />
              <use href="#pocono-lightning-bolt" strokeWidth="4" opacity=".45" />
              <use href="#pocono-lightning-branches" strokeWidth="5" opacity=".13" />
              <use href="#pocono-lightning-branches" strokeWidth="1" opacity=".6" />
            </g>
            <use href="#pocono-lightning-bolt" stroke="#f2f6ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div className="rain-sill" />
      <div className="rain-desk" />
    </div>
  );
});

export default RainRoom;
