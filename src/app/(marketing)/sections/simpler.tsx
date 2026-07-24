"use client";

import gsap from "gsap";
import { Container, CtaButton, ScreenshotFrame } from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT, DUR } from "@/components/marketing/gsap";
import { SIMPLER } from "@/lib/marketing-content";

// Closing "want something simpler?" panel — warm blush/peach card pitching
// the single-agent, no-team-required path.
export function Simpler() {
  const panelRef = useGsap(({ root }) => {
    // Panel: gentle scale + rise, not the default reveal blur treatment.
    gsap.fromTo(
      root,
      { autoAlpha: 0, y: 24, scale: 0.97 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: DUR.base,
        ease: EASE_OUT,
        scrollTrigger: { trigger: root, start: "top 85%", once: true },
      },
    );

    // Screenshot: small counter-parallax, drifting opposite the text
    // column's implied scroll direction rather than tracking it.
    const shot = root.querySelector<HTMLElement>("[data-simpler-shot]");
    if (shot) {
      gsap.fromTo(
        shot,
        { y: -16 },
        {
          y: 16,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "bottom top",
            scrub: true,
          },
        },
      );
    }
  });

  return (
    <section className="bg-background pb-28 pt-4">
      <Container>
        <GsapReveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {SIMPLER.title.split(" ").map((word, i, words) => (
              <span
                key={i}
                className={i === words.length - 1 ? "text-gradient" : undefined}
              >
                {word}
                {i < words.length - 1 ? " " : ""}
              </span>
            ))}
          </h2>
          <p className="mt-2 text-muted-foreground">{SIMPLER.sub}</p>
        </GsapReveal>
        <div
          ref={panelRef}
          className="gs-reveal mt-10 overflow-hidden rounded-[28px] p-8 ring-1 ring-white/10 sm:p-12"
          data-gs-hidden=""
          style={{
            // Pure-neutral charcoal (equal-RGB only — no warm/blush fills).
            background: "linear-gradient(135deg, #1a1a1a 0%, #0e0e0e 100%)",
          }}
        >
          <div className="grid items-center gap-8 md:grid-cols-2">
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-white">
                {SIMPLER.panel.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-white/70 sm:text-base">
                {SIMPLER.panel.body}
              </p>
              <CtaButton
                href={SIMPLER.panel.cta.href}
                variant="primary"
                className="mk-gradient-fill mt-6 transition-opacity hover:opacity-90"
              >
                {SIMPLER.panel.cta.label}
              </CtaButton>
            </div>
            <div data-simpler-shot>
              <ScreenshotFrame
                label={SIMPLER.panel.screenshot}
                // Native 2490x1540 so nothing gets cropped.
                ratio="2490/1540"
                tone="dark"
                src="/screenshots/personal-space.png"
                alt="A personal space in operate.to running a single agent"
              />
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
