import { describe, expect, it } from "vitest";
import {
  NODE_KINDS,
  STARTER_QUESTIONS,
  describeNode,
  describePlan,
  normalizeNode,
  parentKindFor,
  planView,
  stateLabel,
  type NodeKind,
  type QuestionState,
} from "../src/lib/plan";

// A plan is a shape, not a river.
//
// Everything here defends one property: the state of a deliberation is
// DERIVED. Nobody sets "ready to decide" — it is what "every option has been
// argued and nothing has been chosen" means. A status somebody has to remember
// to update is a status that is wrong within a day, and a plan that is wrong
// about what was decided is worse than no plan.

let seq = 0;
function node(over: Partial<Record<string, unknown>> = {}) {
  seq += 1;
  return {
    id: `n${seq}`,
    kind: "question",
    parentId: null,
    body: `body ${seq}`,
    authorType: "user",
    authorId: "user_a",
    authorName: "Ada",
    createdAt: seq,
    ...over,
  };
}

/** A question with two options, each carrying `evidence` pieces. */
function argued(opts: {
  needsHuman?: boolean;
  evidenceA?: string[];
  evidenceB?: string[];
}) {
  const q = node({ kind: "question", needsHuman: opts.needsHuman === true });
  const a = node({ kind: "option", parentId: q.id, body: "Option A" });
  const b = node({ kind: "option", parentId: q.id, body: "Option B" });
  const evidence = [
    ...(opts.evidenceA ?? []).map((stance) =>
      node({ kind: "evidence", parentId: a.id, stance }),
    ),
    ...(opts.evidenceB ?? []).map((stance) =>
      node({ kind: "evidence", parentId: b.id, stance }),
    ),
  ];
  return { q, a, b, nodes: [q, a, b, ...evidence] };
}

describe("normalization is total", () => {
  it("survives anything at all", () => {
    for (const junk of [null, undefined, 0, "", [], { kind: {} }]) {
      expect(() => normalizeNode(junk)).not.toThrow();
      expect(NODE_KINDS).toContain(normalizeNode(junk).kind);
    }
    expect(() => planView(null)).not.toThrow();
    expect(planView("nonsense").questions).toEqual([]);
  });

  it("keeps fields only on the kind that owns them", () => {
    // An option carrying a stance, or a question carrying a chosen option, is
    // a row that would read as meaningful and mean nothing.
    const option = normalizeNode({ kind: "option", stance: "refutes" });
    expect(option.stance).toBe("neutral");
    const question = normalizeNode({ kind: "question", chosenOptionId: "x" });
    expect(question.chosenOptionId).toBeNull();
    const evidence = normalizeNode({ kind: "evidence", needsHuman: true });
    expect(evidence.needsHuman).toBe(false);
  });

  it("drops a stance it does not enumerate", () => {
    expect(normalizeNode({ kind: "evidence", stance: "vibes" }).stance).toBe(
      "neutral",
    );
  });

  it("drops a reference to a kind of thing that does not exist", () => {
    expect(normalizeNode({ ref: { kind: "database", id: "x" } }).ref).toBeNull();
    expect(normalizeNode({ ref: { kind: "task" } }).ref).toBeNull();
    expect(normalizeNode({ ref: { kind: "task", id: "t1" } })?.ref).toEqual({
      kind: "task",
      id: "t1",
    });
  });

  it("is idempotent", () => {
    const once = normalizeNode({
      id: "n1",
      kind: "evidence",
      parentId: "o1",
      body: "  the migration took 40 minutes  ",
      stance: "refutes",
      authorType: "agent",
      authorName: "Ada",
      createdAt: 5,
    });
    expect(normalizeNode(once)).toEqual(once);
  });
});

describe("what a question's state means", () => {
  const stateOf = (nodes: unknown[]): QuestionState =>
    planView(nodes).questions[0].state;

  it("is unexplored when nobody has answered", () => {
    expect(stateOf([node({ kind: "question" })])).toBe("unexplored");
  });

  it("is weighing while an option has nothing said about it", () => {
    expect(stateOf(argued({ evidenceA: ["supports"] }).nodes)).toBe("weighing");
  });

  it("is ready once every option has been argued", () => {
    // The rung the whole exercise is for: this is a queue entry, derived from
    // the shape rather than from anybody remembering to flag it.
    const { nodes } = argued({
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    expect(stateOf(nodes)).toBe("ready");
  });

  it("is decided once a decision is accepted", () => {
    const { q, a, nodes } = argued({
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    const decision = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      acceptedAt: 99,
      acceptedByName: "Ada",
    });
    expect(stateOf([...nodes, decision])).toBe("decided");
  });

  it("waits on a person when a machine decided an unaccepted question", () => {
    // The same consent shape as approval gates and panel proposals. Nothing in
    // this product lets an agent close a gate a human raised.
    const { q, a, nodes } = argued({
      needsHuman: true,
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    const proposed = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      authorType: "agent",
      authorName: "Ada",
    });
    expect(stateOf([...nodes, proposed])).toBe("awaiting");
  });

  it("reads the newest decision when a question was reopened", () => {
    const { q, a, b, nodes } = argued({
      evidenceA: ["supports"],
      evidenceB: ["supports"],
    });
    const first = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      acceptedAt: 50,
      createdAt: 50,
    });
    const second = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: b.id,
      acceptedAt: 90,
      createdAt: 90,
    });
    const view = planView([...nodes, first, second]);
    expect(view.questions[0].decision?.chosenOptionId).toBe(b.id);
    expect(view.questions[0].options.find((o) => o.chosen)?.node.id).toBe(b.id);
  });
});

