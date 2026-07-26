"use client";

import gsap from "gsap";
import { HOW_IT_WORKS } from "@/lib/marketing-content";
import {
  Container,
  CtaButton,
  Eyebrow,
} from "@/components/marketing/ui";
import { DUR, EASE_OUT, GsapReveal, useGsap } from "@/components/marketing/gsap";
import { AgentCard } from "../sections/agent-card";
import GradientText from "@/components/gradient-text";

// /how-it-works — the page the nav was missing. Features answers "what is in
// it"; use-cases answers "is it for me"; nothing answered the question a
// non-technical reader actually asks first, which is "what would I be doing,
// concretely, on day one".
//
// So this page is four steps and nothing else: a numbered spine down the left,
// each step's real detail on the right, the glass agent card as the one visual,
// and a plain answer to "what can it actually touch" before the close.

export function HowItWorksContent() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelector("[data-spine]"),
      { scaleY: 0 },
      {
        scaleY: 1,
        ease: "none",
        scrollTrigger: {
          trigger: root.querySelector("[data-steps]"),
          start: "top 70%",
          end: "bottom 70%",
          scrub: true,
        },
      },
    );
    gsap.fromTo(
      root.querySelectorAll("[data-step]"),
      { autoAlpha: 0, y: 24 },
      {
        autoAlpha: 1,
        y: 0,
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.14,
        scrollTrigger: { trigger: root.querySelector("[data-steps]"), start: "top 78%" },
      },
    );
  });

  return (
    <div ref={ref}>
      <div className="mk-band pt-28 pb-16 text-center sm:pt-36">
        <Container>
          <Eyebrow tone="dark">How it works</Eyebrow>
          <h1 className="mx-auto mt-5 max-w-3xl text-balance text-4xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">
            Four steps, and{" "}
            <GradientText>one of them is technical.</GradientText>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            {HOW_IT_WORKS.sub}
          </p>
        </Container>
      </div>

      <section className="bg-background py-20 sm:py-24">
        <Container>
          <div data-steps className="relative">
            {/* The spine draws itself as you scroll the steps. Hidden below md
                where the steps stack and a vertical rule would just be a line
                floating beside nothing. */}
            <div
              aria-hidden
              className="absolute left-[1.4rem] top-2 hidden h-[calc(100%-1rem)] w-px bg-white/[0.08] md:block"
            >
              <div
                data-spine
                className="mk-gradient-fill h-full w-full origin-top"
              />
            </div>

            <ol className="space-y-14 md:space-y-20">
              {HOW_IT_WORKS.steps.map((step, i) => (
                <li
                  key={step.title}
                  data-step
                  className="grid grid-cols-1 gap-4 md:grid-cols-[3rem_minmax(0,1fr)] md:gap-10"
                >
                  <div className="relative">
                    <span className="relative z-10 grid size-11 place-items-center rounded-full bg-background text-sm tabular-nums text-white/50 ring-1 ring-white/[0.12]">
                      {i + 1}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-x-12 gap-y-4 lg:grid-cols-2">
                    <div>
                      <h2 className="text-2xl font-medium tracking-[-0.02em] text-foreground sm:text-3xl">
                        {step.title}
                      </h2>
                      <p className="mt-3 text-base leading-relaxed text-muted-foreground">
                        {step.body}
                      </p>
                    </div>
                    <dl className="space-y-3 self-center rounded-2xl bg-white/[0.03] p-5 ring-1 ring-white/[0.07]">
                      {step.detail.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-baseline justify-between gap-4 border-t border-white/[0.06] pt-3 first:border-0 first:pt-0"
                        >
                          <dt className="text-sm text-muted-foreground">
                            {row.label}
                          </dt>
                          <dd className="text-right text-sm font-medium text-foreground">
                            {row.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Container>
      </section>

      <AgentCard />

      <section className="bg-background pb-24 sm:pb-28">
        <Container>
          <GsapReveal className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
              {HOW_IT_WORKS.boundaries.title}
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              {HOW_IT_WORKS.boundaries.sub}
            </p>
          </GsapReveal>

          <GsapReveal
            stagger
            className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2"
          >
            {HOW_IT_WORKS.boundaries.rows.map((row) => (
              <div
                key={row.q}
                className="border-t border-white/[0.08] pt-5"
              >
                <p className="text-sm font-semibold text-foreground">{row.q}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {row.a}
                </p>
              </div>
            ))}
          </GsapReveal>

          <GsapReveal className="mt-16 flex flex-wrap items-center justify-center gap-3">
            <CtaButton
              href="/sign-up"
              variant="primary"
              size="lg"
              className="mk-gradient-fill transition-opacity hover:opacity-90"
            >
              Start for free
            </CtaButton>
            <CtaButton href="/features" variant="ghostDark" size="lg">
              See every feature
            </CtaButton>
          </GsapReveal>
        </Container>
      </section>
    </div>
  );
}
