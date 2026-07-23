"use client";

import { cn } from "@/lib/utils";

// A living agent orb: a glowing, slowly-swirling gradient sphere whose color
// is a deterministic-random hue derived from the agent's id/name, so each
// agent reads as its own orb and keeps the same color across renders. Pure
// CSS (see globals.css .orb) — no WebGL, so it's cheap to render many at
// once in a list, unlike a per-instance shader canvas.

const SIZE: Record<"sm" | "md" | "lg", string> = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
};

function hueFor(seed: string): number {
  // FNV-1a hash → stable 0-359 hue.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export function Orb({
  seed,
  size = "md",
  className,
}: {
  seed: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const hue = hueFor(seed);
  return (
    <span
      aria-hidden
      className={cn("orb inline-block shrink-0", SIZE[size], className)}
      style={
        {
          "--orb-a": `hsl(${hue} 85% 63%)`,
          "--orb-b": `hsl(${(hue + 45) % 360} 85% 58%)`,
          "--orb-c": `hsl(${(hue + 310) % 360} 80% 66%)`,
        } as React.CSSProperties
      }
    >
      <span className="orb-core" />
      <span className="orb-sheen" />
    </span>
  );
}
