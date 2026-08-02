// The transcript's clock, in one place.
//
// Four surfaces ask what time it is — the row's timestamp, its tooltip, the day
// divider's heading and a thread's "last replied" line — and they are four
// different sentences about the same number. Written at their call sites they
// drift within a week: one says "2:34 PM", the next "14:34", a third bakes
// "Today" into a string at render and keeps saying it after midnight.
//
// The rule that shape follows from: **a divider carries a timestamp, never a
// label.** `ChatRow` is `{ type: "day"; at }` for exactly this reason — the
// heading is resolved against the current clock every render, so a tab left
// open overnight relabels itself instead of insisting yesterday is today.
//
// **Everything here is in seconds**, because everything in the log is: a Nostr
// `created_at` is a second, `ChatMessage.createdAt` carries it unconverted, and
// a formatter that quietly took milliseconds would be right on one call site
// and 50 years out on the rest. `startOfLocalDaySeconds` is imported rather
// than re-derived — the projector already owns "when does a day start", and two
// answers to that is a divider in one place and a heading about another.
//
// Deliberately not `@/lib/time`'s `timeAgo`: that is the Work dashboard's one
// relative-time voice ("3h ago") and it is right there. A transcript needs a
// wall clock — "2:34 PM" is *where in the day* a thing was said, which is what
// a reader scanning a room is actually asking.

import { startOfLocalDaySeconds } from "@/lib/buzz/timeline";

const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const FULL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long" });

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** `"2:34 PM"`. */
export function formatTime(at: number): string {
  return TIME.format(at * 1000);
}

/** `"Wednesday, April 2, 2026 at 2:34 PM"` — the row timestamp's tooltip. */
export function formatFullDateTime(at: number): string {
  // en-US already renders "…, 2026 at 2:34 PM" in most ICU builds; normalising
  // the comma variant keeps the string stable across Node and browser ICU.
  return FULL.format(at * 1000).replace(/,\s*(\d{1,2}:\d{2})/, " at $1");
}

/**
 * `"th"` for 11/12/13 and everything ending 0 or 4–9; `"st"`, `"nd"`, `"rd"`
 * otherwise. The teens are the only interesting case and the only one anybody
 * ever gets wrong.
 */
export function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** `"May 19th"`. */
export function formatShortMonthDayOrdinal(at: number): string {
  const d = new Date(at * 1000);
  return `${MONTH.format(d)} ${ordinal(d.getDate())}`;
}

/**
 * `"Today"` / `"Yesterday"` / `"Monday, March 31st"` / with the year once the
 * date falls in a prior calendar year.
 */
export function formatDayHeading(at: number, now: number = nowSeconds()): string {
  const day = startOfLocalDaySeconds(at);
  const today = startOfLocalDaySeconds(now);
  if (day === today) return "Today";
  // Twelve hours back from local midnight lands inside yesterday whatever the
  // DST transition did to the day's length — subtracting 86400 does not.
  if (day === startOfLocalDaySeconds(today - 12 * 60 * 60)) return "Yesterday";
  const d = new Date(at * 1000);
  const base = `${WEEKDAY.format(d)}, ${MONTH.format(d)} ${ordinal(d.getDate())}`;
  return d.getFullYear() === new Date(now * 1000).getFullYear()
    ? base
    : `${base}, ${d.getFullYear()}`;
}

/**
 * The thread summary's trailing phrase.
 *
 * Coarse on purpose: a summary row is glanced at, and "3 hours ago" answers
 * "is this still moving" — the only question being asked — where a wall-clock
 * time would make the reader do the subtraction.
 */
export function formatThreadSummaryLastReplyTime(
  at: number,
  now: number = nowSeconds(),
): string {
  const seconds = Math.max(0, Math.round(now - at));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `on ${formatShortMonthDayOrdinal(at)}`;
}
