// Deel chrome helpers — greeting, long date, status classes.
//
// Pure, so the home header and any other surface can share one voice, and
// so the copy can be unit-tested without mounting React. Times of day match
// Deel's homepage ("Good morning, Maya") rather than a generic "Welcome back".

export function greetingFor(
  name: string | undefined | null,
  now: Date = new Date(),
): string {
  const hour = now.getHours();
  const part =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const trimmed = name?.trim();
  return trimmed ? `${part}, ${trimmed}` : part;
}

/** Deel writes dates as "Saturday, 19 September" (day-first, long month). */
export function deelLongDate(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  const day = now.getDate();
  const month = now.toLocaleDateString("en-GB", { month: "long" });
  return `${weekday}, ${day} ${month}`;
}

export const DEEL_BADGE = {
  success:
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--badge-success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--badge-success-fg)]",
  warning:
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--badge-warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--badge-warning-fg)]",
  danger:
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--badge-danger-bg)] px-2 py-0.5 text-xs font-medium text-[var(--badge-danger-fg)]",
  neutral:
    "inline-flex items-center gap-1.5 rounded-full bg-[var(--badge-neutral-bg)] px-2 py-0.5 text-xs font-medium text-[var(--badge-neutral-fg)]",
} as const;
