"use client";

import Link from "next/link";
import { useState } from "react";
import { prefersReducedMotion } from "@/components/marketing/gsap";
import { cn } from "@/lib/utils";

// The nullframe instrument language, inside the app — on the app's own
// tokens so light mode, dark mode and every appearance setting keep
// working. Anatomy per card: a mono meta-row (label · optional LED ·
// hover-revealed tag), a big figure, ONE human sentence in normal case,
// and an optional footer band. The deliberate differences from the
// marketing bento, because these are read every day rather than glanced
// at once: looser padding, mixed-case sentences instead of uppercase
// everywhere, and figures that get the full width of the card.

/** The mono voice for meta-rows and tags. */
const MONO =
  "font-mono text-[0.6875rem] uppercase leading-none tracking-[0.1em]";

export function InstrumentCard({
  label,
  led,
  tag,
  tagAlways = false,
  href,
  footer,
  className,
  children,
}: {
  label: React.ReactNode;
  /** A pulsing status dot beside the label — only when it MEANS something. */
  led?: "orange" | "red" | "lime";
  tag?: string;
  tagAlways?: boolean;
  /** Renders the card as a link when set. */
  href?: string;
  /** Pinned to the bottom over a hairline. */
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [shining, setShining] = useState(false);
  const Comp = href ? Link : "div";

  return (
    <Comp
      // Link needs href; the div branch ignores it.
      href={href ?? "#"}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card p-6 transition-colors",
        href && "hover:border-foreground/25",
        className,
      )}
      onMouseEnter={() => {
        if (!prefersReducedMotion() && !shining) setShining(true);
      }}
    >
      <span
        aria-hidden
        className={cn("inst-shine", shining && "play")}
        onAnimationEnd={() => setShining(false)}
      />
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(MONO, "flex items-center gap-2 text-muted-foreground")}
        >
          {led && (
            <span
              className={cn(
                "inst-led",
                led === "orange" && "bg-[#f26522]",
                led === "red" && "bg-[#d71921]",
                led === "lime" && "bg-signal-lime",
              )}
            />
          )}
          {label}
        </span>
        {tag && (
          <span
            className={cn(
              MONO,
              "font-bold tracking-[0.12em] text-muted-foreground/70 transition-opacity duration-200",
              !tagAlways && "opacity-0 group-hover/inst:opacity-100",
              tagAlways && "opacity-100",
            )}
          >
            {tag}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center py-4">
        {children}
      </div>
      {footer && (
        <div className="border-t border-border pt-3">{footer}</div>
      )}
    </Comp>
  );
}

/**
 * A segmented progress bar in the instrument voice. Cells pop in with the
 * back-ease stagger when `on` grows; theme-aware (unlit cells mix from the
 * foreground, never a hardcoded dark).
 */
export function InstrumentSegbar({
  on,
  lit,
  total = 14,
  tone,
  className,
}: {
  /** Light the first `on` cells… */
  on?: number;
  /** …or exactly these cells (e.g. which DAYS shipped work — an instrument
   * that rearranges history into a prefix reads as decoration). */
  lit?: boolean[];
  total?: number;
  tone?: "green";
  className?: string;
}) {
  const cells = lit ?? Array.from({ length: total }, (_, i) => i < (on ?? 0));
  return (
    <div className={cn("inst-segbar", tone, className)} aria-hidden>
      {cells.map((isOn, i) => (
        <i
          key={i}
          className={isOn ? "on" : undefined}
          style={isOn ? { animationDelay: `${i * 0.03}s` } : undefined}
        />
      ))}
    </div>
  );
}

/** The dot-matrix figure — Doto around the existing rolling Counter. */
export function InstrumentFigure({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("block leading-none text-foreground", className)}
      style={{ fontFamily: "var(--font-doto), monospace", fontWeight: 600 }}
    >
      {children}
    </span>
  );
}
