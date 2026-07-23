"use client";

import { Fragment } from "react";
import { ArrowRight, ListChecks, Plug, ShieldCheck } from "lucide-react";
import Link from "next/link";
import gsap from "gsap";
import { HERO } from "@/lib/marketing-content";
import { Container, CtaButton, ScreenshotFrame } from "@/components/marketing/ui";
import { HeroRotator } from "@/components/marketing/hero-rotator";
import { useGsap, GsapParallax, EASE_OUT } from "@/components/marketing/gsap";
import { cn } from "@/lib/utils";

// Step icons, in order — semantic markers for each onboarding step, not
// decoration (Plug = connect, ListChecks = assign, ShieldCheck = guardrails).
const STEP_ICONS = [Plug, ListChecks, ShieldCheck];

// Headline lead words. The old inline glyph is gone: between "AI" and
// "workforce" sits the living <HeroRotator/> (a flipping use-case icon plus
// a rewriting domain word), so the line reads "…your AI [icon] engineering
// workforce." and cycles through use cases.
const LEAD_WORDS = ["Recruit,", "direct", "and", "scale", "your", "AI"];
const WORD_STAGGER = 0.045;

// Home hero — the signature entrance moment. A single mount timeline (not
// scroll-triggered) reveals chip -> title -> sub -> CTAs -> steps ->
// screenshot. Lives on the shared azure->navy band from page.tsx; no
// background of its own.

