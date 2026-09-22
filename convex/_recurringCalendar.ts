// Shared deterministic UTC recurrence arithmetic. No database or browser dependencies.
export type Cadence = "hourly" | "daily" | "weekly" | "monthly";

// Next occurrence of the schedule strictly after `after`.
export function computeNextRunAt(
  after: number,
  cadence: Cadence,
  hourUtc: number,
  dayOfWeek?: number,
  dayOfMonth?: number,
): number {
  const d = new Date(after);
  d.setUTCMinutes(0, 0, 0);
  if (cadence === "hourly") {
    d.setUTCHours(d.getUTCHours() + 1);
    return d.getTime();
  }
  d.setUTCHours(hourUtc);
  if (cadence === "daily") {
    while (d.getTime() <= after) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  if (cadence === "weekly") {
    const target = ((dayOfWeek ?? 1) % 7 + 7) % 7;
    while (d.getUTCDay() !== target || d.getTime() <= after) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.getTime();
  }
  // monthly — clamp to 1..28 so every month works.
  const dom = Math.min(Math.max(dayOfMonth ?? 1, 1), 28);
  d.setUTCDate(dom);
  while (d.getTime() <= after) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(dom);
  }
  return d.getTime();
}

export function projectOccurrences(
  schedule: { enabled: boolean; nextRunAt: number; cadence: Cadence; hourUtc: number; dayOfWeek?: number; dayOfMonth?: number },
  start: number,
  end: number,
): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 62 * 86400000) {
    throw new Error("Calendar range must be positive and at most 62 days");
  }
  if (!schedule.enabled || !Number.isFinite(schedule.nextRunAt)) return [];
  const occurrences: number[] = [];
  let next = schedule.nextRunAt;
  // Skip missed historical slots without looping through years of downtime.
  if (next < start) next = computeNextRunAt(start - 1, schedule.cadence, schedule.hourUtc, schedule.dayOfWeek, schedule.dayOfMonth);
  while (next < end) {
    occurrences.push(next);
    next = computeNextRunAt(next, schedule.cadence, schedule.hourUtc, schedule.dayOfWeek, schedule.dayOfMonth);
  }
  return occurrences;
}
