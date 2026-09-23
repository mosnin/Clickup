import { describe, expect, it } from "vitest";
import { computeNextRunAt, projectOccurrences } from "../convex/_recurringCalendar";

const base = { enabled: true, nextRunAt: Date.UTC(2026, 8, 22, 9), cadence: "daily" as const, hourUtc: 9 };
describe("recurring calendar projections", () => {
  it("rejects invalid schedule values instead of looping or returning invalid dates", () => {
    expect(() => computeNextRunAt(base.nextRunAt, "weekly", 9, 1.5)).toThrow(/finite integers/);
    expect(() => computeNextRunAt(base.nextRunAt, "weekly", 9, Infinity)).toThrow(/finite integers/);
    expect(() => computeNextRunAt(base.nextRunAt, "daily", NaN)).toThrow(/finite integers/);
    expect(() => computeNextRunAt(Infinity, "daily", 9)).toThrow(/valid timestamp/);
    expect(() => computeNextRunAt(8640000000000000, "weekly", 9, 1)).toThrow(/supported date range/);
  });
  it("uses a half-open window and includes an occurrence exactly at its start", () => {
    const start = base.nextRunAt;
    expect(projectOccurrences(base, start, start + 3 * 86400000)).toEqual([start, start + 86400000, start + 2 * 86400000]);
  });
  it("does not predict paused schedules or dates before the first run", () => {
    expect(projectOccurrences({ ...base, enabled: false }, base.nextRunAt, base.nextRunAt + 86400000)).toEqual([]);
    expect(projectOccurrences(base, base.nextRunAt - 86400000, base.nextRunAt)).toEqual([]);
  });
  it("skips years of missed slots without creating historical catch-up records", () => {
    const start = Date.UTC(2030, 0, 1);
    expect(projectOccurrences(base, start, start + 86400000)).toEqual([start + 9 * 3600000]);
  });
  it("keeps UTC times across DST transitions", () => {
    const start = Date.UTC(2026, 10, 1);
    const result = projectOccurrences(base, start, start + 3 * 86400000);
    expect(result.map(t => new Date(t).getUTCHours())).toEqual([9, 9, 9]);
  });
  it("uses the worker monthly clamping policy and rejects unbounded ranges", () => {
    const start = Date.UTC(2027, 1, 1);
    expect(projectOccurrences({ ...base, cadence: "monthly", dayOfMonth: 31 }, start, Date.UTC(2027, 2, 1))).toEqual([Date.UTC(2027, 1, 28, 9)]);
    expect(() => projectOccurrences(base, 0, 63 * 86400000)).toThrow(/62 days/);
    expect(() => projectOccurrences(base, NaN, 1)).toThrow();
  });
});
