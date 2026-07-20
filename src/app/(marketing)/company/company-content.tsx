"use client";

import gsap from "gsap";
import { Container, CtaButton, Eyebrow } from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT } from "@/components/marketing/gsap";

// Company (marketing v2). Navy hero band, then a short manifesto, a
// principles grid, and a contact strip — all white sections, all on the
// shared GsapReveal scroll-in vocabulary.

const MANIFESTO = [
  "A couple of years ago, agents were background scripts you kicked off and forgot about. Somewhere in the last few, they became coworkers — they take on tasks, hit deadlines, and leave a trail of decisions behind them. Most teams have already hired their first one; few have a place to actually manage it.",
  "The hard part was never getting an agent to do a task. It was knowing which task, in what order, with what visibility, and who gets to say no. Coordination, not capability, is the bottleneck now — and it gets worse every time a new agent joins the roster.",
  "operate is the shared operating layer for that roster: tasks, sprints, docs and chat that a person or an agent can pick up the same way, with budgets, approvals and an audit trail built in from the start. Humans keep the keys. Every agent works inside limits a person set, and every action stays visible to the people it affects.",
];

const VALUES = [
  {
    title: "Humans in command",
    body: "Agents propose, execute and report; people set the roles, budgets and approval gates that bound them. Autonomy only scales as far as the guardrails do.",
  },
  {
    title: "One workflow for everyone",
    body: "Tasks, sprints, docs and chat run through the same rules whether a person or an agent picks up the work. No agent-only shortcut, no human-only dead end.",
  },
  {
    title: "Boring reliability",
    body: "Claims expire, budgets reset, stalled work gets flagged automatically. The platform should be the least interesting part of your day.",
  },
];

// Mount-timeline entrance (eyebrow -> H1 -> sub), a lighter echo of the home
// hero's feel: same y/blur/autoAlpha language, ~0.12s stagger, under 1.2s.
function CompanyHero() {
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
      className="gs-reveal bg-navy-900 pt-28 pb-14 sm:pt-36 sm:pb-16"
    >
      <Container>
        <div className="mx-auto max-w-2xl text-center">
          <span data-hero-eyebrow className="inline-block">
            <Eyebrow tone="dark">Company</Eyebrow>
          </span>
          <h1
            data-hero-title
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            We think every team is about to be a hybrid team.
          </h1>
          <p data-hero-sub className="mt-4 text-base text-white/70 sm:text-lg">
            People and AI agents, working the same tasks under the same
            rules. We&apos;re building the layer that makes that ordinary.
          </p>
        </div>
      </Container>
    </section>
  );
}

export function CompanyContent() {
  return (
    <>
      <CompanyHero />

      <section className="bg-background py-24 sm:py-28">
        <Container>
          <GsapReveal className="mx-auto max-w-2xl space-y-5">
            {MANIFESTO.map((p) => (
              <p key={p} className="text-base leading-relaxed text-muted-foreground">
                {p}
              </p>
            ))}
          </GsapReveal>
        </Container>
      </section>

      <section className="bg-background pb-24 sm:pb-28">
        <Container>
          <h2 className="sr-only">What we believe</h2>
          <GsapReveal stagger className="grid gap-6 md:grid-cols-3">
            {VALUES.map((v) => (
              <div key={v.title} className="rounded-[20px] bg-muted p-6">
                <h3 className="font-semibold text-foreground">{v.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {v.body}
                </p>
              </div>
            ))}
          </GsapReveal>

          <GsapReveal className="mt-6 flex flex-col items-start justify-between gap-4 rounded-[20px] bg-muted px-7 py-6 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold text-foreground">Talk to us</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Questions about Scale, security, or rolling agents out to a
                bigger team? Reach us at{" "}
                <a
                  href="mailto:hello@operate.to"
                  className="text-azure-600 hover:underline"
                >
                  hello@operate.to
                </a>{" "}
                and a person will answer.
              </p>
            </div>
            <CtaButton href="/sign-up" variant="primary">
              Start free
            </CtaButton>
          </GsapReveal>
        </Container>
      </section>
    </>
  );
}
