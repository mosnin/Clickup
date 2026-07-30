"use client";

import { useEffect, useRef } from "react";
import { scrambleTo } from "@/lib/anime";

// A number that visibly *becomes* its new value.
//
// For values that change because something happened — an agent completed a
// task, a rollup moved under you. A number that silently swaps is a number
// nobody notices changed; a fifth of a second of digits resolving is the
// smallest way to say "this is new", and it reads as the value settling
// rather than as an effect applied on top of it.
//
// First render writes the value directly: a page should not perform its own
// arrival, only its changes.

export function LiveNumber({
  value,
  className,
}: {
  value: string | number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const last = useRef<string | null>(null);
  const text = String(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (last.current === null || last.current === text) {
      el.textContent = text;
    } else {
      scrambleTo(el, text);
    }
    last.current = text;
  }, [text]);

  // The value is rendered as initial content too, so nothing flashes empty
  // before the effect runs and SSR output carries the real number.
  return (
    <span ref={ref} className={className} aria-label={text}>
      {text}
    </span>
  );
}
