import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY,
  QUERY_VOCABULARY,
  bucketFor,
  dateFieldFor,
  describeQuery,
  dimensionsFor,
  fillDateBuckets,
  measuresFor,
  normalizeQuery,
  sortPoints,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
  unitFor,
  windowStart,
  type Dimension,
  type SourceKind,
} from "../src/lib/data-stream";

// The query model every component reads through.
//
// Two properties carry this file. **The vocabulary is closed** — agents author
// these definitions, so anything the normalizer will not emit is something the
// resolver never has to have a branch for, and a query that cannot be run must
// degrade to one that can rather than throw. **A query means one thing**: the
// same definition always describes the same question, so a stored panel does
// not quietly change what it shows when someone adds an option.

describe("normalization is total", () => {
  it("survives anything at all", () => {
    for (const junk of [
      null,
      undefined,
      0,
      "",
      [],
      { from: "; DROP TABLE tasks" },
      { filter: "not an object" },
      { dimension: {}, measure: [] },
    ]) {
      expect(() => normalizeQuery(junk)).not.toThrow();
      const q = normalizeQuery(junk);
      expect(QUERY_VOCABULARY.sources).toContain(q.from);
      expect(QUERY_VOCABULARY.measures).toContain(q.measure);
      expect(QUERY_VOCABULARY.dimensions).toContain(q.dimension);
    }
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeQuery({
      from: "time",
      dimension: "assignee",
      measure: "time_logged",
      limit: 999,
      filter: { search: "  hello  ", priority: ["high", "nope"] },
    });
    expect(normalizeQuery(once)).toEqual(once);
  });

  it("clamps the row budget — a panel is a glance, not a report", () => {
    expect(normalizeQuery({ limit: 10_000 }).limit).toBe(60);
    expect(normalizeQuery({ limit: -5 }).limit).toBe(1);
    expect(normalizeQuery({ limit: 2.7 }).limit).toBe(3);
  });

  it("refuses ids that are not plain ids", () => {
    // The resolver looks these up by id. Anything with structure in it is a
    // definition trying to be something other than a lookup.
    for (const bad of ["../../etc", "a b", "x';--", "<script>", "a.b"]) {
      const q = normalizeQuery({
        dimension: "custom_field",
        dimensionFieldId: bad,
      });
      expect(q.dimensionFieldId, bad).toBe("");
    }
    const ok = normalizeQuery({
      dimension: "custom_field",
      dimensionFieldId: "kg2abc_XY-9",
    });
    expect(ok.dimensionFieldId).toBe("kg2abc_XY-9");
  });
});

describe("a source only gets the vocabulary it can answer", () => {
  it("falls back within the source rather than to the global default", () => {
    // A pages panel asked to group by priority must become a pages panel
    // grouped by something pages have — not a task panel.
    const q = normalizeQuery({ from: "pages", dimension: "priority" });
    expect(q.from).toBe("pages");
    expect(dimensionsFor("pages")).toContain(q.dimension);
    expect(q.dimension).not.toBe("priority");
  });

  it("refuses a measure the source cannot compute", () => {
    const q = normalizeQuery({ from: "pages", measure: "time_logged" });
    expect(measuresFor("pages")).toContain(q.measure);
  });

  it("falls back to the source's own first measure, not the global default", () => {
    // The distinction is real here in a way it is not for dimensions (every
    // source's dimension list starts with "none", which is also the global
    // default). A time panel asked for an impossible measure must become a
    // time panel measuring time — falling back to the global "count" would
    // silently turn "hours logged per person" into "number of time entries",
    // which is a different question with a plausible-looking answer.
    const q = normalizeQuery({ from: "time", measure: "overdue" });
    expect(q.measure).toBe(measuresFor("time")[0]);
    expect(q.measure).toBe("time_logged");
    expect(unitFor(q.measure)).toBe("hours");
  });

  it("offers every source a dimension and a measure", () => {
    for (const source of QUERY_VOCABULARY.sources as readonly SourceKind[]) {
      expect(dimensionsFor(source).length, source).toBeGreaterThan(0);
      expect(measuresFor(source).length, source).toBeGreaterThan(0);
      // "none" has to be available or a source could not be listed plainly.
      expect(dimensionsFor(source), source).toContain("none");
    }
  });
});

