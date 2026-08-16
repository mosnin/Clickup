"use client";

import { useState } from "react";
import { motion } from "motion/react";

import { uiSound } from "@/lib/sound";
import { cn } from "@/lib/utils";

// The app's on/off control — same API, same 20×36px geometry and tap-target
// as before; what changed is the PHYSICS, ported from the vendored beui
// switch. The thumb travels on a heavy, deliberate spring (high mass keeps
// the travel weighty without wobble), squishes while held, and the flick
// answers with a rising or falling two-note — the toggle you can feel.
const THUMB_SPRING = {
  type: "spring",
  stiffness: 800,
  damping: 80,
  mass: 4,
} as const;

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Accessible name — required, since the control renders no text. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [pressed, setPressed] = useState(false);
  const squish = pressed && !disabled;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        uiSound(checked ? "toggle_off" : "toggle_on");
        onCheckedChange(!checked);
      }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      className={cn(
        "tap-target relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-foreground" : "bg-muted-foreground/30",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {/* motion/react honours the dashboard's MotionConfig
          reducedMotion="user", so the spring collapses to an instant jump for
          anyone who asked for less motion — no motion-reduce: class needed. */}
      <motion.span
        aria-hidden
        initial={false}
        animate={{ x: checked ? 16 : 4, scale: squish ? 0.88 : 1 }}
        transition={THUMB_SPRING}
        className="inline-block h-4 w-4 rounded-full bg-background shadow-xs"
      />
    </button>
  );
}
