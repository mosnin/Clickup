// The shared micro-motion vocabulary, vendored on the founder's instruction
// from two sources that turn out to agree with each other:
//
// **Tiered springs** (m1ckc3s/fluid-functionalism, MIT © Micka Touillaud) —
// "motion as information": every transition exists to make a state change
// legible, enters are springs, exits are plain tweens one tier quicker so a
// dismissal reads as final rather than replaying the entrance backwards, and
// the bigger the thing that moves, the slower the spring. Never hand-write a
// duration in a micro-interaction — reach for a tier.
//
// **Component springs** (beui.dev, for the vendored controls in
// src/components/beui) — named physics for specific jobs: press feedback,
// content swaps, panel entrances, layout glides.
//
// This file does NOT replace `src/components/motion.tsx` (EASE/SPRING —
// section- and page-level motion) or the marketing GSAP vocabulary. It is the
// third register: CONTROL-level physics, the 60–240ms tier where a checkbox
// ticks and a tooltip arrives. Reduced motion is handled where it always is —
// MotionConfig reducedMotion="user" wraps the dashboard, and the vendored
// components each check useReducedMotion for their non-transform effects.

/** Tiered enter springs; `.exit` is the matching quick tween. */
export const spring = {
  fast: {
    type: "spring" as const,
    duration: 0.08,
    bounce: 0,
    exit: { duration: 0.06 },
  },
  // Critically damped: lands exactly with no overshoot — short travel and
  // panels that must settle precisely.
  moderate: {
    type: "spring" as const,
    duration: 0.16,
    bounce: 0,
    exit: { duration: 0.12 },
  },
  slow: {
    type: "spring" as const,
    duration: 0.24,
    bounce: 0.12,
    exit: { duration: 0.16 },
  },
} as const;

/**
 * Fallback delay (ms) for deferred-unmount timers guarding an exit tween: a
 * throttled/background tab can stall onAnimationComplete, so portals
 * force-unmount after the tier's exit duration plus a buffer.
 */
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
  Math.round(tier.exit.duration * 1000) + 100;

// ── beui component physics ────────────────────────────────────────────────

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** CSS string form of EASE_OUT for inline style transitions. */
export const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;

/** Content swaps — label/icon slots trading places inside a control. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;

/** Overlay panel entrances — modals and sheets summoned by pointer. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides — pills and indicators morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;
