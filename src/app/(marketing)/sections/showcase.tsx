"use client";

import gsap from "gsap";
import GradientText from "@/components/gradient-text";
import { Container, Eyebrow, ScreenshotFrame } from "@/components/marketing/ui";
import { GsapReveal, GsapParallax, useGsap } from "@/components/marketing/gsap";
import { SHOWCASE } from "@/lib/marketing-content";

// Full-bleed dashboard showcase between sections. One large screenshot frame
// that scales up into place on scroll while still drifting via GsapParallax —
// the two wrappers nest and compose.
//
// It used to ship with no copy at all, which left a reader staring at an
// unexplained screenshot: the heading and caption now say which surface this
// is and what it is evidence of (scope, visible as a number).

export function Showcase() {
  return (
    <section className="bg-background py-16">
      <Container>
        <GsapReveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>{SHOWCASE.eyebrow}</Eyebrow>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
            Every project, and{" "}
            <GradientText>how far through it you are</GradientText>.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            {SHOWCASE.sub}
          </p>
        </GsapReveal>

        <GsapReveal className="relative mx-auto mt-12 max-w-5xl">
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
        // Native 2498x1534 so nothing gets cropped.
        ratio="2498/1534"
        tone="dark"
        src="/screenshots/home-showcase.png"
        alt="The projects directory in operate.to, with per-project status and task rollups"
        caption={SHOWCASE.caption}
        className="gs-showcase-frame"
      />
    </div>
  );
}
