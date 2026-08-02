// Reminders, the pure half.
//
// Presets, grouping and relative time — no React, no Convex, no clock of its
// own. Every function here takes `now` as an argument, which is the only way
// "Tomorrow at 9am" is testable at all: a function that reads `Date.now()`
// internally can be tested at 08:59 and 09:01 and give two different answers to
// the same question.
//
// Two things live here rather than being written twice.
//
//   - **The presets are shared by create and snooze** (03-workflows-projects
//     §4.2/§4.3). They are the same five choices in both places, and the moment
//     they are two lists is the moment "In 1 hour" means two different things
//     depending on which menu you opened.
//   - **`isDue` is one definition.** The badge, the grouping and the server's
//     cron all answer "has this arrived" the same way. Buzz factors this out
//     for exactly this reason: a badge that disagrees with the fire detector
//     shows a number that nothing ever clears.

/** The shape the panel renders. Structural, so nothing here imports a backend. */
export type ReminderLike = {
  reminderId: string;
  status: "pending" | "done" | "cancelled";
  /** Milliseconds, or null once the reminder is settled. */
  dueAtMs: number | null;
  note: string | null;
  target: {
    eventId: string;
    channelId: string;
    preview: string;
    authorPubkey: string;
  } | null;
  updatedAt: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * 9am on the day `offset` days from now, rolled forward if that is already
 * past.
 *
 * The roll-forward is the whole function. "Tomorrow at 9am" chosen at 08:00
 * tomorrow-morning-in-the-user's-head is 9am *tomorrow*; without the guard the
 * naive `+1 day, set 09:00` is right, but "Today at 9am" chosen at 10:00 is a
 * reminder that fires immediately — and the same arithmetic serves both.
 */
export function nextDayAt9am(now: Date, offsetDays: number): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + offsetDays);
  at.setHours(9, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** 9am on the next Monday that has not happened yet. */
export function nextMondayAt9am(now: Date): Date {
  const at = new Date(now);
  at.setHours(9, 0, 0, 0);
  // getDay(): 0 = Sunday. Days until Monday, never 0 — "next Monday" on a
  // Monday morning means the one coming, not the one you are standing in.
  const delta = (8 - at.getDay()) % 7 || 7;
  at.setDate(at.getDate() + delta);
  return at;
}

export type TimePreset = {
  id: string;
  label: string;
  at: (now: Date) => Date;
};

/** The five choices, in both the create dialog and the snooze menu. */
export const TIME_PRESETS: readonly TimePreset[] = [
  {
    id: "30m",
    label: "In 30 minutes",
    at: (now) => new Date(now.getTime() + 30 * MINUTE),
  },
  { id: "1h", label: "In 1 hour", at: (now) => new Date(now.getTime() + HOUR) },
  { id: "3h", label: "In 3 hours", at: (now) => new Date(now.getTime() + 3 * HOUR) },
  { id: "tomorrow", label: "Tomorrow at 9am", at: (now) => nextDayAt9am(now, 1) },
  { id: "monday", label: "Next Monday at 9am", at: nextMondayAt9am },
];

/** `YYYY-MM-DD` in local time — the `min` a date input needs. */
export function todayDateString(now: Date): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * A custom date + time, or null.
 *
 * Null unless both are present, both parse, and the result is **strictly in the
 * future**. The native time input has no `min`, so picking today and a time
 * that has already gone is the commonest slip there is — and without this guard
 * it produces a reminder that fires the instant it is created, which reads as a
 * bug rather than as the schedule it literally is.
 */
export function parseCustomDateTime(
  date: string,
  time: string,
  now: Date,
): Date | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  // Local time, constructed component-wise — `new Date("2029-04-02T09:00")`
  // is parsed as UTC by some engines and local by others, which is a whole
  // timezone of drift for a value a person picked off a calendar.
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  return at;
}

// ---------------------------------------------------------------------------
// Filters and grouping
// ---------------------------------------------------------------------------

/** Pending, and its time has arrived. The one definition. */
export function isDue(reminder: ReminderLike, nowMs: number): boolean {
  return (
    reminder.status === "pending" &&
    reminder.dueAtMs !== null &&
    reminder.dueAtMs <= nowMs
  );
}

