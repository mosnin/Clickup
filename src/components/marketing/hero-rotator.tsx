"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// The living hero line: the operate logo mark on a warm tile (it flips on
// each change), beside a use-case word that rewrites — "engineering" →
// "support" → "marketing" → "research" → "operations".
//
// Layout stability is the whole design: this renders as its OWN block line
// (see hero.tsx), and the word sits in a width-animated slot, so a longer
// or shorter word can never re-wrap the headline — the only thing that
// moves is the slot gliding around its own center. Reduced-motion pins the
// first case, no cycling.

const WORDS = [
  "engineering",
  "support",
  "marketing",
  "research",
  "operations",
] as const;

const CYCLE_MS = 3400;

export function HeroRotator() {
  const [i, setI] = useState(0);
  const wordRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((v) => (v + 1) % WORDS.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  // Measure the incoming word so the slot tweens its width to fit — the
  // icon and everything around glide instead of snapping.
  useLayoutEffect(() => {
    if (wordRef.current) setWidth(wordRef.current.offsetWidth);
  }, [i]);

  return (
    <span className="inline-flex items-center gap-[0.26em] whitespace-nowrap align-baseline">
      <span
        key={`tile-${i}`}
        aria-hidden
        className="hero-flip inline-flex size-[0.92em] shrink-0 items-center justify-center self-center rounded-[0.24em] mk-gradient-fill ring-1 ring-white/25"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/operate-icon-white.svg"
          alt=""
          className="h-[52%] w-[52%]"
        />
      </span>
      <span
        className="inline-block overflow-hidden transition-[width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width }}
      >
        <span
          key={`word-${i}`}
          ref={wordRef}
          className="hero-retype text-gradient inline-block whitespace-nowrap"
        >
          {WORDS[i]}
        </span>
      </span>
    </span>
  );
}
