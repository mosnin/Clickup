"use client";

import gsap from "gsap";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { useGsap, EASE_OUT } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";
import { PricingGrid } from "../sections/pricing-grid";
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
            A workspace plan. <GradientText>A visible usage allowance.</GradientText>
          </h1>
          <p data-hero-sub className="mt-4 text-base text-white/70 sm:text-lg">
            Proposed pricing for coordinating your team. Runtime hosting and model tokens remain separate.
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
      {/* The grid is the only tier list on this page. <PricingSection />'s
          card version still runs on the home page; showing both here printed
          the same three tiers twice. */}
      <PricingGrid />
      <section className="py-16"><Container><div className="max-w-3xl"><h2 className="text-2xl">What the proposed allowance counts</h2><p className="mt-4 leading-relaxed text-muted-foreground">One coordination credit means one successful agent write in Operate. It is not a model token, an hour of runtime or a finished task. Reads, refused requests and duplicate retries should not consume the proposed allowance. Monthly enforcement must be implemented and tested before these packages launch.</p><p className="mt-4 leading-relaxed text-muted-foreground">Proposed terms: included writes reset each billing cycle. No automatic paid overages; usage beyond the allowance pauses new agent writes while review remains available. Optional top-ups would require an explicit purchase. Cancellation stops the next renewal. USD prices; taxes if applicable are additional. Existing agreements are unchanged.</p></div></Container></section>
      <Faq />
    </>
  );
}
