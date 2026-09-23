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
  if (!Number.isFinite(new Date(after).getTime())) {
    throw new RangeError("Schedule time must be a valid timestamp");
  }
  if (!["hourly", "daily", "weekly", "monthly"].includes(cadence)) {
    throw new RangeError("Unsupported schedule cadence");
  }
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23
    || (dayOfWeek !== undefined && !Number.isInteger(dayOfWeek))
    || (dayOfMonth !== undefined && !Number.isInteger(dayOfMonth))) {
    throw new RangeError("Schedule hours and days must be finite integers");
  }
  const result = (date: Date) => {
    const next = date.getTime();
    if (!Number.isFinite(next) || next <= after) {
      throw new RangeError("Next schedule time is outside the supported date range");
    }
    return next;
  };
  const d = new Date(after);
  d.setUTCMinutes(0, 0, 0);
  if (cadence === "hourly") {
    d.setUTCHours(d.getUTCHours() + 1);
    return result(d);
  }
  d.setUTCHours(hourUtc);
  if (cadence === "daily") {
    while (d.getTime() <= after) d.setUTCDate(d.getUTCDate() + 1);
    return result(d);
  }
  if (cadence === "weekly") {
    const target = ((dayOfWeek ?? 1) % 7 + 7) % 7;
    while (d.getUTCDay() !== target || d.getTime() <= after) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!Number.isFinite(d.getTime())) {
        throw new RangeError("Next schedule time is outside the supported date range");
      }
    }
    return result(d);
  }
  // monthly — clamp to 1..28 so every month works.
  const dom = Math.min(Math.max(dayOfMonth ?? 1, 1), 28);
  d.setUTCDate(dom);
  while (d.getTime() <= after) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(dom);
  }
  return result(d);
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
