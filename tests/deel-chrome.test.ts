import { describe, expect, it } from "vitest";
import { deelLongDate, greetingFor } from "../src/lib/deel-chrome";

describe("greetingFor", () => {
  it("uses Deel's time-of-day voice and the first name", () => {
    expect(greetingFor("Ada", new Date("2026-09-19T08:00:00"))).toBe(
      "Good morning, Ada",
    );
    expect(greetingFor("Ada", new Date("2026-09-19T14:00:00"))).toBe(
      "Good afternoon, Ada",
    );
    expect(greetingFor("Ada", new Date("2026-09-19T19:00:00"))).toBe(
      "Good evening, Ada",
    );
  });

  it("drops the comma when there is no name", () => {
    expect(greetingFor(undefined, new Date("2026-09-19T08:00:00"))).toBe(
      "Good morning",
    );
    expect(greetingFor("  ", new Date("2026-09-19T08:00:00"))).toBe(
      "Good morning",
    );
  });
});

describe("deelLongDate", () => {
  it("writes day-first long month the way Deel does", () => {
    expect(deelLongDate(new Date(2026, 8, 19))).toBe("Saturday, 19 September");
  });
});
