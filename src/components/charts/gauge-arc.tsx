"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Semicircular gauge (Cyberlock "Current Score" reference). Pure SVG + CSS —
// the value arc rides pathLength={100} so strokeDasharray is a percentage and
// the 0.6s dasharray transition sweeps the arc on any value change; no
// animation library, no client component. Everything is tokens, so light and
// dark render identically by construction.
export function GaugeArc({
  value,
  max,
  caption,
  className,
}: {
  value: number;
  max: number;
  caption?: string;
  className?: string;
}) {
  // Guard max === 0 (and negative/NaN-ish inputs) — pct must land in [0,100]
  // or the dash pattern wraps and draws a phantom second arc.
  const target = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
  // First paint draws the arc at zero; the real value lands a frame later and
  // the CSS dasharray transition sweeps it in — the needle EARNS its reading.
  // Reduced motion never sees the zero frame: the transition below is cut by
  // the same media query that cuts every other entrance.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const pct = armed ? target : 0;

  // Knob position: 180° sweep over radius 80 centred at (100,100). pct 0 sits
  // at the left mouth (20,100), pct 100 at the right (180,100), so the angle
  // walks π → 0 as pct climbs. SVG y grows downward, hence the subtraction.
  const theta = Math.PI * (1 - target / 100);
  const knobX = 100 + 80 * Math.cos(theta);
  const knobY = 100 - 80 * Math.sin(theta);

  return (
    <div className={cn("relative", className)}>
      <svg viewBox="0 0 200 112" className="w-full h-auto" aria-hidden>
        {/* Track: full 180° from left mouth over the top to the right mouth. */}
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke="var(--color-muted)"
          strokeWidth={22}
          strokeLinecap="round"
        />
        {/* Value: same geometry, dashed to pct of a normalized path length. */}
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke="var(--color-signal-yellow)"
          strokeWidth={22}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
          className="motion-reduce:transition-none"
          style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
        {/* Knob at the arc's end. Skipped when max === 0: a needle pointing at
            "0 of nothing" asserts a reading that doesn't exist. */}
        {max > 0 && (
          <>
            {/* Foreground/card rather than literal white/ink: the white knob
                was tuned on the dark slab and measured 1.00:1 — invisible —
                on the light theme's white card. Foreground IS white in dark,
                so the shipped look survives untouched. */}
            <circle
              cx={knobX}
              cy={knobY}
              r={9}
              fill="var(--color-foreground)"
              opacity={armed ? 1 : 0}
              style={{ transition: "opacity 0.3s ease 0.7s" }}
            />
            <circle
              cx={knobX}
              cy={knobY}
              r={3.5}
              fill="var(--color-card)"
              opacity={armed ? 1 : 0}
              style={{ transition: "opacity 0.3s ease 0.7s" }}
            />
          </>
        )}
      </svg>
      {/* The figure sits in the arc's mouth — absolutely positioned over the
          svg so the number scales with the container, not the viewBox. */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
        {/* The dot-matrix face every instrument figure wears — plain glyphs,
            fully readable, so no sr-only twin is needed here. */}
        <span
          className="text-4xl leading-none text-foreground"
          style={{ fontFamily: "var(--font-doto), monospace", fontWeight: 600 }}
        >
          {value}
        </span>
        {caption && (
          <span className="text-tiny text-muted-foreground">{caption}</span>
        )}
      </div>
    </div>
  );
}
