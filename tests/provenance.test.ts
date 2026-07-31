import { describe, expect, it } from "vitest";
import {
  describeProvenance,
  hasRecords,
  provenanceOf,
  relevantDecisions,
} from "../src/lib/provenance";
import { normalizePanel } from "../src/lib/panel";

// Why is this number what it is?
//
// The feature exists to make a number *trustworthy*, which puts an unusual
// constraint on it: it cannot itself be a guess. Everything here is derived
// from the same objects the screen rendered, nothing is written by a model,
// and nothing is stored — an explanation that can disagree with the thing it
// explains is worse than no explanation, because people believe it.

const PANEL = normalizePanel({
  title: "Overdue",
  query: { from: "tasks", filter: { due: "overdue", assignee: "me" } },
  shape: "metric",
});

describe("the chain reads in the order the doubt arrives", () => {
  it("starts with what was asked", () => {
    const [first] = provenanceOf({ def: PANEL, total: 14, truncated: false });
    expect(first.kind).toBe("question");
    expect(first.text).toContain("overdue");
  });

  it("says how many matched", () => {
    const steps = provenanceOf({ def: PANEL, total: 14, truncated: false });
    expect(steps.some((s) => s.text.includes("14 records matched"))).toBe(true);
  });

  it("says one record rather than 1 records", () => {
    const steps = provenanceOf({ def: PANEL, total: 1, truncated: false });
    expect(steps.some((s) => s.text === "One record matched.")).toBe(true);
  });

  it("puts truncation before the count, not after it", () => {
    // A caveat under a number is a caveat nobody reads, and a count that only
    // counts what the walk reached is a number people will act on.
    const steps = provenanceOf({ def: PANEL, total: 3000, truncated: true });
    const truncated = steps.findIndex((s) => s.key === "truncated");
    const rows = steps.findIndex((s) => s.key.startsWith("row:"));
    expect(truncated).toBeGreaterThanOrEqual(0);
    expect(steps[truncated].text).toContain("not everything");
    if (rows >= 0) expect(truncated).toBeLessThan(rows);
    // And it must not also claim a clean count.
    expect(steps.some((s) => s.key === "records")).toBe(false);
  });
});

describe("the records behind the number", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    href: `/dashboard/l/l1/t/t${i}`,
  }));

  it("names a handful and says how many it did not", () => {
    const steps = provenanceOf({ def: PANEL, total: 9, truncated: false, rows });
    expect(steps.filter((s) => s.key.startsWith("row:"))).toHaveLength(5);
    expect(steps.some((s) => s.text === "and 4 more")).toBe(true);
  });

  it("links each one, because 'which fourteen' is the actual question", () => {
    const steps = provenanceOf({ def: PANEL, total: 9, truncated: false, rows });
    const row = steps.find((s) => s.key.startsWith("row:"))!;
    expect(row.href).toContain("/dashboard/l/");
  });

  it("says nothing about more when there is no more", () => {
    const steps = provenanceOf({
      def: PANEL,
      total: 2,
      truncated: false,
      rows: rows.slice(0, 2),
    });
    expect(steps.some((s) => s.key === "rows-more")).toBe(false);
  });
});

describe("the decision that shaped it", () => {
  it("links back to the plan it was settled in", () => {
    const steps = provenanceOf({
      def: PANEL,
      total: 3,
      truncated: false,
      decisions: [
        {
          question: "What counts as overdue?",
          body: "Past the due date at local midnight.",
          decidedByName: "Ada",
          projectId: "p1",
        },
      ],
    });
    const step = steps.find((s) => s.kind === "decision")!;
    expect(step.text).toContain("Ada");
    expect(step.text).toContain("What counts as overdue?");
    expect(step.href).toBe("/dashboard/p/p1/plan");
  });

  it("credits whoever wrote the panel, when it was not you", () => {
    const steps = provenanceOf({
      def: PANEL,
      total: 3,
      truncated: false,
      authoredByName: "Ada",
    });
    expect(steps.some((s) => s.kind === "author" && s.text.includes("Ada"))).toBe(
      true,
    );
  });

  it("says nothing about an author when there is nobody to credit", () => {
    const steps = provenanceOf({ def: PANEL, total: 3, truncated: false });
    expect(steps.some((s) => s.kind === "author")).toBe(false);
  });
});

describe("which decisions bear on a panel", () => {
  const decisions = [
    {
      question: "What counts as overdue for a task?",
      body: "Past its due date at local midnight, regardless of status.",
    },
    { question: "Which coffee machine?", body: "The one with the grinder." },
    { question: "Who owns the release calendar?", body: "Ada owns it." },
  ];

  it("finds the one that shares the panel's subject", () => {
    const found = relevantDecisions(PANEL, decisions);
    expect(found).toHaveLength(1);
    expect(found[0].question).toContain("overdue");
  });

  it("refuses a decision that shares exactly one word", () => {
    // The panel's subject is "big number — how many of tasks, status open,
    // assigned to me, due overdue". This shares only "tasks", which is the
    // difference between "related" and "both about work".
    const oneWord = [
      { question: "Which tasks go in the newsletter?", body: "Only launch ones." },
    ];
    expect(relevantDecisions(PANEL, oneWord)).toEqual([]);
  });

  it("never returns more than it was asked for", () => {
    // Four marginally-related decisions is noise, and noise here reads as the
    // system not knowing either.
    const many = Array.from({ length: 6 }, (_, i) => ({
      question: `What counts as overdue for tasks, case ${i}?`,
      body: "Past the due date.",
    }));
    expect(relevantDecisions(PANEL, many, 2)).toHaveLength(2);
  });

  it("returns nothing rather than a weak guess", () => {
    const unrelated = normalizePanel({
      title: "Pages",
      query: { from: "pages" },
      shape: "list",
    });
    expect(relevantDecisions(unrelated, decisions)).toEqual([]);
  });

  it("is not fooled by filler, however much of it overlaps", () => {
    // This shares "how" and "many" with the panel's description and nothing
    // else — enough to clear the threshold if filler counted as subject
    // matter, which would attach an explanation to every number on screen.
    const filler = [
      {
        question: "How many people should review a change?",
        body: "Many hands make light work.",
      },
    ];
    expect(relevantDecisions(PANEL, filler)).toEqual([]);
  });

  it("survives an empty corpus and an empty panel", () => {
    expect(relevantDecisions(PANEL, [])).toEqual([]);
    expect(() =>
      relevantDecisions(normalizePanel({}), decisions),
    ).not.toThrow();
  });
});

describe("the whole chain as one sentence", () => {
  it("keeps the shape without listing every record", () => {
    const steps = provenanceOf({
      def: PANEL,
      total: 9,
      truncated: false,
      rows: [{ id: "t1", title: "Ship the thing", href: null }],
      authoredByName: "Ada",
    });
    const text = describeProvenance(steps);
    expect(text).toContain("Asked for");
    expect(text).toContain("9 records matched");
    expect(text).toContain("Ada");
    expect(text).not.toContain("Ship the thing");
  });
});

describe("sources that have no records to point at", () => {
  it("knows activity is already the record", () => {
    expect(hasRecords(PANEL.query)).toBe(true);
    expect(hasRecords(normalizePanel({ query: { from: "activity" } }).query)).toBe(
      false,
    );
  });
});
