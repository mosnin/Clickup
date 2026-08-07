"use client";

import { cn } from "@/lib/utils";
import { orbVars } from "@/lib/identity-color";

// The living identity mark: a glowing, slowly-swirling gradient whose color
// comes from the shared identity ramp (lib/identity-color), so an entity is
// the same color everywhere it appears. Pure CSS (see globals.css .orb) — no
// WebGL, so a list can render dozens cheaply, unlike a per-instance shader.
//
// `label` overlays the entity's initial on top of the gradient; `shape`
// switches between the round agent orb and the squircle used for
// organizations, spaces and the personal area.

const SIZE: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "h-6 w-6 text-micro",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
};

export function Orb({
  seed,
  size = "md",
  shape = "circle",
  label,
  color,
  className,
}: {
  seed: string;
  size?: "xs" | "sm" | "md" | "lg";
  shape?: "circle" | "squircle";
  /** Initial rendered over the gradient. Omit for a pure orb. */
  label?: string;
  /** Explicit color (e.g. a space's chosen swatch); overrides the seed. */
  color?: string;
  className?: string;
}) {
  const initial = label
    ? (Array.from(label.trim())[0] ?? "?").toUpperCase()
    : null;
  return (
    <span
      aria-hidden
      title={label}
      className={cn(
        "orb inline-flex shrink-0 items-center justify-center",
        shape === "squircle" ? "orb-squircle" : "rounded-full",
        SIZE[size],
        className,
      )}
      style={orbVars(seed, color) as React.CSSProperties}
    >
      <span className="orb-core" />
      <span className="orb-sheen" />
      {initial && <span className="orb-label">{initial}</span>}
    </span>
  );
}
