"use client";

import gsap from "gsap";
import { Container, Placeholder, SectionHeading } from "@/components/marketing/ui";
import { GsapReveal, useGsap } from "@/components/marketing/gsap";
import { OPS_STACK } from "@/lib/marketing-content";

// Phase G — "The agent ops stack" feature-card grid, white section.

export function OpsStack() {
  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading
          tone="dark"
          eyebrow={OPS_STACK.eyebrow}
          title={OPS_STACK.title}
          sub={OPS_STACK.sub}
        />
        <OpsStackGrid />
      </Container>
    </section>
  );
}

/**
 * Feature-card grid. GsapReveal still drives the entrance cascade on the
 * cards themselves; layered on top, a scroll-scrubbed tween drifts each
 * right-column card's inner content opposite the left column (0px on the
 * left, +12 → -12px on the right — 24px of total travel) so the two-up
 * grid reads as gently layered depth. The drift lives on an inner wrapper,
 * never the card entrance target, so the two tweens never fight over the
 * same transform.
 */
function OpsStackGrid() {
  const ref = useGsap(({ root }) => {
    const drifters = Array.from(
      root.querySelectorAll<HTMLElement>(".gs-ops-drift"),
    );
    drifters.forEach((el, i) => {
      const isRightColumn = i % 2 === 1;
      if (!isRightColumn) return;
      gsap.fromTo(
        el,
        { y: 12 },
        {
          y: -12,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "bottom top",
            scrub: true,
          },
        },
      );
    });
  });

  return (
    <div ref={ref}>
      <GsapReveal stagger className="mt-14 grid gap-6 md:grid-cols-2">
        {OPS_STACK.cards.map((card) => (
          <div
            key={card.title}
            className="gs-ops-card rounded-[20px] bg-muted p-2 transition-transform duration-300 hover:-translate-y-0.5 hover:shadow-lg"
          >
            <div className="gs-ops-drift">
              <Placeholder
                label={card.visual}
                ratio="16/10"
                className="rounded-[14px]"
              />
              <div className="px-6 pb-6 pt-5">
                <h3 className="text-lg font-semibold tracking-tight text-foreground">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {card.body}
                </p>
              </div>
            </div>
          </div>
        ))}
      </GsapReveal>
    </div>
  );
}
