import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OBLIGATION_KIND,
  isStale,
  sortObligations,
  summarize,
  waitedFor,
  type ObligationKind,
} from "../src/lib/obligations";

// Does the queue still read as ONE system?
//
// Six sources arrived one iteration at a time, each correct on its own. That is
// exactly the condition under which a surface stops being coherent without any
// single change being wrong: the approval gate and the agent handback both
// showed the same task, under different verbs, with different buttons — and the
// approval button lifted the gate WITHOUT applying the completion, so a person
// clicking it believed they had approved work that then sat unapplied.
//
// These tests are the check that stayed behind. They are deliberately about
// wiring rather than behaviour: a seventh kind added without copy, without a
// glyph, or without a branch in the row is invisible in review and obvious
// here.

const KINDS: ObligationKind[] = [
  "approval",
  "revision",
  "question",
  "outcome",
  "handback",
  "stuck",
];

const inbox = readFileSync(
  path.join(process.cwd(), "src/app/dashboard/inbox/inbox-view.tsx"),
  "utf8",
);
const backend = readFileSync(
  path.join(process.cwd(), "convex/obligations.ts"),
  "utf8",
);

describe("every kind is fully wired", () => {
  it("has copy", () => {
    for (const kind of KINDS) {
      expect(OBLIGATION_KIND[kind]?.label, kind).toBeTruthy();
      expect(OBLIGATION_KIND[kind]?.verb, kind).toBeTruthy();
    }
  });

  it("declares exactly the kinds the type allows", () => {
    // The map is `Record<ObligationKind, …>`, so TypeScript catches a missing
    // entry. It cannot catch an EXTRA one left behind by a rename, which then
    // renders a label nothing can ever produce.
    expect(Object.keys(OBLIGATION_KIND).sort()).toEqual([...KINDS].sort());
  });

  it("has its own glyph", () => {
    // Every row used to wear a shield, which is what six sources gathered one
    // at a time look like when nobody stands back afterwards.
    for (const kind of KINDS) {
      expect(inbox, kind).toMatch(new RegExp(`\\b${kind}:\\s*\\w`));
    }
  });

  it("is produced by the backend", () => {
    for (const kind of KINDS) {
      expect(backend, kind).toContain(`kind: "${kind}"`);
    }
  });
});

describe("the queue's own rules survived six sources", () => {
  it("still sorts oldest first", () => {
    const rows = [
      { kind: "stuck" as const, id: "c", title: "", href: "", createdAt: 300 },
      { kind: "approval" as const, id: "a", title: "", href: "", createdAt: 100 },
      { kind: "handback" as const, id: "b", title: "", href: "", createdAt: 200 },
    ];
    // The ordering rule is the queue's whole claim, and it is kind-blind on
    // purpose: a handback that has waited three days outranks an approval
    // raised a minute ago, whatever anybody thinks of the two categories.
    expect(sortObligations(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("counts staleness across every kind", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const row = (createdAt: number, id: string) => ({
      kind: "approval" as const,
      id,
      title: "",
      href: "",
      createdAt,
    });
    const old = row(now - 3 * 24 * 60 * 60 * 1000, "old");
    const fresh = row(now - 60_000, "fresh");
    expect(isStale(old.createdAt, now)).toBe(true);
    expect(isStale(fresh.createdAt, now)).toBe(false);
    expect(summarize([old, fresh], now).stale).toBe(1);
  });

  it("says how long, not when", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    // "has this been ignored" is the question somebody acts on; a timestamp
    // makes them do that arithmetic themselves.
    expect(waitedFor(now - 3 * 24 * 60 * 60 * 1000, now)).toMatch(/3d/);
  });
});

describe("one thing waiting is one row", () => {
  it("suppresses the gate when a handback represents it", () => {
    // The behaviour is proven end-to-end in pending-effects.test.ts; this
    // pins the REASON in the place somebody would delete it from, because the
    // suppression looks like an optimisation and is not — the two rows carry
    // different buttons and only one of them completes the task.
    expect(backend).toContain("tasksWithPendingHandback");
    // Applied in both walks. The count is a separate pass, and a badge that
    // says 2 when one thing is waiting is the same bug wearing a number.
    expect(backend.match(/tasksWithPendingHandback\(/g)?.length).toBe(3);
  });
});

// ── The task's own page ──
//
// The queue is not the only place a person meets these states, and for the two
// that BLOCK it is not even the likely one: somebody opening a task an agent
// finished yesterday, or a task no agent will touch, arrives at the task page.
// Both looked completely ordinary there — which is the same unreachability the
// boot paths had, wearing the other costume.

const collab = readFileSync(
  path.join(process.cwd(), "src/components/dashboard/task-collab.tsx"),
  "utf8",
);

describe("the task page shows what the backend knows", () => {
  it("surfaces a completion waiting on a human", () => {
    expect(collab).toContain("pendingEffects.forTask");
    // The agent's own account, not just the fact of it. Approving without it
    // means re-doing the work to find out what you are approving.
    expect(collab).toContain("handback.reason");
  });

  it("surfaces a hold, and offers the release", () => {
    expect(collab).toContain("thrashHeldAt");
    expect(collab).toContain("clearThrashHold");
    // A held task is withheld from the dispatcher, so on its own page it looks
    // like ordinary open work nobody is picking up. Saying nothing is how a
    // person concludes the fleet is broken.
    expect(collab).toContain("attempts_exhausted");
  });

  it("does not offer the gate Approve while a handback is outstanding", () => {
    // The queue bug, living on in a second place: tasks.approve lifts the gate
    // WITHOUT applying the agent's completion, so a person clicking it would
    // believe they had approved work that then sat unapplied.
    expect(collab).toMatch(/!task\.approvedAt && !handback/);
  });
});
