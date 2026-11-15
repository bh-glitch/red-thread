// "How to play with your hands" — shown when hand control is switched on, and
// from the "Hand guide" button under the board.
import { ArrowRight } from "lucide-react";

const GESTURES: { sign: string; name: string; how: string }[] = [
  {
    sign: "👋",
    name: "Move the cursor",
    how: "Hold one hand up, palm toward the screen, about an arm’s length away. The glowing dot follows your knuckles.",
  },
  {
    sign: "✌️",
    name: "Click — hold a peace sign for 1 second",
    how: "Point the dot at a photo, question or button (it gets a gold outline), then raise your index and middle fingers. A ring fills; when it’s full, it clicks. Drop the sign to click again.",
  },
  {
    sign: "🤏",
    name: "Move around the board",
    how: "Pinch thumb and index finger together, then drag.",
  },
  {
    sign: "🔍",
    name: "Zoom onto a person",
    how: "Pinch over their photo and hold still for 1 second. Or pinch with both hands and pull them apart (together to zoom out).",
  },
  {
    sign: "✋",
    name: "Zoom out · Hang up",
    how: "Hold an open palm still for 1 second. On the board it zooms back out; in a call or popup it hangs up / closes.",
  },
  {
    sign: "🤙",
    name: "Talk — hold the “call me” sign",
    how: "Thumb and pinky out, other fingers curled. Hold it and speak, like holding Space; drop it to send. On the board it takes voice commands (“call Sam”, “give me a hint”); in a call it asks your question. (A fist also talks in calls.)",
  },
];

export default function HandGuide({
  onDone,
  hideNextTime,
  setHideNextTime,
}: {
  onDone: () => void;
  hideNextTime: boolean;
  setHideNextTime: (hide: boolean) => void;
}) {
  return (
    <>
      <span className="eyebrow">HAND CONTROL</span>
      <h2>Play with your hands.</h2>
      <p>Your camera reads your hand right here in the browser. Mouse and keyboard keep working too.</p>
      <ul className="hand-guide-list">
        {GESTURES.map((g) => (
          <li key={g.name}>
            <span className="hand-guide-sign" aria-hidden="true">
              {g.sign}
            </span>
            <div>
              <strong>{g.name}</strong>
              <p>{g.how}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="hand-guide-tip">
        Tip: good light in front of you helps, and keep your hand inside the little camera preview in the corner.
      </p>
      <div className="hand-guide-actions">
        <label>
          <input
            type="checkbox"
            checked={hideNextTime}
            onChange={(event) => setHideNextTime(event.target.checked)}
          />
          Don’t show this when I turn hand control on
        </label>
        <button className="primary" onClick={onDone}>
          Got it — start <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
