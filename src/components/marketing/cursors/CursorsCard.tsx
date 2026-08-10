"use client";

import { useEffect, useRef } from "react";
import { FlyingCursors, type CursorDef } from "./engine";
import { FrostedWord } from "./FrostedWord";
import { onTransitionChange } from "@/lib/view-transition";

// The frosted word with collaborators flying around it.
//
// The cast is the point of putting this on our site rather than anyone else's:
// three of the five pointers are agents. A "who else is here" flourish that
// showed five human names would be every collaborative product's stock image —
// showing a researcher and a triage bot moving around the same word is the
// actual claim operate.to makes.

const CAST: CursorDef[] = [
  { name: "Ada", color: "#2f6bff" },
  { name: "scout-agent", color: "#12b981" },
  { name: "Priya", color: "#ff5c8a" },
  { name: "triage-agent", color: "#f5a524" },
  { name: "writer-agent", color: "#8b5cf6" },
];

export function CursorsCard({
  word = "together",
  className = "",
}: {
  word?: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Nothing to show still: the cursors ARE the motion, so under reduced
    // motion the word simply stands on its own rather than being surrounded by
    // five frozen arrows, which reads as a bug.
    if (reduced) return;

    let engine: FlyingCursors | null = null;
    let raf = 0;
    let created = false;
    let onScreen = false;
    let hidden = false;
    let inTransition = false;

    const sync = () => {
      if (!engine) return;
      if (onScreen && !hidden && !inTransition) engine.start();
      else engine.stop();
    };

    const create = () => {
      if (created) return;
      created = true;
      raf = requestAnimationFrame(() => {
        if (!hostRef.current) return;
        engine = new FlyingCursors(host, CAST);
        sync();
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
      // The engine appends absolutely-positioned nodes straight into this box,
      // so it has to be the positioning context and it has to clip.
      //
      // A LIGHT plate, on a page that is otherwise black. Not a rhythm break
      // for its own sake: the frosted word is glass — white speculars, a bright
      // top edge, a chip lit from above — and glass over black is a smudge. It
      // matches the other two specimen plates on the page (ai-lights in the
      // hero, code-trail further down) so the three read as one family.
      className={`relative isolate overflow-hidden rounded-[12px] border border-[var(--border-line)] bg-[var(--bg-page)] ${className}`}
    >
      {/* The word, centred, with room around it for the pointers to orbit. */}
      <div className="pointer-events-none relative z-10 flex min-h-[clamp(13rem,26vw,20rem)] items-center justify-center px-6">
        <FrostedWord className="text-[clamp(3rem,10vw,7rem)] leading-[0.95] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
          {word}
        </FrostedWord>
      </div>
    </div>
  );
}