export function countDue(reminders: readonly ReminderLike[], nowMs: number): number {
  return reminders.filter((r) => isDue(r, nowMs)).length;
}

export type ReminderGroup = {
  key: "overdue" | "today" | "upcoming" | "completed";
  label: string;
  reminders: ReminderLike[];
};

/**
 * Overdue / Today / Upcoming, plus Completed when asked for.
 *
 * Two exclusions that are not oversights. **Cancelled reminders are dropped
 * entirely** — cancelling is how you say "never mind", and a list that keeps
 * showing them has not honoured that. **Pending rows with no time are skipped**
 * — a pending reminder with no schedule cannot be placed in a bucket ordered by
 * time, and inventing a position for it would put it somewhere a person then
 * has to explain.
 */
export function groupReminders(
  reminders: readonly ReminderLike[],
  nowMs: number,
  includeDone = false,
): ReminderGroup[] {
  const endOfToday = (() => {
    const at = new Date(nowMs);
    at.setHours(23, 59, 59, 999);
    return at.getTime();
  })();

  const overdue: ReminderLike[] = [];
  const today: ReminderLike[] = [];
  const upcoming: ReminderLike[] = [];
  const completed: ReminderLike[] = [];

  for (const reminder of reminders) {
    if (reminder.status === "cancelled") continue;
    if (reminder.status === "done") {
      if (includeDone) completed.push(reminder);
      continue;
    }
    if (reminder.dueAtMs === null) continue;
    if (reminder.dueAtMs <= nowMs) overdue.push(reminder);
    else if (reminder.dueAtMs <= endOfToday) today.push(reminder);
    else upcoming.push(reminder);
  }

  const bySoonest = (a: ReminderLike, b: ReminderLike) =>
    (a.dueAtMs ?? 0) - (b.dueAtMs ?? 0);
  overdue.sort(bySoonest);
  today.sort(bySoonest);
  upcoming.sort(bySoonest);
  completed.sort((a, b) => b.updatedAt - a.updatedAt);

  const groups: ReminderGroup[] = [
    { key: "overdue", label: "Overdue", reminders: overdue },
    { key: "today", label: "Today", reminders: today },
    { key: "upcoming", label: "Upcoming", reminders: upcoming },
  ];
  if (includeDone) {
    groups.push({ key: "completed", label: "Completed", reminders: completed });
  }
  return groups.filter((group) => group.reminders.length > 0);
}

/**
 * "3h overdue", "in 20m".
 *
 * Deliberately not `timeAgo` from `@/lib/time`: that answers "how long ago",
 * and half of what a reminder list says is about the future. Overdue is stated
 * plainly rather than softened — a reminder you missed is the most useful row
 * on the screen, and "3h overdue" is what makes it act like one.
 */
export function formatRelativeTime(dueAtMs: number, nowMs: number): string {
  const delta = dueAtMs - nowMs;
  const past = delta < 0;
  const size = Math.abs(delta);

  if (size < MINUTE) return past ? "just now" : "in less than a minute";
  const value =
    size < HOUR
      ? `${Math.floor(size / MINUTE)}m`
      : size < DAY
        ? `${Math.floor(size / HOUR)}h`
        : `${Math.floor(size / DAY)}d`;
  return past ? `${value} overdue` : `in ${value}`;
}

/**
 * Can this reminder navigate to what it is about?
 *
 * A *present* target can still hold empty strings — the creation site writes
 * `channelId ?? ""` — so the check is on the values, not on the object. A row
 * that offers to take you somewhere and then does not is worse than one that
 * does not offer.
 */
export function hasNavigableTarget(reminder: ReminderLike): boolean {
  const target = reminder.target;
  return Boolean(
    target &&
      target.channelId.length > 0 &&
      target.eventId.length > 0 &&
      target.authorPubkey.length > 0,
  );
}

/** Where a reminder's row points. `/chat` when it points at nothing. */
export function reminderHref(reminder: ReminderLike): string {
  return hasNavigableTarget(reminder)
    ? `/chat/c/${reminder.target!.channelId}`
    : "/chat";
}

/** The line a row shows: the message it points at, or the note. */
export function reminderBody(reminder: ReminderLike): string {
  const preview = reminder.target?.preview?.trim();
  if (preview) return preview;
  return reminder.note?.trim() ?? "";
}
