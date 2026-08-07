"use client";

import { useEffect } from "react";
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { useAppearance } from "@/components/appearance/appearance-provider";

// Motion primitives for the brand's animation language. One easing, one
// spring, used everywhere so the whole app moves as a single object:
//
//   - EASE: a long-tail ease-out (Apple-style deceleration) for reveals.
//   - SPRING: a soft critical-damped spring for layout/width/number moves.
//
// All primitives collapse to instant rendering under
// prefers-reduced-motion (MotionConfig reducedMotion="user" is set in the
// dashboard template).

export const EASE = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;

// Fade + rise + un-blur reveal. Use for page headers and hero blocks.
export function Reveal({
  children,
  delay = 0,
  y = 10,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

// Orchestrated list entrance: wrap the container in <Stagger>, each row
// in <StaggerItem>. Children cascade in 50ms apart.
export function Stagger({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.05, delayChildren: delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
  lift = false,
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * Make the item a physical object under the pointer.
   *
   * Off by default, because most staggered items are rows in a list and a
   * list where every line rises under the cursor is a list that will not hold
   * still long enough to be read. On for the things that ARE objects — a
   * bento block, a card — where the lift is what says it can be picked up.
   *
   * A spring rather than a duration: the block should arrive at rest rather
   * than stop at a time, and the difference is the whole of why one reads as
   * alive and the other as animated. Respects reduced motion through the
   * `MotionConfig` the shell mounts, like everything else here.
   */
  lift?: boolean;
}) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 12, filter: "blur(3px)" },
        show: {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          transition: { duration: 0.5, ease: EASE },
        },
      }}
      {...(lift
        ? {
            whileHover: { y: -5, scale: 1.006 },
            whileTap: { scale: 0.994 },
            transition: SPRING,
          }
        : null)}
    >
      {children}
    </motion.div>
  );
}

// Springy count-up for stat tiles. Only animates plain numbers — pass
// strings straight through.
export function AnimatedNumber({
  value,
  className,
}: {
  value: number | string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const numeric = typeof value === "number" ? value : null;
  const spring = useSpring(0, { stiffness: 90, damping: 24 });
  const display = useTransform(spring, (v) =>
    Math.round(v).toLocaleString(),
  );

  useEffect(() => {
    if (numeric !== null) {
      if (reduced) spring.jump(numeric);
      else spring.set(numeric);
    }
  }, [numeric, reduced, spring]);

  if (numeric === null) return <span className={className}>{value}</span>;
  return <motion.span className={className}>{display}</motion.span>;
}

// A value against a target, whose fill springs to its new width.
//
// The drawing is the reader's (or the room's) choice, not this function's:
// `chartStyle` decides between the bar, a hairline, a dial and no graphic at
// all. Putting the branch here rather than at the call sites is what makes the
// setting mean anything — there are a dozen of these across sprints, goals,
// roadmaps and list overviews, and a preference that only reached one of them
// would be a preference in name.
//
// `className`/`barClassName` describe a bar (its height, its colour), so they
// apply to the two bar-shaped answers and are ignored by the other two. Outside
// an AppearanceProvider `useAppearance` returns the shipped defaults, so this
// stays safe on the marketing site and in tests.
export function AnimatedBar({
  pct,
  className,
  barClassName,
}: {
  pct: number;
  className?: string;
  barClassName?: string;
}) {
  const { appearance } = useAppearance();
  const clamped = Math.min(100, Math.max(0, pct));

  if (appearance.chartStyle === "numeric") {
    return (
      <span className="block text-xs tabular-nums text-muted-foreground">
        <AnimatedNumber value={Math.round(clamped)} />%
      </span>
    );
  }

  if (appearance.chartStyle === "ring") {
    return (
      <span
        className="meter-ring relative inline-flex h-9 w-9 items-center justify-center align-middle"
        style={{ ["--meter-turn" as string]: `${clamped / 100}turn` }}
      >
        <span className="relative text-micro font-medium tabular-nums">
          {Math.round(clamped)}
        </span>
      </span>
    );
  }

  return (
    <div className={className} data-chart-line={appearance.chartStyle === "line" || undefined}>
      <motion.div
        className={barClassName}
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={{ type: "spring", stiffness: 90, damping: 24, mass: 0.8 }}
      />
    </div>
  );
}

// Live presence dot with a soft radiating ping while online.
export function PresenceDot({
  online,
  className,
}: {
  online: boolean;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex h-1.5 w-1.5 ${className ?? ""}`}>
      {online && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
      )}
      <span
        className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
          online ? "bg-emerald-500" : "bg-muted-foreground"
        }`}
      />
    </span>
  );
}

export { motion, AnimatePresence, MotionConfig } from "motion/react";
