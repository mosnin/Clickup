"use client";

import { Container } from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";

// Logo marquee, directly under the hero. Monochrome and quiet on purpose: it
// is a credibility beat between the headline and the product, not a section of
// its own, so nothing here competes with the hero's CTA.
//
// Assets are served from /public/brand/logos rather than hotlinked — the same
// rule the fonts follow. `brightness-0 invert` flattens whatever colour a mark
// ships with to white, so a row of wildly different logos reads as one line of
// type on the black canvas.
//
// The label is deliberately "used by people at", not "trusted by" or a bare
// logo wall: it claims individuals at these companies use operate, which is
// what it is. Edit LOGOS as that list changes — every entry should be someone
// you could name if asked.

const LOGOS = [
  { name: "Microsoft", src: "/brand/logos/microsoft.svg" },
  { name: "Google", src: "/brand/logos/google.svg" },
  { name: "Anthropic", src: "/brand/logos/anthropic.svg" },
  { name: "Adobe", src: "/brand/logos/adobe.svg" },
  { name: "Vercel", src: "/brand/logos/vercel.svg" },
  { name: "Perplexity", src: "/brand/logos/perplexity.svg" },
  { name: "WorkOS", src: "/brand/logos/workos.svg" },
  { name: "Netlify", src: "/brand/logos/netlify.svg" },
  { name: "FastAPI", src: "/brand/logos/fastapi.svg" },
  { name: "Stored", src: "/brand/logos/stored.png" },
  { name: "Chippi", src: "/brand/logos/chippi.png" },
] as const;

function Row({ ariaHidden }: { ariaHidden?: boolean }) {
  return (
    <ul
      className="flex shrink-0 items-center gap-x-12 pr-12 sm:gap-x-16 sm:pr-16"
      aria-hidden={ariaHidden || undefined}
    >
      {LOGOS.map((logo) => (
        <li key={logo.name} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logo.src}
            alt={ariaHidden ? "" : logo.name}
            loading="lazy"
            className="h-7 w-auto max-w-[7rem] object-contain opacity-55 brightness-0 invert transition-opacity duration-300 hover:opacity-100 sm:h-8 sm:max-w-[8rem]"
          />
        </li>
      ))}
    </ul>
  );
}

export function LogoCloud() {
  return (
    <section className="bg-black pb-16 pt-2 sm:pb-20">
      <Container>
        <GsapReveal className="flex flex-col items-center">
          <p className="text-tiny font-semibold uppercase tracking-[0.18em] text-white/40">
            Used by people at
          </p>
        </GsapReveal>
      </Container>

      {/* Full-bleed track, outside the Container so the marquee runs edge to
          edge. The row is rendered twice and the track translates -50%, which
          is what makes the loop seamless; the second copy is aria-hidden so
          the list is only announced once. Edges fade via a mask rather than a
          gradient overlay, so the black canvas shows through unchanged
          whatever sits behind it. */}
      <div
        className="marquee-mask mt-7 w-full overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
        }}
      >
        <div className="marquee-track">
          <Row />
          <Row ariaHidden />
        </div>
      </div>
    </section>
  );
}
