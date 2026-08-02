"use client";

// The number that makes two modes read as one product.
//
// Being in Chat with three approvals waiting in Work has to be *visible*, or
// the two dashboards are two applications you remember to check. One number on
// the half you are not standing in is the smallest thing that fixes it — and it
// is the last thing C12 does, because it is only honest once everything above
// it is a read rather than a copy: a badge maintained as a counter is the
// classic denormalization bug, and a badge that disagrees with the list it
// summarises is worse than no badge.
//
// The partition lives in `src/lib/buzz/bridge.partitionCounts` and its rule is
// that a thing belongs to the side it **happened on**, not to the table it
// landed in. A Chat mention writes a row in Work's `mentions` table — that is
// the unified inbox, and it is deliberate — and it still counts on the Chat
// side, because opening the room is what makes it stop needing you. Counting it
// twice would make the two badges add to more than the number of things that
// have happened, which is the error people notice once and never forgive.

import { badgeLabel } from "@/lib/buzz/bridge";
import { useSwitcherCounts } from "./bridge-data";

/**
 * The counts, plus the subscription that feeds them.
 *
 * Returned together rather than mounted inside the badge because the badge is
 * rendered twice by `ModeSwitcher` (the segmented control and the icon rail)
 * and a subscription inside it would be two. The switcher mounts one.
 */
export function useModeBadges() {
  const { counts, subscription } = useSwitcherCounts();
  return {
    work: counts?.work ?? 0,
    chat: counts?.chat ?? 0,
    subscription,
  };
}

export function ModeBadge({ count, label }: { count: number; label: string }) {
  const text = badgeLabel(count);
  // No zero badge. A dot that says "there is something here" about nothing is
  // how people learn to stop reading the ones that are real.
  if (!text) return null;
  return (
    <span
      aria-label={`${count} waiting in ${label}`}
      className="ml-1 inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-foreground px-1 text-[0.625rem] font-semibold leading-4 text-background"
    >
      {text}
    </span>
  );
}
