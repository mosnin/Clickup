"use client";

import { cn } from "@/lib/utils";

// A light that travels around an element's border, signaling "alive /
// listening." Render as the LAST child of a position:relative element that
// has a border-radius; the beam inherits the radius and rides the border.
// Pure CSS (see globals.css .border-beam) and reduced-motion-safe.

export function BorderBeam({
  className,
  size = 64,
  duration = 7,
  delay = 0,
  width = 1.5,
  from,
  to,
}: {
  className?: string;
  /** Length of the traveling light, in px. */
  size?: number;
  /** Seconds for one full lap. */
  duration?: number;
  /** Seconds of start offset (negative-phase via delay). */
  delay?: number;
  /** Border thickness the beam rides, in px. */
  width?: number;
  /** Gradient head color (defaults to the azure ramp). */
  from?: string;
  /** Gradient tail color. */
  to?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("border-beam", className)}
      style={
        {
          "--bb-size": `${size}px`,
          "--bb-duration": `${duration}s`,
          "--bb-delay": `${delay}s`,
          "--bb-width": `${width}px`,
          ...(from ? { "--bb-from": from } : {}),
          ...(to ? { "--bb-to": to } : {}),
        } as React.CSSProperties
      }
    />
  );
}
