"use client";

import { useEffect, useRef } from "react";
import { Datamosh } from "./engine";
import { onTransitionChange } from "@/lib/view-transition";

// The footer's backdrop.
//
// `DatamoshCard` (shipped with the engine) draws the piece as a card: a fixed
// 1344/620 aspect, a rounded corner, a border. The footer needs the opposite —
// the engine filling the whole band edge to edge, with the footer's own content
// sitting on top of it. Same engine, same lifecycle, different host box.
//
// The scrim is not optional. The palette runs to saturated yellow and white, and
// footer links have to stay readable over whatever tile happens to be under them
// at that moment — which changes several times a second. So the colour is
// knocked back hard and a dark wash sits between it and the text.

export function DatamoshBackdrop({ className = "" }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let engine: Datamosh | null = null;
    let raf = 0;
    let created = false;
    let onScreen = false;
    let hidden = false;
    let inTransition = false;

    const running = () => onScreen && !hidden && !inTransition;
    const sync = () => {
      if (!engine || reduced) return;
      if (running()) engine.start();
      else engine.stop();
    };

    // Built on first approach rather than on mount: the footer is below the
    // fold on every page, so a reader who never scrolls never pays for it.
    const create = () => {
      if (created) return;
      created = true;
      raf = requestAnimationFrame(() => {
        if (!hostRef.current) return;
        engine = new Datamosh(host, 1 + Math.floor(Math.random() * 9999));
        if (!engine.ok) return;
        if (reduced) engine.renderStill();
        else sync();
      });
    };

    const io = new IntersectionObserver(
      (es) => {
        onScreen = es.some((e) => e.isIntersecting);
        if (onScreen && !created) create();
        if (created) sync();
      },
      { rootMargin: "200px" },
    );
    io.observe(host);

    const onVis = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVis);
    const offTransition = onTransitionChange((active) => {
      inTransition = active;
      sync();
    });

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      offTransition();
      if (raf) cancelAnimationFrame(raf);
      engine?.destroy();
      engine = null;
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <div ref={hostRef} className="absolute inset-0 opacity-[0.38]" />
      {/* The legibility scrim. Two stops rather than a flat wash so the colour
          still reads at the top edge, where nothing is written over it. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(9,14,32,0.62) 0%, rgba(9,14,32,0.86) 42%, rgba(9,14,32,0.93) 100%)",
        }}
      />
    </div>
  );
}