describe("retraction keeps the history and leaves the derivation", () => {
  it("ignores a retracted option", () => {
    // "We thought X, then learned better" is the most useful thing a plan
    // holds, so a superseded node is retracted rather than deleted — and a
    // retracted one must not still be counted as an unargued option.
    const { q, b, nodes } = argued({ evidenceA: ["supports"] });
    const retracted = nodes.map((n) =>
      n.id === b.id ? { ...n, retractedAt: 10 } : n,
    );
    const view = planView(retracted);
    expect(view.questions[0].options).toHaveLength(1);
    expect(view.questions[0].state).toBe("ready");
    void q;
  });

  it("reopens a question when its decision is retracted", () => {
    const { q, a, nodes } = argued({
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    const decision = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      acceptedAt: 99,
      retractedAt: 120,
    });
    expect(planView([...nodes, decision]).questions[0].state).toBe("ready");
  });

  it("keeps what was taken back where somebody can read it", () => {
    // The storage decision is only worth something if the history is
    // reachable. It was not, for a while — the model excluded retracted
    // nodes from everything including the view, so "still readable in the
    // history of its question" was a comment describing nothing.
    const { q, b, nodes } = argued({ evidenceA: ["supports"] });
    const retracted = nodes.map((n) =>
      n.id === b.id ? { ...n, retractedAt: 10 } : n,
    );
    const view = planView(retracted);
    expect(view.questions[0].retracted).toHaveLength(1);
    expect(view.questions[0].retracted[0].id).toBe(b.id);
    // And still out of the derivation.
    expect(view.questions[0].options).toHaveLength(1);
    void q;
  });

  it("files a retracted option's evidence under the option, not the question", () => {
    const { q, a, nodes } = argued({ evidenceA: ["supports"] });
    const gutted = nodes.map((n) =>
      n.id === a.id || n.parentId === a.id ? { ...n, retractedAt: 10 } : n,
    );
    // Only the option itself hangs off the question; its evidence hangs off
    // it, or the history reads as a pile.
    expect(planView(gutted).questions[0].retracted.map((r) => r.id)).toEqual([
      a.id,
    ]);
    void q;
  });

  it("ignores retracted evidence when deciding whether an option was argued", () => {
    const { a, nodes } = argued({ evidenceA: ["supports"], evidenceB: ["supports"] });
    const gutted = nodes.map((n) =>
      n.parentId === a.id && n.kind === "evidence"
        ? { ...n, retractedAt: 10 }
        : n,
    );
    expect(planView(gutted).questions[0].state).toBe("weighing");
  });
});

describe("weight is a shape, not a verdict", () => {
  it("counts each way separately and reports the difference", () => {
    const { a, nodes } = argued({
      evidenceA: ["supports", "supports", "refutes", "neutral"],
      evidenceB: ["refutes"],
    });
    const option = planView(nodes).questions[0].options.find(
      (o) => o.node.id === a.id,
    )!;
    expect(option.supports).toBe(2);
    expect(option.refutes).toBe(1);
    expect(option.weight).toBe(1);
    // Neutral evidence still counts as having been argued — it just does not
    // push either way. Otherwise "here is a relevant fact" would leave the
    // option looking untouched.
    expect(option.evidence).toHaveLength(4);
  });
});

