import { describe, expect, it } from "vitest";
import { computeNextRunAt } from "../convex/scheduledTasks";

// Monday 2026-07-13 10:30 UTC.
const MON_1030 = Date.UTC(2026, 6, 13, 10, 30);

describe("computeNextRunAt", () => {
  it("daily: next occurrence strictly after `after`", () => {
    // 09:00 already passed today → tomorrow 09:00.
    expect(computeNextRunAt(MON_1030, "daily", 9)).toBe(
      Date.UTC(2026, 6, 14, 9),
    );
    // 12:00 still ahead today.
    expect(computeNextRunAt(MON_1030, "daily", 12)).toBe(
      Date.UTC(2026, 6, 13, 12),
    );
  });

  it("weekly: lands on the requested weekday", () => {
    // Monday 09:00 already passed → next Monday.
    expect(computeNextRunAt(MON_1030, "weekly", 9, 1)).toBe(
      Date.UTC(2026, 6, 20, 9),
    );
    // Wednesday this week.
    expect(computeNextRunAt(MON_1030, "weekly", 9, 3)).toBe(
      Date.UTC(2026, 6, 15, 9),
    );
  });

  it("monthly: clamps day-of-month into 1..28 and rolls forward", () => {
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 1)).toBe(
      Date.UTC(2026, 7, 1, 9),
    );
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 28)).toBe(
      Date.UTC(2026, 6, 28, 9),
    );
    // 31 → clamped to 28 so February always works.
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 31)).toBe(
      Date.UTC(2026, 6, 28, 9),
    );
  });

  it("always returns a strictly future time", () => {
    for (const cadence of ["daily", "weekly", "monthly"] as const) {
      const next = computeNextRunAt(MON_1030, cadence, 10, 1, 13);
      expect(next).toBeGreaterThan(MON_1030);
    }
  });
});
