import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronLeft, ChevronRight, Fingerprint } from "lucide-react";
import type { CaseData } from "./types";

export default function OpeningLetter({
  data,
  onConfirm,
  onSwitchCase,
  switching = false,
  direction = 1,
}: {
  data: CaseData;
  onConfirm: () => void;
  /** Flip to another case (game mode). */
  onSwitchCase?: (caseId: string, direction: 1 | -1) => void;
  switching?: boolean;
  direction?: 1 | -1;
}) {
  const letter = data.opening_letter;
  const cases = data.cases ?? [];
  const index = Math.max(0, cases.findIndex((c) => c.id === data.id));
  const go = (step: 1 | -1) => {
    if (!onSwitchCase || cases.length < 2 || switching) return;
    const next = cases[(index + step + cases.length) % cases.length];
    onSwitchCase(next.id, step);
  };
  // Arrow keys flip between cases too.
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <main className="letter-room" aria-labelledby="letter-heading">
      <div className="letter-brand" aria-label="Red Thread">
        <Fingerprint size={40} strokeWidth={1.1} aria-hidden="true" />
        <span className="brand-name letter-brand-name">
          <span className="brand-red">Red</span> Thread
          <svg className="brand-thread" viewBox="0 0 120 10" aria-hidden="true">
            <path d="M2 6 C 20 1, 34 9, 52 5 S 86 1, 100 6 S 114 8, 118 4" />
          </svg>
        </span>
      </div>
      {cases.length > 1 && (
        <>
          <button
            className="case-arrow case-arrow-left"
            onClick={() => go(-1)}
            disabled={switching}
            aria-label="Previous case"
          >
            <ChevronLeft size={34} strokeWidth={1.4} />
          </button>
          <button
            className="case-arrow case-arrow-right"
            onClick={() => go(1)}
            disabled={switching}
            aria-label="Next case"
          >
            <ChevronRight size={34} strokeWidth={1.4} />
            <span>Next case</span>
          </button>
        </>
      )}
      <AnimatePresence mode="wait" custom={direction}>
      <motion.article
        key={data.id}
        className="opening-letter"
        initial={{ opacity: 0, x: 60 * direction, rotate: 1.5 * direction }}
        animate={{ opacity: 1, x: 0, rotate: 0 }}
        exit={{ opacity: 0, x: -60 * direction, rotate: -1.5 * direction }}
        transition={{ duration: 0.35 }}
      >
        <header className="letter-meta">
          <span>PRIVATE CORRESPONDENCE</span>
          <span>CASE {data.number}</span>
        </header>
        <div className="letter-address">
          <span>{data.victim_business.name}</span>
          <time>{data.date}</time>
        </div>
        <h1 id="letter-heading">{letter.subject}</h1>
        <div className="letter-body">
          <p>Detective,</p>
          {letter.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        <footer className="letter-footer">
          <div className="letter-signature">
            <span>{letter.sender}</span>
            <small>{letter.role}</small>
          </div>
          <button className="letter-confirm" onClick={onConfirm}>
            Confirm &amp; continue <ArrowRight size={17} aria-hidden="true" />
          </button>
        </footer>
      </motion.article>
      </AnimatePresence>
      <div className="letter-case-switch">
        <span className="letter-case-title">{data.title}</span>
        {cases.length > 1 && (
          <span className="case-dots" aria-label={`Case ${index + 1} of ${cases.length}`}>
            {cases.map((c, i) => (
              <button
                key={c.id}
                className={i === index ? "active" : ""}
                onClick={() => i !== index && onSwitchCase?.(c.id, i > index ? 1 : -1)}
                aria-label={`Case ${c.number}: ${c.title}`}
              />
            ))}
            <em>
              CASE {index + 1} / {cases.length}
            </em>
          </span>
        )}
      </div>
    </main>
  );
}
