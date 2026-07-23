"use client";

// Shared renderer for /resources/[slug] (marketing v2): guides (structured
// sections with optional code blocks) and the changelog (release list).
// Consumes the `Resource` shape from src/lib/resources.ts verbatim.

import gsap from "gsap";
import type { Resource } from "@/lib/resources";
import { Container, CtaButton, Eyebrow } from "@/components/marketing/ui";
import { GsapReveal, useGsap, EASE_OUT } from "@/components/marketing/gsap";

// Mount-timeline entrance (eyebrow -> H1 -> sub -> reading time), a lighter
// echo of the home hero's feel: same y/blur/autoAlpha language, ~0.12s
// stagger, done well under 1.2s.
function ResourceHero({ resource }: { resource: Resource }) {
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
      )
      .fromTo(
        root.querySelector("[data-hero-reading]"),
        { autoAlpha: 0, y: 20 },
        { autoAlpha: 1, y: 0, duration: 0.4 },
        0.36,
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
          <Eyebrow tone="dark">{resource.eyebrow}</Eyebrow>
        </span>
        <h1
          data-hero-title
          className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-white sm:text-5xl"
        >
          <span className="text-gradient">{resource.title}</span>
        </h1>
        <p data-hero-sub className="mt-4 max-w-xl text-base text-white/70 sm:text-lg">
          {resource.sub}
        </p>
        <p data-hero-reading className="mt-5 text-sm text-white/60">
          {resource.readingTime}
        </p>
      </Container>
    </section>
  );
}

export function ResourceContent({ resource }: { resource: Resource }) {
  return (
    <>
      <ResourceHero resource={resource} />

      <section className="bg-background py-16 sm:py-20">
        <Container>
          <div className="mx-auto max-w-2xl">
            {resource.kind === "guide" ? (
              <Guide resource={resource} />
            ) : (
              <Changelog resource={resource} />
            )}
          </div>

          <GsapReveal className="mx-auto mt-16 max-w-2xl text-center sm:mt-20">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Put the first agent on your board today.
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Free to start. No credit card. One pasted config connects your
              first agent.
            </p>
            <CtaButton
              href="/sign-up"
              variant="primary"
              size="lg"
              className="mt-7"
            >
              Start free
            </CtaButton>
          </GsapReveal>
        </Container>
      </section>
    </>
  );
}

function Guide({ resource }: { resource: Resource }) {
  return (
    <GsapReveal stagger className="space-y-10">
      {(resource.sections ?? []).map((s) => (
        <div key={s.heading}>
          <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {s.heading}
          </h2>
          {s.body && (
            <p className="mt-3 text-[15px] leading-relaxed text-foreground/80">
              {s.body}
            </p>
          )}
          {s.bullets && (
            <ul className="mt-4 space-y-2.5">
              {s.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-1.5 size-1.5 flex-shrink-0 rounded-full bg-azure-500"
                  />
                  <span className="text-[15px] leading-relaxed text-foreground/80">
                    {b}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.code && (
            <div className="mt-5 overflow-hidden rounded-2xl mk-panel">
              <p className="border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {s.code.label}
              </p>
              <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-azure-200">
                {s.code.lines.join("\n")}
              </pre>
            </div>
          )}
        </div>
      ))}
    </GsapReveal>
  );
}

function Changelog({ resource }: { resource: Resource }) {
  return (
    <GsapReveal stagger className="space-y-8">
      {(resource.releases ?? []).map((r) => (
        <div key={r.tag} className="border-l-2 border-azure-500 py-0.5 pl-5">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {r.tag}
          </p>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
            {r.title}
          </h2>
          <ul className="mt-4 space-y-2.5">
            {r.items.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-1.5 size-1.5 flex-shrink-0 rounded-full bg-azure-300"
                />
                <span className="text-[15px] leading-relaxed text-foreground/80">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </GsapReveal>
  );
}
