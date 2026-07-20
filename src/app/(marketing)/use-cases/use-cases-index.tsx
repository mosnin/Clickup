"use client";

// Use-cases index (marketing v2) — compact navy hero band matching the
// /features treatment, then a white grid of illustrated case cards in the
// bento grammar (rounded-[20px] bg-muted tiles with a red Placeholder).

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import gsap from "gsap";
import { USE_CASES } from "@/lib/use-cases";
import {
  Container,
  CtaButton,
  Eyebrow,
  Placeholder,
} from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT } from "@/components/marketing/gsap";

// Compact hero mount-timeline (eyebrow -> H1 -> sub), a lighter echo of the
// home hero's entrance: same y/blur/autoAlpha language, ~0.12s stagger,
// done well under 1.2s.
function UseCasesHero() {
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
      className="gs-reveal bg-[linear-gradient(180deg,var(--color-navy-950)_0%,var(--color-navy-900)_100%)] pt-28 pb-16 sm:pt-36"
    >
      <Container>
        <div className="mx-auto max-w-2xl text-center">
          <span data-hero-eyebrow className="inline-block">
            <Eyebrow tone="dark">Use cases</Eyebrow>
          </span>
          <h1
            data-hero-title
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            Built for how your industry works.
          </h1>
          <p data-hero-sub className="mt-4 text-base text-white/70 sm:text-lg">
            The primitives stay the same — agents, gates, budgets, and a live
            feed. What changes is the work you hand over.
          </p>
        </div>
      </Container>
    </section>
  );
}

export function UseCasesIndex() {
  return (
    <>
      <UseCasesHero />

      <section className="bg-background py-16">
        <Container>
          <GsapReveal stagger className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((uc) => (
              <Link
                key={uc.slug}
                href={`/use-cases/${uc.slug}`}
                className="group block rounded-[20px] bg-muted p-2 transition-transform duration-300 hover:-translate-y-0.5 hover:shadow-lg"
              >
                <Placeholder
                  label={`${uc.label} illustration`}
                  ratio="16/10"
                  className="rounded-[14px]"
                />
                <div className="px-5 py-4">
                  <h2 className="text-base font-semibold tracking-tight text-foreground">
                    {uc.label}
                  </h2>
                  <p className="mt-1.5 line-clamp-1 text-sm text-muted-foreground">
                    {uc.title}
                  </p>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-azure-600">
                    Explore
                    <ArrowRight
                      aria-hidden="true"
                      className="size-3.5 transition-transform duration-300 group-hover:translate-x-1"
                    />
                  </span>
                </div>
              </Link>
            ))}
          </GsapReveal>

          <GsapReveal className="mt-16 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Don&apos;t see your team? The primitives fit anyway.
            </h2>
            <CtaButton href="/sign-up" variant="primary" size="lg" className="mt-8">
              Start for free
            </CtaButton>
          </GsapReveal>
        </Container>
      </section>
    </>
  );
}
