import { useEffect, useState, type RefObject } from "react";
import { motion } from "framer-motion";
import type { Link } from "./types";
type Thread = { key: string; d: string; x: number; y: number; label: string };
export default function BoardStrings({
  board,
  links,
}: {
  board: RefObject<HTMLDivElement | null>;
  links: Link[];
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  useEffect(() => {
    const root = board.current;
    if (!root) return;
    function measure() {
      const bounds = root!.getBoundingClientRect();
      function pin(id: string) {
        const card = root!.querySelector(
          `[data-suspect-id="${id}"], [data-evidence-id="${id}"]`,
        );
        const node = card?.querySelector(".pin") ?? card;
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: ((rect.left + rect.width / 2 - bounds.left) / bounds.width) * 1000,
          y:
            ((rect.top + Math.min(rect.height / 2, 8) - bounds.top) /
              bounds.height) *
            800,
        };
      }
      setThreads(
        links.flatMap((link) => {
          const a = pin(link.from),
            b = pin(link.to);
          if (!a || !b) return [];
          const x = (a.x + b.x) / 2,
            y = (a.y + b.y) / 2 + 55;
          return [
            {
              key: `${link.from}-${link.to}`,
              d: `M ${a.x} ${a.y} Q ${x} ${y + 70} ${b.x} ${b.y}`,
              x,
              y,
              label: link.label,
            },
          ];
        }),
      );
    }
    measure();
    // Follow the document's entrance animation, then stop measuring each frame.
    let frame = 0;
    const settleUntil = performance.now() + 1400;
    function settle() {
      measure();
      if (performance.now() < settleUntil)
        frame = requestAnimationFrame(settle);
    }
    frame = requestAnimationFrame(settle);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [board, links]);
  return (
    <>
      <svg
        className="string-layer"
        viewBox="0 0 1000 800"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {threads.map((thread) => (
          <motion.path
            key={thread.key}
            d={thread.d}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.1 }}
          />
        ))}
      </svg>
      {/* Labels are real text over the board (not inside the stretched SVG,
          which squashed them), so they stay crisp and readable. */}
      <div className="thread-labels">
        {threads.map((thread) => (
          <motion.span
            key={thread.key}
            className="thread-label"
            style={{
              left: `${thread.x / 10}%`,
              top: `${thread.y / 8}%`,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
          >
            {thread.label}
          </motion.span>
        ))}
      </div>
    </>
  );
}
