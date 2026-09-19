import { describe, expect, it } from "vitest";
import { deelLongDate, greetingFor } from "../src/lib/deel-chrome";

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
