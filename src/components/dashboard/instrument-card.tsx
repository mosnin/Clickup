"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { prefersReducedMotion } from "@/components/marketing/gsap";
import { cn } from "@/lib/utils";

// The nullframe instrument language, inside the app — on the app's own
// tokens so light mode, dark mode and every appearance setting keep
// working. Anatomy per card: a mono meta-row (label · optional LED · tag),
// a big figure, ONE human sentence in normal case, and an optional footer
// band. The deliberate differences from the marketing bento, because these
// are read every day rather than glanced at once: looser padding,
// mixed-case sentences instead of uppercase everywhere, and figures that
// get the full width of the card.
//
// Audit-shaped decisions (each one was a measured finding, not taste):
// — Tags are ALWAYS visible. The reference reveals them on hover, which on
//   a touch screen means never, and the hover-reveal shipped broken anyway
//   (its group class was missing) — a label nobody can see is not design.
// — The tag reads plain `text-muted-foreground`: the /70 it launched with
//   stacked opacity on the app's quietest register and measured 2.9:1 in
//   light — under AA, and invisible to the reader's contrast setting.
// — The card keeps a visible keyboard focus ring; these are links.
// — The figure's rolling digits are aria-hidden with an sr-only value:
//   the odometer renders all ten digits per place, so without this a
//   screen reader announced the card as digit soup.

/** The mono voice for meta-rows and tags. */
const MONO =
  "font-mono text-[0.6875rem] uppercase leading-none tracking-[0.1em]";

export function InstrumentCard({
  label,
  led,
  tag,
  href,
  footer,
  className,
  contentClassName,
  children,
  armed = false,
  index = 0,
}: {
  label: React.ReactNode;
  /** A pulsing status dot beside the label — only when it MEANS something. */
  led?: "orange" | "red" | "lime";
  tag?: string;
  /** Renders the card as a link when set. */
  href?: string;
  /** Pinned to the bottom over a hairline. */
  footer?: React.ReactNode;
  className?: string;
  /** Vertical rhythm of the middle band — small cards pass a tighter one. */
  contentClassName?: string;
  children: React.ReactNode;
  /** Flips true when the surface scrolls into view — fires one shine sweep. */
  armed?: boolean;
  /** Position among sibling cards; staggers the arm-time sweep. */
  index?: number;
}) {
  const [shining, setShining] = useState(false);

  // One sweep as the cards arrive (staggered by position) — on touch there
  // is no hover, and the sweep is half the language's character. Hover
  // re-fires it on desktop.
  useEffect(() => {
    if (!armed || prefersReducedMotion()) return;
    const t = setTimeout(() => setShining(true), 400 + index * 140);
    return () => clearTimeout(t);
  }, [armed, index]);

  const body = (
    <>
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
          <span className={cn(MONO, "font-bold tracking-[0.12em] text-muted-foreground")}>
            {tag}
          </span>
        )}
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col justify-center py-4",
          contentClassName,
        )}
      >
        {children}
      </div>
      {footer && <div className="border-t border-border pt-3">{footer}</div>}
    </>
  );

  const shell = cn(
    "relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card p-6 transition-colors",
    className,
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          shell,
          "hover:border-foreground/25",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
        onMouseEnter={() => {
          if (!prefersReducedMotion() && !shining) setShining(true);
        }}
      >
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}

/**
 * A segmented progress bar in the instrument voice. Cells pop in with the
 * back-ease stagger; theme-aware (unlit cells mix from the foreground,
 * never a hardcoded dark).
 */
export function InstrumentSegbar({
  on,
  lit,
  total = 14,
  tone,
  className,
  label,
}: {
  /** Light the first `on` cells… */
  on?: number;
  /** …or exactly these cells (e.g. which DAYS shipped work — an instrument
   * that rearranges history into a prefix reads as decoration). */
  lit?: boolean[];
  total?: number;
  tone?: "green";
  className?: string;
  /** Spoken description; without it the bar is decorative to a reader. */
  label?: string;
}) {
  const cells = lit ?? Array.from({ length: total }, (_, i) => i < (on ?? 0));
  return (
    <div
      className={cn("inst-segbar", tone, className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
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

/**
 * The dot-matrix figure — Doto around the existing rolling Counter. `value`
 * is REQUIRED and spoken: the odometer's DOM is all ten digits stacked per
 * place, which is what a screen reader would otherwise read.
 */
export function InstrumentFigure({
  value,
  className,
  children,
}: {
  value: number | string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("block leading-none text-foreground", className)}>
      <span className="sr-only">{value}</span>
      <span
        aria-hidden
        className="block"
        style={{ fontFamily: "var(--font-doto), monospace", fontWeight: 600 }}
      >
        {children}
      </span>
    </span>
  );
}
