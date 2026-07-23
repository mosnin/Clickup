"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import gsap from "gsap";
import { RESOURCES } from "@/lib/resources";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT } from "@/components/marketing/gsap";

// /resources index (marketing v2). Compact navy hero band, then a white
// section with a grid of resource cards. Kind label reads straight off
// each resource's `eyebrow` ("Guide" / "Changelog") — no re-derivation.

// Mount-timeline entrance (eyebrow -> H1 -> sub), a lighter echo of the home
// hero's feel: same y/blur/autoAlpha language, ~0.12s stagger, under 1.2s.
function ResourcesHero() {
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
      className="gs-reveal bg-navy-950 pb-16 pt-28 sm:pb-20 sm:pt-36"
    >
      <Container>
        <span data-hero-eyebrow className="inline-block">
          <Eyebrow tone="dark">Resources</Eyebrow>
        </span>
        <h1
          data-hero-title
          className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-white sm:text-5xl"
        >
          Guides for the <span className="text-gradient">agent era</span>.
        </h1>
        <p data-hero-sub className="mt-4 max-w-xl text-base text-white/70 sm:text-lg">
          Short, honest walkthroughs for connecting agents, teaching them your
          process, and everything we&apos;ve shipped along the way.
        </p>
      </Container>
    </section>
  );
}

export function ResourcesIndex() {
  return (
    <>
      <ResourcesHero />

      <section className="bg-background py-16">
        <Container>
          <GsapReveal stagger className="grid gap-5 sm:grid-cols-2">
            {RESOURCES.map((r) => (
              <Link
                key={r.slug}
                href={`/resources/${r.slug}`}
                className="group flex flex-col rounded-[20px] bg-muted p-6 transition-colors hover:bg-muted/70"
              >
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {r.eyebrow}
                </span>
                <h2 className="mt-3 text-lg font-semibold tracking-tight text-foreground">
                  {r.title}
                </h2>
                <p className="mt-2 flex-1 text-sm text-muted-foreground">
                  {r.sub}
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-azure-600">
                  Read
                  <ArrowRight
                    aria-hidden
                    className="size-3.5 transition-transform duration-300 group-hover:translate-x-1"
                  />
                </span>
              </Link>
            ))}
          </GsapReveal>
        </Container>
      </section>
    </>
  );
}
