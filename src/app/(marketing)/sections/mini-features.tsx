"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { Container, Placeholder } from "@/components/marketing/ui";
import { DUR, EASE_OUT, useGsap, isHoverCapable } from "@/components/marketing/gsap";
import { DETAILS } from "@/lib/marketing-content";

// "operate handles the details" — masonry grid of small detail cards
// (reference: ToDesktop's "handles the details" section) followed by a
// full-bleed infinite word ticker.
export function MiniFeatures() {
  const headingRef = useGsap(({ root }) => {
    gsap.fromTo(
      root,
      { autoAlpha: 0, x: -16, filter: "blur(6px)" },
      {
        autoAlpha: 1,
        x: 0,
        filter: "blur(0px)",
        duration: DUR.base,
        ease: EASE_OUT,
        clearProps: "filter",
        scrollTrigger: { trigger: root, start: "top 85%", once: true },
      },
    );
  });

  // Masonry entrance: one ScrollTrigger batch, but each card gets a tiny
  // deterministic offset (delay + rise distance) derived from its index so
  // the cascade feels organic instead of a uniform sweep.
  const cardsRef = useGsap(({ root }) => {
    const cards = Array.from(root.children) as HTMLElement[];
    gsap.fromTo(
      cards,
      {
        autoAlpha: 0,
        y: (i: number) => 24 + (i % 2) * 10,
        filter: "blur(6px)",
      },
      {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: DUR.base,
        ease: EASE_OUT,
        delay: (i: number) => (i % 3) * 0.05 + Math.floor(i / 3) * 0.08,
        clearProps: "filter",
        scrollTrigger: { trigger: root, start: "top 85%", once: true },
      },
    );
  });

  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <div ref={headingRef} className="gs-reveal" data-gs-hidden="">
          <h2 className="max-w-md text-3xl font-semibold tracking-tight sm:text-4xl">
            {DETAILS.title}
          </h2>
        </div>

        <div
          ref={cardsRef}
          className="gs-reveal mt-12 columns-1 gap-5 sm:columns-2 lg:columns-3"
          data-gs-hidden=""
        >
          {DETAILS.cards.map((card) => (
            <div
              key={card.title}
              className="mb-5 break-inside-avoid rounded-[20px] bg-muted/70 p-6 text-center ring-1 ring-black/[0.04]"
            >
              <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
                {card.title}
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                {card.body}
              </p>
              {card.visual && (
                <Placeholder
                  label={card.visual}
                  ratio="16/7"
                  className="mt-4 overflow-hidden rounded-xl"
                />
              )}
            </div>
          ))}
        </div>
      </Container>

      <DetailsTicker />
    </section>
  );
}

/**
 * Full-bleed infinite marquee of bold words. The track holds exactly two
 * identical copies of the word list and sizes itself to its content
 * (`w-max`), so animating xPercent to -50 slides by precisely one copy's
 * width and the loop repeats with no visible seam.
 */
function DetailsTicker() {
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const ref = useGsap(() => {
    tweenRef.current = gsap.to(".gs-ticker-track", {
      xPercent: -50,
      ease: "none",
      duration: 30,
      repeat: -1,
    });
  });

  // Pause the marquee while a pointer that can hover rests on it; skipped
  // on touch devices, and inert under reduced motion (no tween exists).
  useEffect(() => {
    const el = ref.current;
    if (!el || !isHoverCapable()) return;
    const pause = () => tweenRef.current?.pause();
    const resume = () => tweenRef.current?.play();
    el.addEventListener("pointerenter", pause);
    el.addEventListener("pointerleave", resume);
    return () => {
      el.removeEventListener("pointerenter", pause);
      el.removeEventListener("pointerleave", resume);
    };
  }, [ref]);

  return (
    <div
      ref={ref}
      className="mt-16 w-full overflow-hidden border-y border-border py-5"
    >
      <div className="gs-ticker-track flex w-max whitespace-nowrap">
        {[...DETAILS.ticker, ...DETAILS.ticker].map((word, i) => (
          <span
            key={i}
            className="inline-flex items-center text-lg font-bold tracking-tight text-foreground sm:text-xl"
          >
            {word}
            <span className="mx-5 inline-block h-1 w-1 rounded-full bg-muted-foreground/50" />
          </span>
        ))}
      </div>
    </div>
  );
}
