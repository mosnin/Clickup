import { describe, expect, it } from "vitest";
import { deelLongDate, greetingFor, totalLabel } from "../src/lib/deel-chrome";

describe("greetingFor", () => {
  it("uses Deel's 2025 home voice and the first name", () => {
    expect(greetingFor("Ada")).toBe("Hey, Ada");
  });

  it("drops the comma when there is no name", () => {
    expect(greetingFor(undefined)).toBe("Hey");
    expect(greetingFor("  ")).toBe("Hey");
  });
});

describe("deelLongDate", () => {
  it("writes day-first long month the way Deel does", () => {
    expect(deelLongDate(new Date(2026, 8, 19))).toBe("Saturday, 19 September");
  });
});

describe("totalLabel", () => {
  it("writes Deel's Total N noun line, singular at one", () => {
    expect(totalLabel(289, "person", "people")).toBe("Total 289 people");
    expect(totalLabel(1, "person", "people")).toBe("Total 1 person");
    expect(totalLabel(0, "task")).toBe("Total 0 tasks");
  });
});