export function Hero() {
  const ref = useGsap(({ root }) => {
    const tl = gsap.timeline({ defaults: { ease: EASE_OUT } });

    tl.fromTo(
      root.querySelector("[data-hero-chip]"),
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: 0.5 },
    )
      .fromTo(
        root.querySelectorAll("[data-hero-word]"),
        { autoAlpha: 0, y: 28, filter: "blur(8px)" },
        {
          autoAlpha: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.5,
          stagger: WORD_STAGGER,
          clearProps: "filter",
        },
        "-=0.35",
      )
      .fromTo(
        root.querySelector("[data-hero-glyph]"),
        { autoAlpha: 0, scale: 0.4 },
        {
          autoAlpha: 1,
          scale: 1,
          duration: 0.4,
          ease: "back.out(1.6)",
        },
        `<+=${(LEAD_WORDS.length - 1) * WORD_STAGGER}`,
      )
      .fromTo(
        root.querySelector("[data-hero-last-word]"),
        { autoAlpha: 0, y: 28, filter: "blur(8px)" },
        {
          autoAlpha: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.5,
          clearProps: "filter",
        },
        "<+=0.08",
      )
      .fromTo(
        root.querySelector("[data-hero-sub]"),
        { autoAlpha: 0, y: 20 },
        { autoAlpha: 1, y: 0, duration: 0.6 },
        "-=0.4",
      )
      .fromTo(
        root.querySelector("[data-hero-cta]"),
        { autoAlpha: 0, y: 16 },
        { autoAlpha: 1, y: 0, duration: 0.5 },
        "-=0.35",
      )
      .fromTo(
        root.querySelectorAll("[data-hero-step]"),
        { autoAlpha: 0, y: 16 },
        { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.08 },
        "-=0.3",
      )
      .fromTo(
        root.querySelectorAll("[data-hero-connector]"),
        { scaleX: 0 },
        { scaleX: 1, duration: 0.4, stagger: 0.15 },
        "-=0.3",
      )
      .fromTo(
        root.querySelector("[data-hero-shot]"),
        { autoAlpha: 0, y: 48, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.9 },
        "-=0.5",
      );

    // Subtle scroll-linked tilt on the screenshot wrapper, independent of
    // the mount timeline above — settles from a barely-there perspective
    // lean to flat as the frame moves through the viewport.
    gsap.fromTo(
      root.querySelector("[data-hero-shot-tilt]"),
      { rotateX: 4, scale: 0.97 },
      {
        rotateX: 0,
        scale: 1,
        ease: "none",
        scrollTrigger: {
          trigger: root.querySelector("[data-hero-shot-tilt]"),
          start: "top bottom",
          end: "top 55%",
          scrub: true,
        },
      },
    );
  });

  return (
    <section
      ref={ref}
      data-gs-hidden=""
      className="gs-reveal relative overflow-x-clip pt-28 pb-10 sm:pt-36"
    >
      {/* Quiet circuit-line texture — thin traces + tiny dots, barely
          there. Pure inline SVG, no external asset. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[440px] w-full"
        viewBox="0 0 1200 440"
        fill="none"
        preserveAspectRatio="none"
      >
        <path
          d="M0 70 H210 V150 H470"
          strokeWidth="1"
          className="stroke-white/[0.06]"
        />
        <path
          d="M1200 50 H970 V190 H750"
          strokeWidth="1"
          className="stroke-white/[0.05]"
        />
        <path
          d="M120 410 V270 H360"
          strokeWidth="1"
          className="stroke-white/[0.05]"
        />
        <path
          d="M1060 390 V250 H830"
          strokeWidth="1"
          className="stroke-white/[0.06]"
        />
        <path
          d="M0 260 H90 V330"
          strokeWidth="1"
          className="stroke-white/[0.04]"
        />
        <path
          d="M1200 310 H1110 V380"
          strokeWidth="1"
          className="stroke-white/[0.04]"
        />
        <circle cx="210" cy="70" r="2" className="fill-white/[0.06]" />
        <circle cx="470" cy="150" r="2" className="fill-white/[0.06]" />
        <circle cx="970" cy="50" r="2" className="fill-white/[0.05]" />
        <circle cx="750" cy="190" r="2" className="fill-white/[0.05]" />
        <circle cx="360" cy="270" r="2" className="fill-white/[0.05]" />
        <circle cx="830" cy="250" r="2" className="fill-white/[0.06]" />
        <circle cx="90" cy="330" r="1.5" className="fill-white/[0.04]" />
        <circle cx="1110" cy="380" r="1.5" className="fill-white/[0.04]" />
      </svg>

      <Container className="text-center">
        <Link
          href="/features"
          data-hero-chip
          className="group inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5 text-xs text-white/90 ring-1 ring-white/20 transition-colors hover:bg-white/15"
        >
          {HERO.announce}
          <ArrowRight
            className="size-3 transition-transform duration-300 group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <h1
          data-hero-title
          aria-label="Recruit, direct and scale your AI workforce."
          className="mx-auto mt-6 max-w-3xl text-balance text-4xl font-semibold tracking-[-0.02em] text-white sm:text-6xl lg:text-7xl"
        >
          {LEAD_WORDS.map((word, i) => {
            const bare = word.replace(/[.,]/g, "").toLowerCase();
            const emphasize = bare === "ai";
            return (
              <Fragment key={word + i}>
                <span
                  data-hero-word
                  className={cn("inline-block", emphasize && "text-gradient")}
                >
                  {word}
                </span>{" "}
              </Fragment>
            );
          })}
          <span data-hero-glyph className="mr-2 inline-flex align-middle">
            <HeroRotator />
          </span>{" "}
          <span data-hero-last-word className="inline-block text-gradient">
            workforce.
          </span>
        </h1>

        <p
          data-hero-sub
          className="mx-auto mt-5 max-w-2xl text-base text-white/70 sm:text-lg"
        >
          {HERO.sub}
        </p>

        <div
          data-hero-cta
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <CtaButton
            href={HERO.primaryCta.href}
            variant="primary"
            size="lg"
            className="mk-gradient-fill transition-opacity hover:opacity-90"
          >
            {HERO.primaryCta.label}
            <ArrowRight className="ml-1.5 size-4" aria-hidden />
          </CtaButton>
          <CtaButton href={HERO.secondaryCta.href} variant="ghostDark" size="lg">
            {HERO.secondaryCta.label}
          </CtaButton>
        </div>

        <div className="mx-auto mt-14 grid max-w-3xl grid-cols-1 gap-y-8 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-start">
          {HERO.steps.map((step, i) => {
            const Icon = STEP_ICONS[i];
            const isFirst = i === 0;
            return (
              <Fragment key={step.title}>
                {i > 0 && (
                  <div
                    aria-hidden
                    className="relative hidden h-6 w-10 items-center justify-self-center sm:flex"
                  >
                    <div
                      data-hero-connector
                      className="h-px w-full origin-left bg-white/20"
                    />
                    <span className="absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40" />
                  </div>
                )}
                <div data-hero-step className="text-center">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/15">
                    <Icon className="size-4 text-white/80" aria-hidden />
                  </div>
                  <p
                    className={cn(
                      "mt-3 text-sm font-semibold",
                      isFirst ? "text-white" : "text-white/65",
                    )}
                  >
                    {step.title}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-xs leading-relaxed",
                      isFirst ? "text-white/70" : "text-white/55",
                    )}
                  >
                    {step.body}
                  </p>
                </div>
              </Fragment>
            );
          })}
        </div>

        <GsapParallax
          speed={40}
          className="relative mx-auto mt-16 max-w-4xl [perspective:1200px]"
        >
          <div
            aria-hidden
            className="mk-glow pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[85%] w-[90%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          />
          <div data-hero-shot-tilt>
            <div data-hero-shot>
              <ScreenshotFrame
                tone="dark"
                ratio="16/9"
                label={HERO.screenshot}
                src="/screenshots/hero-dashboard.png"
                alt="The operate.to dashboard — mission control for humans and AI agents"
                beam
              />
            </div>
          </div>
        </GsapParallax>
      </Container>
    </section>
  );
}
