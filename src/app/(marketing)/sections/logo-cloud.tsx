"use client";

import { Container } from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";

// Logo cloud, directly under the hero. Monochrome and quiet on purpose: it is
// a credibility beat between the headline and the product, not a section of
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

export function LogoCloud() {
  return (
    <section className="bg-black pb-16 pt-2 sm:pb-20">
      <Container>
        <GsapReveal className="flex flex-col items-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
            Used by people at
          </p>
          <ul className="mt-7 grid grid-cols-3 items-center justify-items-center gap-x-6 gap-y-7 sm:grid-cols-4 lg:grid-cols-6">
            {LOGOS.map((logo) => (
              <li key={logo.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logo.src}
                  alt={logo.name}
                  loading="lazy"
                  className="h-7 w-24 object-contain opacity-55 brightness-0 invert transition-opacity duration-300 hover:opacity-100 sm:h-8 sm:w-28"
                />
              </li>
            ))}
          </ul>
        </GsapReveal>
      </Container>
    </section>
  );
}
