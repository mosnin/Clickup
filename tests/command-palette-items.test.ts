import { describe, expect, it } from "vitest";
import { capCommandPaletteItems } from "../src/lib/command-palette-items";

const item = (key: string) => ({ key });

describe("command palette item cap", () => {
  it("keeps global search and quick-create visible in a large workspace", () => {
    const items = [
      ...Array.from({ length: 30 }, (_, index) => item(`result-${index}`)),
      item("search-everything"),
      item("new-task"),
    ];

    const visible = capCommandPaletteItems(items);

    expect(visible).toHaveLength(24);
    expect(visible.map(({ key }) => key)).toContain("search-everything");
    expect(visible.map(({ key }) => key)).toContain("new-task");
    expect(visible.slice(0, 22)).toEqual(items.slice(0, 22));
  });

  it("preserves a high-ranked quick-create action", () => {
    const items = [
      item("new-task"),
      ...Array.from({ length: 30 }, (_, index) => item(`result-${index}`)),
      item("search-everything"),
    ];

    const visible = capCommandPaletteItems(items);

    expect(visible[0]?.key).toBe("new-task");
    expect(visible.at(-1)?.key).toBe("search-everything");
  });

  it("leaves short result sets unchanged", () => {
    const items = [item("home"), item("search-everything"), item("new-task")];
    expect(capCommandPaletteItems(items)).toEqual(items);
  });
});
