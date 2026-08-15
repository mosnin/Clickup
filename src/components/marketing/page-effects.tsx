"use client";

import { useLayoutEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { prefersReducedMotion } from "@/components/marketing/gsap";
import { textReveal02 } from "@/components/marketing/text-reveal";
import { sectionTransition03 } from "@/components/marketing/section-transition";

// Runs the vendored text-reveal and pixel-grid section effects against the
// marketing page that just mounted. Rendered from `(marketing)/template.tsx`,
// which remounts per navigation — that is what stands in for the "re-run the
// helper after client-side page swaps" step both resources require.
//
// Two obligations live here rather than in the vendored modules, so the
// modules stay verbatim:
//
// **Reduced motion must still show the text.** The required CSS hides every
// `[data-reveal-02]` before JS runs; skipping the animations without
// un-hiding would leave headings invisible forever — the same class of bug
// as a `data-gs-hidden` nobody removes.
//
// **Init must be idempotent against React strict-mode.** The pixel effect
// APPENDS its cell layers to the DOM; a double-mounted effect would stack
// two grids on every tagged section. Sweeping stale layers before init makes
// re-running safe, which the resource itself calls for after content swaps.

export function MarketingPageEffects() {
  useLayoutEffect(() => {
    const scope = document.querySelector("main") ?? document.body;

    if (prefersReducedMotion()) {
      scope
        .querySelectorAll<HTMLElement>("[data-reveal-02]")
        .forEach((el) => {
          el.style.visibility = "visible";
        });
      return;
    }

    let cancelled = false;
    const ctx = gsap.context(() => {});
    // Fonts first: SplitText measures line breaks, and a split taken in the
    // fallback face is wrong the moment the webfont lands.
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      ctx.add(() => {
        scope
          .querySelectorAll("[data-st-03-pixels]")
          .forEach((layer) => layer.remove());
        textReveal02(scope);
        sectionTransition03(scope);
        ScrollTrigger.refresh();
      });
    });

    return () => {
      cancelled = true;
      ctx.revert();
    };
  }, []);

  return null;
}