describe("a plan is read in the order it should be acted on", () => {
  it("puts what is waiting on you above what is merely being thought about", () => {
    // Built oldest-first in the OPPOSITE order to the one expected, so a sort
    // that fell back to creation time would pass this by accident. It did,
    // once.
    const thinking = argued({ evidenceA: ["supports"] });
    const untouched = node({ kind: "question", body: "nobody has looked" });
    const waiting = argued({
      needsHuman: true,
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    const proposed = node({
      kind: "decision",
      parentId: waiting.q.id,
      chosenOptionId: waiting.a.id,
      authorType: "agent",
    });

    const view = planView([
      ...thinking.nodes,
      untouched,
      ...waiting.nodes,
      proposed,
    ]);
    expect(view.questions.map((q) => q.state)).toEqual([
      "awaiting",
      "weighing",
      "unexplored",
    ]);
  });

  it("puts the more recently touched of equals first", () => {
    // Three questions in the same state whose activity order matches neither
    // creation order nor its reverse, so a sort that quietly fell back to
    // creation time cannot pass by luck.
    const built = [
      { created: 1, touched: 300 },
      { created: 2, touched: 100 },
      { created: 3, touched: 200 },
    ].map(({ created, touched }) => {
      const q = node({ kind: "question", createdAt: created });
      // One option, no evidence — "weighing" for all three.
      const o = node({ kind: "option", parentId: q.id, createdAt: touched });
      return { q, nodes: [q, o] };
    });

    const view = planView(built.flatMap((b) => b.nodes));
    expect(view.questions.map((q) => q.state)).toEqual([
      "weighing",
      "weighing",
      "weighing",
    ]);
    expect(view.questions.map((q) => q.node.id)).toEqual([
      built[0].q.id,
      built[2].q.id,
      built[1].q.id,
    ]);
  });

  it("separates what is open from what is settled", () => {
    const open = argued({});
    const closed = argued({ evidenceA: ["supports"], evidenceB: ["supports"] });
    const decision = node({
      kind: "decision",
      parentId: closed.q.id,
      chosenOptionId: closed.a.id,
      acceptedAt: 99,
    });
    const view = planView([...open.nodes, ...closed.nodes, decision]);
    expect(view.open).toHaveLength(1);
    expect(view.settled).toHaveLength(1);
    expect(view.counts.decided).toBe(1);
  });

  it("tracks how fresh the thinking is, including under an option", () => {
    const q = node({ kind: "question", createdAt: 1 });
    const a = node({ kind: "option", parentId: q.id, createdAt: 2 });
    const e = node({
      kind: "evidence",
      parentId: a.id,
      stance: "supports",
      createdAt: 77,
    });
    expect(planView([q, a, e]).questions[0].lastActivityAt).toBe(77);
  });
});

describe("shape rules", () => {
  it("says what each kind hangs off", () => {
    // Evidence filed under a question rather than an option is evidence for
    // nothing, so this is enforced on write rather than repaired on read.
    expect(parentKindFor("question")).toBeNull();
    expect(parentKindFor("option")).toBe("question");
    expect(parentKindFor("decision")).toBe("question");
    expect(parentKindFor("evidence")).toBe("option");
  });

  it("drops an orphan rather than inventing a home for it", () => {
    const stray = node({ kind: "option", parentId: "does-not-exist" });
    expect(planView([stray]).questions).toEqual([]);
  });
});

describe("it reads back in words", () => {
  it("summarizes a plan by what needs doing", () => {
    const waiting = argued({
      needsHuman: true,
      evidenceA: ["supports"],
      evidenceB: ["refutes"],
    });
    const proposed = node({
      kind: "decision",
      parentId: waiting.q.id,
      chosenOptionId: waiting.a.id,
      authorType: "agent",
    });
    const text = describePlan(planView([...waiting.nodes, proposed]));
    expect(text).toContain("1 waiting on you");
  });

  it("says so when nothing has been raised", () => {
    expect(describePlan(planView([]))).toContain("No questions");
  });

  it("describes every kind of node without throwing", () => {
    for (const kind of NODE_KINDS as NodeKind[]) {
      const text = describeNode(normalizeNode({ kind, body: "the thing" }));
      expect(text.length, kind).toBeGreaterThan(0);
      expect(text, kind).toContain("the thing");
    }
  });

  it("tells a proposed decision from a settled one", () => {
    const proposed = describeNode(
      normalizeNode({ kind: "decision", body: "go with A" }),
    );
    const settled = describeNode(
      normalizeNode({ kind: "decision", body: "go with A", acceptedAt: 5 }),
    );
    expect(proposed).not.toBe(settled);
    expect(proposed).toContain("proposed");
  });

  it("names every state in words", () => {
    for (const state of [
      "unexplored",
      "weighing",
      "ready",
      "awaiting",
      "decided",
    ] as QuestionState[]) {
      expect(stateLabel(state).length, state).toBeGreaterThan(0);
    }
  });
});

describe("the empty plan teaches by offering the thing", () => {
  it("offers questions that are real questions, not tutorial steps", () => {
    // Each has to be worth keeping after it has done its teaching job,
    // otherwise the first thing a plan holds is something to delete.
    expect(STARTER_QUESTIONS.length).toBeGreaterThan(2);
    for (const q of STARTER_QUESTIONS) {
      expect(q.body.trim().length, q.body).toBeGreaterThan(10);
      expect(q.body.endsWith("?"), q.body).toBe(true);
    }
  });

  it("reserves the ones that are genuinely a person's call", () => {
    // "What are we not doing" is a scope decision; a machine proposing one is
    // fine, a machine closing one is not.
    expect(STARTER_QUESTIONS.some((q) => q.needsHuman)).toBe(true);
    expect(STARTER_QUESTIONS.some((q) => !q.needsHuman)).toBe(true);
  });

  it("produces a real question when taken", () => {
    const view = planView(
      STARTER_QUESTIONS.map((q, i) =>
        node({ kind: "question", body: q.body, needsHuman: q.needsHuman, createdAt: i }),
      ),
    );
    expect(view.questions).toHaveLength(STARTER_QUESTIONS.length);
    for (const q of view.questions) expect(q.state).toBe("unexplored");
  });
});
