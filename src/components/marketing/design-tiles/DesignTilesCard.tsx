"use client";

import { useEffect, useRef } from "react";
import { DesignTiles } from "./engine";
import { WORDS } from "./palette";
import { onTransitionChange } from "@/lib/view-transition";

// Mount for the design-tiles engine. The engine builds its own DOM inside the
// host and owns everything after that; this is the lifecycle around it —
// build on approach, run only while visible, tear down on unmount.
//
// `aria-label` carries the sentence, and the engine's own nodes are decorative,
// so a reader hears the phrase once rather than five disconnected words.

export function DesignTilesCard({ className = "" }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let engine: DesignTiles | null = null;
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

    const create = () => {
      if (created) return;
      created = true;
      raf = requestAnimationFrame(() => {
        if (!hostRef.current) return;
        engine = new DesignTiles(host);
        if (reduced) engine.renderStill();
        else sync();
        // Every width the engine measured is the fallback face's until the real
        // one loads; re-measure once it has, or the bar is packed to the wrong
        // advances and the tiles show hairline seams between them.
        document.fonts?.ready.then(() => engine?.refreshFont()).catch(() => {});
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
      ref={hostRef}
      data-canvas-card
      role="img"
      aria-label={WORDS.join(" ")}
      className={`relative w-full ${className}`}
      style={{ minHeight: "clamp(3.5rem, 9vw, 6rem)" }}
    />
  );
}
