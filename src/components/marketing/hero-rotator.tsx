"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Code2, Headset, Megaphone, FlaskConical, Workflow } from "lucide-react";

// The living use-case rotator that replaces the static hero glyph: a small
// icon tile flips to a new use case while the word beside it rewrites, so
// the headline reads "your AI [icon] engineering workforce." then cycles
// through support, marketing, research, operations — the product explaining
// itself. The word slot animates its width so "workforce" glides rather than
// jumps. Reduced-motion pins it to the first case, no cycling.

const CASES = [
  { word: "engineering", Icon: Code2 },
  { word: "support", Icon: Headset },
  { word: "marketing", Icon: Megaphone },
  { word: "research", Icon: FlaskConical },
  { word: "operations", Icon: Workflow },
] as const;

export function HeroRotator() {
  const [i, setI] = useState(0);
  const wordRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((v) => (v + 1) % CASES.length), 3000);
    return () => clearInterval(id);
  }, []);

  // Measure the new word after it renders so the slot can transition its
  // width to fit — no layout jump for the text that follows.
  useLayoutEffect(() => {
    if (wordRef.current) setWidth(wordRef.current.offsetWidth);
  }, [i]);

  const { word, Icon } = CASES[i];

  return (
    <span className="inline-flex items-center gap-[0.28em] align-middle">
      <span
        key={`icon-${i}`}
        aria-hidden
        className="hero-flip inline-flex size-[0.92em] items-center justify-center rounded-[0.24em] mk-gradient-fill ring-1 ring-white/25"
      >
        <Icon className="size-[0.5em] text-white" strokeWidth={2.6} />
      </span>
      <span
        className="inline-block overflow-hidden align-bottom transition-[width] duration-300 ease-out"
        style={{ width }}
      >
        <span
          key={`word-${i}`}
          ref={wordRef}
          className="hero-retype text-gradient inline-block whitespace-nowrap"
        >
          {word}
        </span>
      </span>
    </span>
  );
}
