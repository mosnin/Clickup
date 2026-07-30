import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT,
  componentIdFromWidgetId,
  componentWidgetId,
  describeComponent,
  fieldsFor,
  normalizeComponent,
  shapesFor,
} from "../src/lib/ui-components";

// Components as data. The properties that matter:
//
//  1. **The vocabulary is closed.** An agent authors these, so anything not in
//     the enumerated set must be dropped rather than passed through — this is
//     a security boundary, not a formatting preference.
//  2. **Normalization is total.** A definition that can't be rendered degrades
//     to one that can; a panel that throws takes a whole screen with it.
//  3. **A definition reads back in words**, because a panel you can't audit is
//     a panel you shouldn't have let something else write.

describe("the closed vocabulary", () => {
  it("drops a source, shape, group or sort it has never heard of", () => {
    const def = normalizeComponent({
      from: "shell_exec",
      shape: "iframe",
      group: "arbitrary",
      sort: "; DROP TABLE",
    });
    expect(def.from).toBe(DEFAULT_COMPONENT.from);
    expect(def.shape).toBe("list");
    expect(def.group).toBe("none");
    expect(def.sort).toBe("manual");
  });

  it("keeps only fields the chosen source actually has", () => {
    const def = normalizeComponent({
      from: "tasks",
      fields: ["status", "excerpt", "due", "../../etc/passwd"],
    });
    // "excerpt" belongs to pages, not tasks.
    expect(def.fields).toEqual(["status", "due"]);
  });

  it("drops duplicate fields, because a column appears once", () => {
    expect(
      normalizeComponent({ fields: ["due", "due", "status"] }).fields,
    ).toEqual(["due", "status"]);
  });

  it("keeps priorities in a canonical order rather than the caller's", () => {
    const def = normalizeComponent({
      filter: { priority: ["low", "urgent", "nonsense"] },
    });
    expect(def.filter.priority).toEqual(["urgent", "low"]);
  });

  it("bounds the row count, because a panel is a glance", () => {
    expect(normalizeComponent({ limit: 5000 }).limit).toBe(50);
    expect(normalizeComponent({ limit: 0 }).limit).toBe(1);
    expect(normalizeComponent({ limit: "many" }).limit).toBe(
      DEFAULT_COMPONENT.limit,
    );
  });

  it("truncates a title rather than letting it own the screen", () => {
    expect(normalizeComponent({ title: "x".repeat(200) }).title).toHaveLength(
      60,
    );
    expect(normalizeComponent({ title: "   " }).title).toBe(
      DEFAULT_COMPONENT.title,
    );
  });
});

describe("degrading rather than throwing", () => {
  it("resolves from nothing at all", () => {
    expect(normalizeComponent(undefined)).toEqual(DEFAULT_COMPONENT);
    expect(normalizeComponent(null)).toEqual(DEFAULT_COMPONENT);
    expect(normalizeComponent("a string")).toEqual(DEFAULT_COMPONENT);
  });

  it("falls back within the source when a shape doesn't fit it", () => {
    // A pages panel asked for "board" should become a pages list — not a task
    // list, which is what falling back to the global default would give.
    const def = normalizeComponent({ from: "pages", shape: "board" });
    expect(def.from).toBe("pages");
    expect(def.shape).toBe("list");
  });

  it("only ever emits a shape its source supports", () => {
    for (const from of ["tasks", "pages", "agents", "activity"] as const) {
      for (const shape of ["list", "table", "cards", "metric", "board"]) {
        const def = normalizeComponent({ from, shape });
        expect(shapesFor(from)).toContain(def.shape);
      }
    }
  });

  it("only ever emits fields its source has", () => {
    for (const from of ["tasks", "pages", "agents", "activity"] as const) {
      const keys = fieldsFor(from).map((f) => f.key);
      const def = normalizeComponent({
        from,
        fields: ["status", "excerpt", "spend", "when", "made-up"],
      });
      for (const key of def.fields) expect(keys).toContain(key);
    }
  });
});

describe("reading a definition back", () => {
  it("says what the panel shows in words", () => {
    const said = describeComponent(
      normalizeComponent({
        from: "tasks",
        shape: "list",
        filter: { status: "open", assignee: "me", due: "overdue" },
        group: "priority",
      }),
    );
    expect(said).toContain("tasks as a list");
    expect(said).toContain("assigned to me");
    expect(said).toContain("due overdue");
    expect(said).toContain("grouped by priority");
  });

  it("describes a metric by what it measures", () => {
    expect(
      describeComponent(
        normalizeComponent({ shape: "metric", metric: "completion" }),
      ),
    ).toContain("What share is complete");
  });
});

describe("living in a layout", () => {
  it("round-trips a component id through a widget id", () => {
    expect(componentIdFromWidgetId(componentWidgetId("abc123"))).toBe("abc123");
  });

  it("reports null for a built-in, so the two never collide", () => {
    expect(componentIdFromWidgetId("progress")).toBeNull();
    expect(componentIdFromWidgetId("lists")).toBeNull();
  });
});
