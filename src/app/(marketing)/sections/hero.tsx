"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import gsap from "gsap";
import { HERO } from "@/lib/marketing-content";
import { Container, CtaButton, ScreenshotFrame } from "@/components/marketing/ui";
import { HeroUnicorn } from "@/components/marketing/hero-unicorn";
import { useGsap, GsapParallax, EASE_OUT } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";

// Headline, one line per array entry. Two lines, never more: a third line
// pushed the product shot off a phone screen entirely, which is the one thing
// the hero cannot afford. The second line carries the gradient.
const HEADLINE = ["Agents that finish", "what they start."];
const LINE_STAGGER = 0.09;

// Home hero — the signature entrance moment. A single mount timeline (not
// scroll-triggered) reveals chip -> title -> sub -> CTAs -> screenshot. The
// three-step icon row that used to sit above the shot is gone: it delayed the
// product by a full screen on mobile and said what the sub-headline already
// says. Lives on the black canvas; the Unicorn scene is the only backdrop.

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
          stagger: LINE_STAGGER,
          clearProps: "filter",
        },
        "-=0.35",
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
        root.querySelector("[data-hero-shot]"),
        { autoAlpha: 0, y: 48, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.9 },
        "-=0.5",
      );

    // Two scrubbed tweens on the shot, and they do different jobs.
    //
    // Arriving: the frame comes up out of focus, slightly over-scaled and
    // leaning back, and resolves as it reaches the middle of the viewport —
    // a zoom-blur settle, so scrolling *into* the product feels like
    // focusing on it rather than passing it.
    const tilt = root.querySelector("[data-hero-shot-tilt]");
    gsap.fromTo(
      tilt,
      { rotateX: 5, scale: 1.06, filter: "blur(14px)" },
      {
        rotateX: 0,
        scale: 1,
        filter: "blur(0px)",
        ease: "none",
        scrollTrigger: {
          trigger: tilt,
          start: "top bottom",
          end: "top 45%",
          scrub: true,
        },
      },
    );

    // Leaving: it defocuses and lifts away as the next section takes over,
    // so the seam between the hero and what follows is a dissolve instead of
    // a hard cut.
    gsap.fromTo(
      tilt,
      { filter: "blur(0px)", scale: 1, autoAlpha: 1 },
      {
        filter: "blur(10px)",
        scale: 0.97,
        autoAlpha: 0.35,
        ease: "none",
        scrollTrigger: {
          trigger: tilt,
          start: "bottom 55%",
          end: "bottom top",
          scrub: true,
        },
      },
    );
  });

  return (
    <section
      ref={ref}
      data-gs-hidden=""
      className="gs-reveal relative overflow-x-clip bg-black pt-28 pb-10 sm:pt-36"
    >
      {/* Unicorn Studio scene behind the headline.

          z-0, not the vendor snippet's -z-10: the marketing layout parks a
          fixed black field at -z-10, so a negative layer would sit behind it
          and never show. Hero content lifts to z-10 instead.

          The scene covers the headline band and fades out before the product
          shot rather than filling the whole section. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[clamp(36rem,92vh,58rem)] overflow-hidden"
      >
        <HeroUnicorn />
        {/* Three stacked scrims, in order of what each one fixes:
            a flat wash that pulls the whole scene down to a level the white
            headline can sit on, a vignette that keeps the edges darker than
            the middle, and a bottom fade landing on pure black — the same
            fill as the page canvas — so the band dissolves with no seam. */}
        <div className="absolute inset-0 bg-black/55" />
        <div className="absolute inset-0 bg-[radial-gradient(120%_95%_at_50%_18%,rgba(0,0,0,0.25)_25%,rgba(0,0,0,0.86)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent via-black/80 to-black" />
      </div>

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

      <Container className="relative z-10 text-center">
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
          className="mx-auto mt-6 max-w-[20ch] text-balance text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl lg:text-[4.25rem]"
        >
          {HEADLINE.map((line, i) => (
            <span data-hero-word key={line} className="block">
              {i === HEADLINE.length - 1 ? (
                <GradientText>{line}</GradientText>
              ) : (
                line
              )}
            </span>
          ))}
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
                // Match the screenshot's native aspect (3014x1554) so the
                // frame shows the full dashboard — object-cover into 16/9
                // was cropping the sidebar and right edge off.
                ratio="3014/1554"
                label={HERO.screenshot}
                src="/screenshots/hero-dashboard.png"
                alt="The operate.to dashboard — mission control for humans and AI agents"
                caption="The dashboard: your projects down the left, the fleet's live activity down the right."
                beam
              />
            </div>
          </div>
        </GsapParallax>
      </Container>
    </section>
  );
}
