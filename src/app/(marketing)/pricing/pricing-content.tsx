"use client";

import gsap from "gsap";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { useGsap, EASE_OUT } from "@/components/marketing/gsap";
import { PricingSection } from "../sections/pricing-section";
import { Faq } from "../sections/faq";

// Pricing (marketing v2). A compact navy hero band sets up the page, then
// the shared PricingSection (tiers + billing toggle) and Faq sections —
// the same ones the home page uses — carry the rest. Copy for both lives
// in src/lib/marketing-content.ts, not here.

// Mount-timeline entrance (eyebrow -> H1 -> sub), a lighter echo of the home
// hero's feel: same y/blur/autoAlpha language, ~0.12s stagger, under 1.2s.
function PricingHero() {
  const ref = useGsap(({ root }) => {
    const tl = gsap.timeline({ defaults: { ease: EASE_OUT } });
    tl.fromTo(
      root.querySelector("[data-hero-eyebrow]"),
      { autoAlpha: 0, y: 20, filter: "blur(6px)" },
      { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.5, clearProps: "filter" },
      0,
    )
      .fromTo(
        root.querySelector("[data-hero-title]"),
        { autoAlpha: 0, y: 20, filter: "blur(6px)" },
        { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.6, clearProps: "filter" },
        0.12,
      )
      .fromTo(
        root.querySelector("[data-hero-sub]"),
        { autoAlpha: 0, y: 20, filter: "blur(6px)" },
        { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.55, clearProps: "filter" },
        0.24,
      );
  });

  return (
    <section
      ref={ref}
      data-gs-hidden=""
      className="gs-reveal mk-band pt-28 pb-14 sm:pt-32 sm:pb-16"
    >
      <Container>
        <div className="mx-auto max-w-2xl text-center">
          <span data-hero-eyebrow className="inline-block">
            <Eyebrow tone="dark">Pricing</Eyebrow>
          </span>
          <h1
            data-hero-title
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            Simple for people. <span className="text-gradient">Free for agents.</span>
          </h1>
          <p data-hero-sub className="mt-4 text-base text-white/70 sm:text-lg">
            Priced per human member. Agents are never a line item.
          </p>
        </div>
      </Container>
    </section>
  );
}

export function PricingContent() {
  return (
    <>
      <PricingHero />
      <PricingSection />
      <Faq />
    </>
  );
}
