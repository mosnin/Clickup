"use client";

import { MorphIcon } from "morphicons/react";
import type { IconInput } from "morphicons/react";
import { motionScale } from "@/lib/anime";

// One icon that becomes another, with spring physics.
//
// The rule this exists to enforce: **a morph has to mean a state change.**
// Two icons that mean the same thing at different times — collapsed becoming
// expanded, light becoming dark, customising becoming done — are a morph.
// Swapping one glyph for an unrelated one is a transition, and animating it
// is decoration that costs a frame budget and teaches nobody anything. If
// the two shapes would not read as the same object having changed, use a
// plain icon.
//
// Reduced motion is handled by not morphing at all rather than by morphing
// quickly. `motionScale()` already folds `prefers-reduced-motion` together
// with the reader's own motion setting — and prefers-reduced-motion always
// wins over the stored preference — so a scale of zero renders the target
// shape directly, no spring, no interpolation, nothing to settle.

export type MorphGlyphProps = {
  /** The shape to show now. Changing it animates. Lucide nodes work as-is. */
  icon: IconInput;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Names the icon for assistive tech; omitted means decorative. */
  label?: string;
  /**
   * `snappy` for controls that answer a press — the overshoot is what makes
   * a toggle feel like it latched. `smooth` for anything that changes on its
   * own, where overshoot reads as instability rather than as feedback.
   */
  spring?: "smooth" | "snappy" | "bouncy";
};

export function MorphGlyph({
  icon,
  size = 16,
  strokeWidth = 2,
  className,
  label,
  spring = "snappy",
}: MorphGlyphProps) {
  // Read per render rather than cached: the motion scale is a live CSS
  // custom property that a person can change while looking at the screen,
  // and a cached read would leave the old behaviour until remount.
  const still = motionScale() === 0;
  return (
    <MorphIcon
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      label={label}
      // Controlled at progress 1 = the target shape, drawn, with no spring
      // running. This is the honest form of "reduced motion": the end state,
      // immediately, not a fast animation.
      {...(still ? { progress: 1 } : { spring })}
    />
  );
}
