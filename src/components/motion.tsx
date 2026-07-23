"use client";

import { useEffect } from "react";
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";

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
}: {
  children: React.ReactNode;
  className?: string;
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

// Progress bar whose fill springs to its new width instead of jumping.
export function AnimatedBar({
  pct,
  className,
  barClassName,
}: {
  pct: number;
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={className}>
      <motion.div
        className={barClassName}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
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
