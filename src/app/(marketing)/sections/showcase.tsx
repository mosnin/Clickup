"use client";

import gsap from "gsap";
import { Container, ScreenshotFrame } from "@/components/marketing/ui";
import { GsapReveal, GsapParallax, useGsap } from "@/components/marketing/gsap";
import { SHOWCASE } from "@/lib/marketing-content";

// Phase G — full-bleed dashboard showcase between sections. One large
// screenshot frame that scales up into place on scroll (Apple-style) while
// still drifting via GsapParallax — the two wrappers nest and compose. No
// copy.

export function Showcase() {
  return (
    <section className="bg-background py-16">
      <Container>
        <GsapReveal className="relative mx-auto max-w-5xl">
          <div
            aria-hidden
            className="mk-glow pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[75%] w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          />
          <GsapParallax speed={50}>
            <ShowcaseScaleFrame />
          </GsapParallax>
        </GsapReveal>
      </Container>
    </section>
  );
}

/**
 * Scroll-scrubbed scale-up entrance for the showcase frame: scale 0.93 → 1,
 * driven by scroll position from "top 95%" to "top 40%". Lives on the frame
 * itself (not the GsapParallax wrapper) so the drift and the scale-up
 * compose instead of fighting over the same transform. Border radius is
 * NOT animated here — radius interpolation isn't compositor-friendly on a
 * full-bleed frame (it forces paint every scrub frame instead of running on
 * the compositor thread like the transform does); the frame keeps its
 * static rounded class instead.
 */
function ShowcaseScaleFrame() {
  const ref = useGsap(({ root }) => {
    const frame = root.querySelector<HTMLElement>(".gs-showcase-frame");
    if (!frame) return;
    gsap.fromTo(
      frame,
      { scale: 0.93 },
      {
        scale: 1,
        ease: "none",
        scrollTrigger: {
          trigger: root,
          start: "top 95%",
          end: "top 40%",
          scrub: true,
        },
      },
    );
  });

  return (
    <div ref={ref}>
      <ScreenshotFrame
        label={SHOWCASE.screenshot}
        ratio="16/9"
        tone="dark"
        className="gs-showcase-frame"
      />
    </div>
  );
}
