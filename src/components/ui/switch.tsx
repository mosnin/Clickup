"use client";

import { cn } from "@/lib/utils";

// The app's on/off control. A plain button with `role="switch"` — the same
// treatment that was already hand-rolled inline in the operations panel,
// admin console and task detail, promoted to one primitive so every toggle
// looks and behaves identically. Ink track when on, muted when off; the
// knob slides, and `motion-reduce:` snaps it instead for anyone who asked
// for less motion.
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "tap-target relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-foreground" : "bg-muted-foreground/30",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-background shadow-xs transition-transform motion-reduce:transition-none",
          checked ? "translate-x-4" : "translate-x-1",
        )}
      />
    </button>
  );
}
