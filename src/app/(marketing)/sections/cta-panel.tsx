"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import gsap from "gsap";
import { Container, CtaButton, ScreenshotFrame } from "@/components/marketing/ui";
import { useGsap, EASE_OUT, DUR } from "@/components/marketing/gsap";
import { CTA_PANEL } from "@/lib/marketing-content";

// Dark left-aligned CTA panel that closes out the page — screenshot bleeds
// off the panel's right/bottom edge, clipped by the panel's own rounded
// corners.
export function CtaPanel() {
  const ref = useGsap(({ root }) => {
    // Left column: eyebrow → title → sub → cta → footnote, staggered in.
    const items = Array.from(
      root.querySelectorAll<HTMLElement>("[data-cta-item]"),
    );
    gsap.fromTo(
      items,
      { autoAlpha: 0, y: 28, filter: "blur(6px)" },
      {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.06,
        clearProps: "filter",
        scrollTrigger: { trigger: root, start: "top 85%", once: true },
      },
    );

    // Screenshot: scrubbed in on its own inner wrapper so the outer div's
    // Tailwind translate classes (the "bleed" offset) stay intact — GSAP's
    // inline transform would otherwise clobber them.
    const shot = root.querySelector<HTMLElement>("[data-cta-shot]");
    if (shot) {
      gsap.fromTo(
        shot,
        { x: 80, rotate: 2 },
        {
          x: 0,
          rotate: 0,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "top 35%",
            scrub: true,
          },
        },
      );
    }
  });

  return (
    <section className="bg-background py-24">
      <Container>
        <div className="relative overflow-hidden rounded-[28px] bg-navy-950 ring-1 ring-white/10">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.04]"
          >
            <defs>
              <pattern
                id="cta-panel-texture"
                width="64"
                height="64"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="2" cy="2" r="1" fill="white" />
                <line x1="0" y1="32" x2="64" y2="32" stroke="white" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#cta-panel-texture)" />
          </svg>

          <div
            ref={ref}
            className="gs-reveal relative grid items-center md:grid-cols-[1.1fr_1fr]"
            data-gs-hidden=""
          >
            <div className="px-8 py-12 sm:px-14 sm:py-16">
              <span
                data-cta-item
                className="text-[11px] font-semibold uppercase tracking-widest text-white/50"
              >
                {CTA_PANEL.eyebrow}
              </span>
              <h2
                data-cta-item
                className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl"
              >
                {CTA_PANEL.title}
              </h2>
              <p data-cta-item className="mt-4 max-w-md text-sm leading-relaxed text-white/70 sm:text-base">
                {CTA_PANEL.sub}
              </p>
              <div data-cta-item className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
                <CtaButton
                  href={CTA_PANEL.primaryCta.href}
                  variant="primary"
                  size="lg"
                  className="w-full sm:w-auto"
                >
                  {CTA_PANEL.primaryCta.label}
                </CtaButton>
                <Link
                  href={CTA_PANEL.secondaryCta.href}
                  className="inline-flex items-center gap-1 text-sm font-medium text-white/70 transition-colors hover:text-white"
                >
                  {CTA_PANEL.secondaryCta.label}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>
              <p data-cta-item className="mt-6 max-w-sm text-xs italic text-white/55">
                {CTA_PANEL.footnote}
              </p>
            </div>

            <div className="px-8 pb-0 translate-y-6 md:translate-x-10 md:translate-y-8 md:self-end md:px-0 md:pb-0">
              <div data-cta-shot>
                <ScreenshotFrame label={CTA_PANEL.screenshot} ratio="4/3" tone="light" />
              </div>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
