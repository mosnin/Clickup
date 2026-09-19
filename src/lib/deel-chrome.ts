// Deel chrome helpers — greeting, long date, status classes.
//
// Pure, so the home header and any other surface can share one voice, and
// so the copy can be unit-tested without mounting React. The 2025 Deel home
// (Mobbin) says "Hey, Alex" — not a time-of-day greeting. The wave lives
// in the page so this string stays testable.

export function greetingFor(name: string | undefined | null): string {
  const trimmed = name?.trim();
  return trimmed ? `Hey, ${trimmed}` : "Hey";
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

/** "Total 289 people" — the line Deel puts above an unboxed table. */
export function totalLabel(
  count: number,
  singular: string,
  plural?: string,
): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `Total ${count} ${word}`;
}
