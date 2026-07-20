"use client";

// Shared template for the industry use-case pages (marketing v2). Content
// comes from src/lib/use-cases.ts verbatim; the narrative arc is the same
// for every industry: pains -> a day in the life -> the plays -> proof ->
// CTA, rendered in the navy-hero / white-content v2 grammar.

import { ArrowRight } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";
import type { UseCase } from "@/lib/use-cases";
import {
  Container,
  CtaButton,
  Eyebrow,
  Placeholder,
  SectionHeading,
} from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT } from "@/components/marketing/gsap";

// Compact hero mount-timeline (eyebrow -> H1 -> sub), a lighter echo of the
// home hero's entrance: same y/blur/autoAlpha language, ~0.12s stagger,
// done well under 1.2s.
function UseCaseHero({ uc }: { uc: UseCase }) {
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
            <Eyebrow tone="dark">{uc.eyebrow}</Eyebrow>
          </span>
          <h1
            data-hero-title
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            {uc.title}
          </h1>
          <p data-hero-sub className="mt-4 text-base text-white/70 sm:text-lg">
            {uc.sub}
          </p>
        </div>
      </Container>
    </section>
  );
}

export function UseCaseContent({ uc }: { uc: UseCase }) {
  return (
    <>
      <UseCaseHero uc={uc} />

      {/* Pains */}
      <section className="bg-background py-16 sm:py-20">
        <Container>
          <GsapReveal>
            <SectionHeading eyebrow="The problem" title="Where it breaks today." />
          </GsapReveal>
          <GsapReveal stagger className="mt-12 grid gap-5 md:grid-cols-3">
            {uc.pains.map((p) => (
              <div key={p.title} className="rounded-2xl bg-muted p-7">
                <h3 className="text-base font-semibold tracking-tight text-foreground">
                  {p.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {p.body}
                </p>
              </div>
            ))}
          </GsapReveal>
        </Container>
      </section>

      {/* A day in the life */}
      <section className="bg-muted/60 py-16 sm:py-20">
        <Container className="max-w-3xl">
          <GsapReveal>
            <SectionHeading
              eyebrow="A day on mission control"
              title="How the work actually flows."
            />
          </GsapReveal>
          <GsapReveal stagger className="mt-12 space-y-3">
            {uc.day.map((d, i) => (
              <div
                key={i}
                className="flex items-start gap-4 rounded-2xl bg-background p-4 ring-1 ring-border sm:gap-6"
              >
                <span className="w-16 flex-shrink-0 pt-0.5 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                  {d.time}
                </span>
                <span
                  className={cn(
                    "mt-0.5 flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    d.actor === "agent"
                      ? "bg-azure-100 text-azure-700"
                      : "bg-muted text-foreground/60",
                  )}
                >
                  {d.actor}
                </span>
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/85">
                  {d.text}
                </p>
              </div>
            ))}
          </GsapReveal>
        </Container>
      </section>

      {/* Plays */}
      <section className="bg-background py-16 sm:py-20">
        <Container>
          <GsapReveal>
            <SectionHeading eyebrow="The plays" title="What makes it work here." />
          </GsapReveal>
          <GsapReveal stagger className="mt-12 grid gap-5 sm:grid-cols-2">
            {uc.plays.map((p) => (
              <div
                key={p.title}
                className="rounded-[20px] bg-muted p-2 transition-transform duration-300 hover:-translate-y-0.5 hover:shadow-lg"
              >
                <Placeholder
                  label={`${p.title} illustration`}
                  ratio="16/10"
                  className="rounded-[14px]"
                />
                <div className="px-5 py-4">
                  <h3 className="text-base font-semibold tracking-tight text-foreground">
                    {p.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {p.body}
                  </p>
                </div>
              </div>
            ))}
          </GsapReveal>
        </Container>
      </section>

      {/* Quote */}
      <section className="bg-muted/60 py-16 sm:py-20">
        <Container className="max-w-2xl">
          <GsapReveal className="rounded-[28px] bg-navy-950 px-8 py-12 text-center sm:px-14 sm:py-14">
            <p className="text-xl font-medium leading-relaxed tracking-[-0.01em] text-white sm:text-2xl">
              &quot;{uc.quote.quote}&quot;
            </p>
            <p className="mt-6 text-sm text-white/60">
              {uc.quote.name} — {uc.quote.role}
            </p>
          </GsapReveal>
        </Container>
      </section>

      {/* CTA strip */}
      <section className="bg-background py-16 sm:py-20">
        <Container className="text-center">
          <GsapReveal>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Put your first agent on the board today.
            </h2>
            <CtaButton href="/sign-up" variant="primary" size="lg" className="mt-8">
              Start for free
              <ArrowRight className="ml-1.5 size-4" aria-hidden="true" />
            </CtaButton>
          </GsapReveal>
        </Container>
      </section>
    </>
  );
}