describe("the breakdown", () => {
  it("is dropped when it equals the dimension", () => {
    // Splitting each bucket by the thing that defined the bucket gives every
    // stack exactly one segment — a plain chart wearing a legend.
    const q = normalizeQuery({
      from: "tasks",
      dimension: "status",
      breakdown: "status",
    });
    expect(q.breakdown).toBe("none");
  });

  it("survives when it is genuinely a second axis", () => {
    const q = normalizeQuery({
      from: "tasks",
      dimension: "assignee",
      breakdown: "status",
    });
    expect(q.dimension).toBe("assignee");
    expect(q.breakdown).toBe("status");
  });
});

describe("field ids are only carried where they mean something", () => {
  it("drops a dimension field id when the dimension is not a field", () => {
    const q = normalizeQuery({ dimension: "status", dimensionFieldId: "abc" });
    expect(q.dimensionFieldId).toBe("");
  });

  it("drops a measure field id when the measure is not a field", () => {
    const q = normalizeQuery({ measure: "count", measureFieldId: "abc" });
    expect(q.measureFieldId).toBe("");
  });

  it("keeps them when they are referenced", () => {
    const q = normalizeQuery({
      from: "tasks",
      dimension: "custom_field",
      dimensionFieldId: "fld1",
      measure: "custom_field_sum",
      measureFieldId: "fld2",
    });
    expect(q.dimensionFieldId).toBe("fld1");
    expect(q.measureFieldId).toBe("fld2");
  });
});

describe("a scope is a pair", () => {
  it("drops half a scope rather than selecting everything or nothing", () => {
    expect(normalizeQuery({ filter: { scopeToId: "abc" } }).filter.scopeToKind).toBe("");
    expect(normalizeQuery({ filter: { scopeToId: "abc" } }).filter.scopeToId).toBe("");
    expect(normalizeQuery({ filter: { scopeToKind: "list" } }).filter.scopeToId).toBe("");
    expect(
      normalizeQuery({ filter: { scopeToKind: "list" } }).filter.scopeToKind,
    ).toBe("");
  });

  it("keeps a whole one", () => {
    const q = normalizeQuery({
      filter: { scopeToKind: "project", scopeToId: "p1" },
    });
    expect(q.filter.scopeToKind).toBe("project");
    expect(q.filter.scopeToId).toBe("p1");
  });
});

describe("units", () => {
  it("names what one unit of each measure means", () => {
    expect(unitFor("completion_rate")).toBe("percent");
    expect(unitFor("time_logged")).toBe("hours");
    expect(unitFor("estimate_sum")).toBe("points");
    expect(unitFor("spend")).toBe("currency");
    expect(unitFor("count")).toBe("count");
  });
});

describe("date buckets are the reader's dates, not UTC's", () => {
  it("floors to local midnight, week and month", () => {
    const at = new Date(2026, 4, 14, 17, 42, 3).getTime(); // Thu 14 May 2026
    expect(new Date(startOfLocalDay(at)).getHours()).toBe(0);
    // Monday-based: a sprint week is not a calendar week.
    expect(new Date(startOfLocalWeek(at)).getDay()).toBe(1);
    expect(new Date(startOfLocalMonth(at)).getDate()).toBe(1);
  });

  it("routes each date dimension to its own field", () => {
    expect(dateFieldFor("due_week")).toBe("due");
    expect(dateFieldFor("created_month")).toBe("created");
    expect(dateFieldFor("completed_day")).toBe("completed");
    expect(dateFieldFor("assignee")).toBeNull();
    expect(dateFieldFor("none")).toBeNull();
  });

  it("buckets at the granularity the dimension names", () => {
    const at = new Date(2026, 4, 14, 17, 42).getTime();
    expect(bucketFor("created_day", at)).toBe(startOfLocalDay(at));
    expect(bucketFor("created_week", at)).toBe(startOfLocalWeek(at));
    expect(bucketFor("created_month", at)).toBe(startOfLocalMonth(at));
  });
});

