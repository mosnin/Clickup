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

    // Late layout is a fact of this page: lazily-mounted components change
    // their height after every trigger has measured, sliding sections
    // hundreds of pixels while ScrollTrigger's numbers stand still — which
    // is how a reader ends up past a reveal whose trigger believes they are
    // still above it. ScrollTrigger watches the WINDOW resizing but not the
    // page growing, so watch the content itself. NOT document.body: on this
    // site the body's border-box is viewport-locked (844px box over an
    // 18,000px page, measured) so an observer there never fires once —
    // `scope` is the box that actually grows with the content. Debounced,
    // because image loads arrive in bursts and refresh() walks every
    // trigger on the page.
    let refreshTimer = 0;
    const contentResize = new ResizeObserver(() => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!cancelled) ScrollTrigger.refresh();
      }, 200);
    });
    contentResize.observe(scope);

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      contentResize.disconnect();
      ctx.revert();
    };
  }, []);

  return null;
}
