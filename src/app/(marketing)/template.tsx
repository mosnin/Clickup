"use client";

import { useLayoutEffect, useRef } from "react";
import { MarketingPageEffects } from "@/components/marketing/page-effects";

// Page Transition 08 — the incoming page starts as a clipped horizontal
// band and expands to the full viewport while a dark overlay wipes upward.
//
// The source resource drives this with Swup, which cannot run here: Swup
// intercepts anchor clicks and swaps fetched HTML, which fights the App
// Router (and would break every next/link prefetch on these pages). What
// makes the effect what it is survives verbatim in globals.css — the two
// custom eases, the band geometry, the rgb(13,5,17) overlay, the 2s /
// 1.8s+0.5s timings — and the trigger is Next's own remount hook: a
// template re-renders per navigation within the segment, so every page
// change (and the first load, matching the resource's initial-load reveal)
// arrives covered and opens.
//
// Mechanism: the covered state ships IN the server HTML (`data-pt-cover`),
// so there is no flash of the open page before JS runs; the effect removes
// the attribute after two rAFs (one paint in the covered state, or the
// transition never fires) and the CSS transitions carry it open. Under
// prefers-reduced-motion the same attribute removal is a hard cut — the
// media query zeroes both transitions. The persistent nav lives in
// layout.tsx, outside this wrapper, exactly like Swup's "persistent
// navigation outside #swup" rule.
//
// The band geometry is restated in viewport units (83svh) rather than the
// resource's 83%: Swup's container IS the viewport (a 100vh grid area),
// but this wrapper is the whole document — 83% of a 5000px page would put
// the opening slit thousands of pixels below the fold, animating where
// nobody is looking.

export default function MarketingTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el.removeAttribute("data-pt-cover");
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  return (
    <div ref={ref} className="transition-clip" data-pt-cover="">
      <div className="overlay-page" aria-hidden />
      {children}
      <MarketingPageEffects />
    </div>
  );
}
