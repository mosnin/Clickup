"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { PRICING } from "@/lib/marketing-content";
import { Container } from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";
import { cn } from "@/lib/utils";

// Pricing grid — the fourth surface language on the site: no cards at all.
// Tiers are columns of one continuous table, separated by hairlines that come
// from a 1px-gapped grid over a lighter fill rather than per-column borders,
// so the seams never double up. Each column is topped by its own gradient
// rule, which is the only colour in the block.
//
// Content is the real PRICING object — three tiers, not a demo five.

// One accent per tier, left to right, cool ramp.
const RULES = [
  "from-cyan-400 to-cyan-800",
  "from-blue-400 to-blue-800",
  "from-teal-400 to-teal-800",
];

// The bars in the header illustration — a rough "capacity per tier" read,
// not a metric: heights are ordinal, matching the tier order.
const BARS = [
  { h: "34%", fill: "from-cyan-700 to-cyan-400" },
  { h: "62%", fill: "from-blue-700 to-blue-400" },
  { h: "88%", fill: "from-teal-700 to-teal-300" },
];

const INCLUDED = [
  "Every MCP tool",
  "Approval gates",
  "Audit trail",
];

export function PricingGrid() {
  return (
    <section data-price-grid className="bg-background">
      <Container className="border-x border-white/[0.06] px-0 sm:px-0">
        {/* Header: copy left, stepped bars right. */}
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <GsapReveal className="max-w-2xl px-6 py-16 sm:py-20">
            <h2 className="text-4xl font-medium leading-[1.04] tracking-[-0.03em] text-foreground sm:text-5xl">
              Clear pricing
              <br />
              for <GradientText>fast-moving teams</GradientText>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted-foreground">
              {PRICING.sub} Pick the tier that matches your pace — every one of
              them ships the full tool surface.
            </p>
          </GsapReveal>

          <div
            aria-hidden
            className="relative flex h-32 items-end justify-end overflow-hidden px-6 pb-0 sm:h-40 lg:h-auto"
          >
            <div className="flex h-[min(100%,190px)] w-full max-w-[260px] items-end">
              {BARS.map((bar, i) => (
                <div
                  key={i}
                  className={cn(
                    "relative w-1/3 bg-gradient-to-t",
                    bar.fill,
                  )}
                  style={{ height: bar.h }}
                >
                  {/* Scanline texture, the reference's one flourish. */}
                  <div
                    className="absolute inset-0 opacity-20 mix-blend-overlay"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(0deg, transparent, transparent 2px, #000 2px, #000 4px)",
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Included-everywhere bar */}
        <div className="flex flex-col items-start gap-3 border-y border-white/[0.06] bg-white/[0.02] px-6 py-4 sm:flex-row sm:items-center sm:gap-6">
          <span className="text-sm text-foreground">
            Every tier includes
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {INCLUDED.map((item, i) => (
              <span key={item} className="flex items-center gap-4">
                {i > 0 && (
                  <span
                    aria-hidden
                    className="size-1 rounded-full bg-white/25"
                  />
                )}
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* Tier columns. The 1px gap over a lighter fill draws the seams. */}
        <div className="flex w-full flex-col gap-px bg-white/[0.07] lg:flex-row">
          {PRICING.tiers.map((tier, i) => (
            <div
              key={tier.name}
              className="flex flex-1 flex-col bg-background p-6 transition-colors hover:bg-white/[0.02]"
            >
              <h3 className="text-xl font-medium tracking-[-0.02em] text-foreground">
                {tier.name}
              </h3>
              <div className="mt-4 flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-medium tracking-[-0.03em] text-foreground",
                    tier.price.startsWith("$") ? "text-4xl" : "text-3xl",
                  )}
                >
                  {tier.price}
                </span>
                <span className="text-xs text-muted-foreground">
                  {tier.period}
                </span>
              </div>

              <div
                aria-hidden
                className={cn(
                  "mt-6 h-0.5 w-full rounded-full bg-gradient-to-r",
                  RULES[i % RULES.length],
                )}
              />

              <p className="mt-6 min-h-[60px] text-sm leading-relaxed text-muted-foreground">
                {tier.blurb}
              </p>

              <ul className="mt-6 flex flex-col gap-3.5">
                {tier.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-3 text-sm text-foreground/85"
                  >
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-10 flex flex-col gap-3 pt-2">
                <Link
                  href={tier.href}
                  className={cn(
                    "w-full rounded-full py-2.5 text-center text-sm font-medium transition-opacity hover:opacity-90",
                    tier.featured
                      ? "mk-gradient-fill text-white"
                      : "bg-white/[0.07] text-foreground",
                  )}
                >
                  {tier.cta}
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* Closing texture strip — the reference's ruled footer. */}
        <div
          aria-hidden
          className="h-16 w-full border-t border-white/[0.06] opacity-20"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent, transparent 4px, #3f3f46 4px, #3f3f46 5px)",
          }}
        />
      </Container>
    </section>
  );
}
