"use client";

// Shared layout blocks for marketing pages: sub-page heroes, section
// headings, stat blocks, and quote cards — all pre-wired with the
// scroll-reveal primitives so pages stay declarative.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { FadeIn } from "@/components/marketing/reveal";

export function Eyebrow({
  children,
  tone = "dark",
  className,
}: {
  children: React.ReactNode;
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.18em]",
        tone === "light" ? "text-sage-300" : "text-sage-600",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  sub,
  align = "left",
  tone = "dark",
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  align?: "left" | "center";
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <FadeIn
      className={cn(
        "max-w-2xl",
        align === "center" && "mx-auto text-center",
        className,
      )}
    >
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <h2
        className={cn(
          "mt-3 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl",
          tone === "light" && "text-white",
        )}
      >
        {title}
      </h2>
      {sub && (
        <p
          className={cn(
            "mt-4 text-base leading-relaxed sm:text-lg",
            tone === "light" ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {sub}
        </p>
      )}
    </FadeIn>
  );
}

// Sub-page hero on the cream canvas (the home page has its own custom
// full-bleed hero). Pads for the fixed header.
export function PageHero({
  eyebrow,
  title,
  sub,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="px-4 pb-14 pt-32 sm:px-6 sm:pt-40">
      <div className="mx-auto max-w-4xl text-center">
        <FadeIn>
          <Eyebrow className="justify-center">{eyebrow}</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-3xl text-balance text-4xl font-semibold tracking-[-0.025em] sm:text-6xl">
            {title}
          </h1>
          {sub && (
            <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
              {sub}
            </p>
          )}
        </FadeIn>
        {children && <FadeIn delay={0.15}>{children}</FadeIn>}
      </div>
    </section>
  );
}

export function CtaPair({
  primaryHref = "/sign-up",
  primaryLabel = "Get started — free",
  secondaryHref,
  secondaryLabel,
  tone = "dark",
  className,
}: {
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 sm:flex-row",
        className,
      )}
    >
      <Link
        href={primaryHref}
        className={cn(
          "group inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-transform active:scale-[0.97]",
          tone === "light"
            ? "bg-white text-foreground"
            : "bg-foreground text-white",
        )}
      >
        {primaryLabel}
        <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
      </Link>
      {secondaryHref && secondaryLabel && (
        <Link
          href={secondaryHref}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-6 py-3 text-sm font-semibold transition-colors",
            tone === "light"
              ? "border-white/30 text-white hover:bg-white/10"
              : "border-black/15 text-foreground hover:bg-black/[0.04]",
          )}
        >
          {secondaryLabel}
        </Link>
      )}
    </div>
  );
}

export function QuoteCard({
  quote,
  name,
  role,
  className,
}: {
  quote: string;
  name: string;
  role: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "flex h-full flex-col justify-between rounded-3xl border border-black/[0.06] bg-white p-6",
        className,
      )}
    >
      <blockquote className="text-[15px] leading-relaxed">
        &ldquo;{quote}&rdquo;
      </blockquote>
      <figcaption className="mt-6 flex items-center gap-3">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sage-200 text-sm font-semibold text-sage-700"
        >
          {name[0]}
        </span>
        <span>
          <span className="block text-sm font-semibold">{name}</span>
          <span className="block text-xs text-muted-foreground">{role}</span>
        </span>
      </figcaption>
    </figure>
  );
}

// Conversational accent — the floating "I can finally see…" bubble from
// the brand reference. Reads as a person reacting to the product.
export function ChatBubble({
  children,
  name,
  className,
}: {
  children: React.ReactNode;
  name?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex max-w-xs items-start gap-2.5 rounded-2xl rounded-bl-md bg-white px-4 py-3 text-left shadow-[0_16px_40px_-16px_rgb(16_16_18/0.3)]",
        className,
      )}
    >
      {name && (
        <span
          aria-hidden
          className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-sage-200 text-[10px] font-semibold text-sage-700"
        >
          {name[0]}
        </span>
      )}
      <span className="text-[13px] leading-snug text-foreground">
        {children}
      </span>
    </div>
  );
}

// Reference-style outcome tile: tinted icon square, huge numeral, quiet
// label underneath.
export function StatTile({
  icon,
  value,
  label,
  className,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col justify-between rounded-3xl border border-black/[0.06] bg-gradient-to-b from-sage-100/60 to-white p-6",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-pastel-green text-sm"
      >
        {icon}
      </span>
      <div className="mt-8">
        <p className="text-4xl font-semibold tabular-nums tracking-[-0.02em] sm:text-5xl">
          {value}
        </p>
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}
