"use client";

import gsap from "gsap";
import { PROBLEM } from "@/lib/marketing-content";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { DUR, EASE_OUT, useGsap } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";

// The villain beat, and the only section on the site that does not mention the
// product. It runs before any feature because a reader who has not admitted
// the problem has no reason to care about the solution.
//
// Typographic on purpose — no cards, no screenshots, no colour except the one
// gradient in the heading. After a hero full of moving parts, three plain
// statements on hairlines read as someone lowering their voice. The rules draw
// themselves in on scroll, which is the whole animation.

export function Problem() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelectorAll("[data-rule]"),
      { scaleX: 0 },
      {
        scaleX: 1,
        duration: DUR.slow,
        ease: EASE_OUT,
        stagger: 0.12,
        scrollTrigger: { trigger: root, start: "top 72%" },
      },
    );
    gsap.fromTo(
      root.querySelectorAll("[data-item]"),
      { autoAlpha: 0, y: 18 },
      {
        autoAlpha: 1,
        y: 0,
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.12,
        scrollTrigger: { trigger: root, start: "top 72%" },
      },
    );
  });

  return (
    // data-st-03: pixel-grid handoff (section-transition.ts). As the villain
    // section scrolls out, a chunky 14-column pixel wave dissolves it into
    // the lifted band that answers it — the fill color is SAMPLED from that
    // next sibling, which is why the SocialProof band carries a real
    // background rather than transparent-over-canvas.
    <section ref={ref} data-st-03="14" className="bg-background py-24 sm:py-32">
      <Container>
        <div className="max-w-3xl">
          <Eyebrow>{PROBLEM.eyebrow}</Eyebrow>
          <h2 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.03em] text-foreground sm:text-5xl">
            Chat forgets. <GradientText>Work doesn&apos;t.</GradientText>
          </h2>
          <p
            data-reveal-02="lines"
            data-scroll
            className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground"
          >
            {PROBLEM.sub}
          </p>
        </div>

        <div className="mt-16 space-y-0">
          {PROBLEM.items.map((item, i) => (
            <div key={item.title}>
              <div
                aria-hidden
                data-rule
                className="h-px w-full origin-left bg-white/[0.09]"
              />
              <div
                data-item
                className="grid grid-cols-1 gap-2 py-8 md:grid-cols-[3.5rem_minmax(0,22rem)_minmax(0,1fr)] md:gap-8 md:py-10"
              >
                <p className="text-sm tabular-nums text-white/25">
                  0{i + 1}
                </p>
                <h3 className="text-xl font-medium tracking-[-0.01em] text-foreground sm:text-2xl">
                  {item.title}
                </h3>
                <p className="text-base leading-relaxed text-muted-foreground">
                  {item.body}
                </p>
              </div>
            </div>
          ))}
          <div aria-hidden data-rule className="h-px w-full origin-left bg-white/[0.09]" />
        </div>

        <p
          data-item
          className="mt-12 max-w-2xl text-xl font-medium tracking-[-0.01em] text-foreground sm:text-2xl"
        >
          {PROBLEM.kicker}
        </p>
      </Container>
    </section>
  );
}