describe("empty buckets are a real answer", () => {
  const now = new Date(2026, 4, 14).getTime();

  it("fills the gaps so a line does not lie about its slope", () => {
    const day = 86_400_000;
    const start = startOfLocalDay(now - 4 * day);
    const points = [
      { key: String(start), label: "a", value: 3 },
      { key: String(start + 3 * day), label: "d", value: 5 },
    ];
    const filled = fillDateBuckets(points, "created_day", now);
    expect(filled.length).toBeGreaterThanOrEqual(4);
    // The two real readings survive, and what was missing is zero.
    expect(filled[0].value).toBe(3);
    expect(filled[1].value).toBe(0);
    expect(filled[2].value).toBe(0);
    expect(filled[3].value).toBe(5);
  });

  it("leaves non-date dimensions alone — there is no missing assignee", () => {
    const points = [{ key: "a", label: "Ada", value: 2 }];
    expect(fillDateBuckets(points, "assignee", now)).toEqual(points);
    expect(fillDateBuckets(points, "none", now)).toEqual(points);
  });

  it("refuses to fill unboundedly", () => {
    const points = [
      { key: String(startOfLocalDay(0)), label: "", value: 1 },
      { key: String(startOfLocalDay(now)), label: "", value: 1 },
    ];
    expect(fillDateBuckets(points, "created_day", now).length).toBeLessThanOrEqual(60);
  });

  it("does nothing with nothing", () => {
    expect(fillDateBuckets([], "created_day", now)).toEqual([]);
  });
});

describe("windows", () => {
  it("reaches back the distance it names, and 'all' reaches back forever", () => {
    const now = 1_700_000_000_000;
    expect(windowStart("all", now)).toBeNull();
    expect(windowStart("7d", now)).toBe(now - 7 * 86_400_000);
    expect(windowStart("year", now)).toBe(now - 365 * 86_400_000);
    // Monotonic: a longer window never starts later than a shorter one.
    const ordered = ["7d", "30d", "90d", "year"] as const;
    for (let i = 1; i < ordered.length; i += 1) {
      expect(windowStart(ordered[i], now)!).toBeLessThan(
        windowStart(ordered[i - 1], now)!,
      );
    }
  });
});

describe("sorting", () => {
  const points = [
    { key: "b", label: "Beta", value: 2 },
    { key: "a", label: "Alpha", value: 9 },
    { key: "c", label: "Gamma", value: 5 },
  ];

  it("orders by value and by label on request", () => {
    expect(sortPoints(points, "value_desc").map((p) => p.value)).toEqual([9, 5, 2]);
    expect(sortPoints(points, "value_asc").map((p) => p.value)).toEqual([2, 5, 9]);
    expect(sortPoints(points, "label").map((p) => p.label)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("otherwise keeps the resolver's order", () => {
    // Chronological for a date dimension, workflow order for status — both
    // more meaningful than anything re-sorting could produce.
    expect(sortPoints(points, "manual")).toEqual(points);
    expect(sortPoints(points, "due")).toEqual(points);
  });

  it("never mutates its input", () => {
    const copy = [...points];
    sortPoints(points, "value_desc");
    expect(points).toEqual(copy);
  });
});

describe("a query reads back as a sentence", () => {
  it("says what it shows, so a panel someone else wrote can be audited", () => {
    const q = normalizeQuery({
      from: "tasks",
      measure: "count",
      dimension: "assignee",
      breakdown: "status",
      filter: { status: "open", assignee: "agents", due: "overdue" },
    });
    const text = describeQuery(q);
    expect(text).toContain("tasks");
    expect(text).toContain("assigned to agents");
    expect(text).toContain("due overdue");
    expect(text).toContain("by assignee");
    expect(text).toContain("split by status");
  });

  it("describes every source without throwing or trailing punctuation", () => {
    for (const from of QUERY_VOCABULARY.sources as readonly SourceKind[]) {
      const text = describeQuery(normalizeQuery({ from }));
      expect(text.length, from).toBeGreaterThan(0);
      expect(text.endsWith(","), from).toBe(false);
    }
  });

  it("says nothing about filters that are not set", () => {
    // An unset filter is not a clause. A sentence that recites every default
    // is one nobody reads, and it makes two identical panels look different.
    const text = describeQuery(
      normalizeQuery({
        from: "tasks",
        filter: { status: "any", due: "any", window: "all", assignee: "anyone" },
      }),
    );
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\bstatus any\b/);
    expect(text).not.toMatch(/\bdue any\b/);
    expect(text).not.toMatch(/\blast all\b/);
    expect(text).toBe("how many of tasks");
  });
});

describe("every dimension is labelled", () => {
  it("has a human name, so no control ever reads as a slug", () => {
    for (const d of QUERY_VOCABULARY.dimensions as readonly Dimension[]) {
      const q = normalizeQuery({ from: "tasks", dimension: d });
      expect(describeQuery(q)).not.toContain("_");
    }
  });
});
