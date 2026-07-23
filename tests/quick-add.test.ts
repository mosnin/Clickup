import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../src/lib/quick-add";

// Fixed clock: Wednesday, 2026-01-14 15:30 local time.
const NOW = new Date(2026, 0, 14, 15, 30);
const day = (d: number, m = 0, y = 2026) => new Date(y, m, d).getTime();

describe("parseQuickAdd", () => {
  it("passes plain titles through untouched", () => {
    const p = parseQuickAdd("Write the launch post", NOW);
    expect(p.title).toBe("Write the launch post");
    expect(p.dueDate).toBeUndefined();
    expect(p.priority).toBeUndefined();
    expect(p.matched).toEqual([]);
  });

  it("parses !priority anywhere and strips it", () => {
    const p = parseQuickAdd("Fix login !urgent before demo", NOW);
    expect(p.priority).toBe("urgent");
    expect(p.title).toBe("Fix login before demo");
  });

  it("parses today and tomorrow", () => {
    expect(parseQuickAdd("Ship it today", NOW).dueDate).toBe(day(14));
    expect(parseQuickAdd("Ship it tomorrow", NOW).dueDate).toBe(day(15));
    expect(parseQuickAdd("Ship it tmr", NOW).dueDate).toBe(day(15));
  });

  it("parses bare weekdays as the next occurrence", () => {
    // NOW is Wednesday Jan 14; friday = Jan 16, wednesday = Jan 21 (next).
    expect(parseQuickAdd("Review deck friday", NOW).dueDate).toBe(day(16));
    expect(parseQuickAdd("Standup wednesday", NOW).dueDate).toBe(day(21));
  });

  it("parses next <weekday> and next week", () => {
    expect(parseQuickAdd("Plan next friday", NOW).dueDate).toBe(day(16));
    // next week = next Monday (Jan 19)
    expect(parseQuickAdd("Kickoff next week", NOW).dueDate).toBe(day(19));
  });

  it("parses in N days / weeks", () => {
    expect(parseQuickAdd("Follow up in 3 days", NOW).dueDate).toBe(day(17));
    expect(parseQuickAdd("Check back in 2 weeks", NOW).dueDate).toBe(day(28));
  });

  it("absorbs on/by/due prefixes", () => {
    const p = parseQuickAdd("Send invoice by friday", NOW);
    expect(p.dueDate).toBe(day(16));
    expect(p.title).toBe("Send invoice");
  });

  it("combines date and priority", () => {
    const p = parseQuickAdd("Ship the deck tomorrow !high", NOW);
    expect(p.title).toBe("Ship the deck");
    expect(p.dueDate).toBe(day(15));
    expect(p.priority).toBe("high");
    expect(p.matched).toHaveLength(2);
  });

  it("does not match inside words", () => {
    // "Sundays" contains "sunday" but is not a standalone token.
    const p = parseQuickAdd("Write about lazy Sundays", NOW);
    expect(p.dueDate).toBeUndefined();
    expect(p.title).toBe("Write about lazy Sundays");
  });

  it("only consumes the first date phrase", () => {
    const p = parseQuickAdd("Move friday standup to tomorrow", NOW);
    // "friday" matches first (pattern order scans the string), one date only.
    expect(p.dueDate).toBeDefined();
    expect((p.title.match(/friday|tomorrow/gi) ?? []).length).toBe(1);
  });

  it("dueDate is local midnight", () => {
    const p = parseQuickAdd("x tomorrow", NOW);
    const d = new Date(p.dueDate!);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
