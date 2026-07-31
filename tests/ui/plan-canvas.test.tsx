import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DashboardShell, calls, queryResults, resetHarness } from "./harness";

// The plan canvas, driven.
//
// `plan.test.ts` proves the derivation and `plans-backend.test.ts` proves the
// writes. Neither can tell you whether pressing "Offer an answer" reaches
// `plans.addOption` with the right question id — and "the right mutation with
// the wrong id" has been the shape of several bugs here.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { PlanCanvas } = await import("@/components/dashboard/plan-canvas");

let seq = 0;
function node(over: Record<string, unknown> = {}) {
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
    needsHuman: false,
    stance: "neutral",
    chosenOptionId: null,
    acceptedAt: null,
    acceptedByName: null,
    ref: null,
    retractedAt: null,
    ...over,
  };
}

function show(nodes: unknown[]) {
  queryResults["plans.forProject"] = nodes;
  render(
    <DashboardShell>
      <PlanCanvas projectId="p1" />
    </DashboardShell>,
  );
}

/**
 * Type into the in-place create and commit it.
 *
 * `InlineCreate` is a form whose Enter submits, so a keyDown does nothing in
 * jsdom — which is a fact about jsdom, not about the component. Submitting the
 * form is the honest equivalent of pressing Enter.
 */
function write(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest("form")!);
}

beforeEach(() => {
  resetHarness();
  seq = 0;
});

describe("what it says before anything is written", () => {
  it("shows a skeleton while the plan is loading, not an empty plan", () => {
    // "Nothing has been raised yet" while data is in flight is a lie that
    // reads as a broken feature.
    render(
      <DashboardShell>
        <PlanCanvas projectId="p1" />
      </DashboardShell>,
    );
    expect(screen.queryByText(/Nothing has been raised yet/)).toBeNull();
  });

  it("explains itself when the plan is genuinely empty", () => {
    show([]);
    expect(screen.getByText(/Nothing has been raised yet/)).toBeTruthy();
  });
});

describe("raising a question", () => {
  it("sends the body and the gate together", () => {
    // `needsHuman` is set at the moment of asking because that is when you
    // know whether the call is yours — a separate step later would be a
    // separate thing to forget.
    show([]);
    fireEvent.click(screen.getByText("Raise a question"));
    fireEvent.click(screen.getByText("A person has to settle this one"));
    write("Do we ship on Friday?");

    expect(calls("plans.ask")).toEqual([
      { projectId: "p1", body: "Do we ship on Friday?", needsHuman: true },
    ]);
  });

  it("defaults to a question anyone can settle", () => {
    show([]);
    fireEvent.click(screen.getByText("Raise a question"));
    write("Which queue?");
    expect(
      (calls("plans.ask")[0] as { needsHuman: boolean }).needsHuman,
    ).toBe(false);
  });
});

describe("a question being worked out", () => {
  it("shows its derived state rather than a stored one", () => {
    const q = node({ kind: "question" });
    show([q]);
    expect(screen.getByText("Nobody has answered this yet")).toBeTruthy();
  });

  it("moves to ready once every option has been argued", () => {
    const q = node({ kind: "question", body: "Which queue?" });
    const a = node({ kind: "option", parentId: q.id, body: "SQS" });
    const e = node({
      kind: "evidence",
      parentId: a.id,
      body: "already in the stack",
      stance: "supports",
    });
    show([q, a, e]);
    expect(screen.getByText("Ready to decide")).toBeTruthy();
    expect(screen.getByText("1 for · 0 against")).toBeTruthy();
  });

  it("offers an answer against the question it is under", () => {
    const q = node({ kind: "question", body: "Which queue?" });
    show([q]);
    fireEvent.click(screen.getByText("Offer an answer"));
    write("SQS");
    expect(calls("plans.addOption")).toEqual([
      { questionId: q.id, body: "SQS" },
    ]);
  });

  it("files evidence against the option it bears on, with its stance", () => {
    // The rule the backend enforces and the UI has to honour: evidence hangs
    // off an option, never off a question.
    const q = node({ kind: "question", body: "Which queue?" });
    const a = node({ kind: "option", parentId: q.id, body: "SQS" });
    show([q, a]);
    fireEvent.click(screen.getByText("− against"));
    write("no FIFO guarantee");
    expect(calls("plans.addEvidence")).toEqual([
      { optionId: a.id, body: "no FIFO guarantee", stance: "refutes" },
    ]);
  });

  it("settles it on the option that was chosen", () => {
    const q = node({ kind: "question", body: "Which queue?" });
    const a = node({ kind: "option", parentId: q.id, body: "SQS" });
    show([q, a]);
    fireEvent.click(screen.getByText("go with this"));
    write("already in the stack");
    expect(calls("plans.decide")).toEqual([
      { questionId: q.id, chosenOptionId: a.id, body: "already in the stack" },
    ]);
  });
});

describe("a decision a machine made", () => {
  function awaiting() {
    const q = node({
      kind: "question",
      body: "Do we ship on Friday?",
      needsHuman: true,
    });
    const a = node({ kind: "option", parentId: q.id, body: "Yes" });
    const d = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      body: "All checks pass",
      authorType: "agent",
      authorName: "Ada",
      acceptedAt: null,
    });
    show([q, a, d]);
    return { q, a, d };
  }

  it("reads as waiting on you, not as settled", () => {
    awaiting();
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText(/thinks this is settled/)).toBeTruthy();
  });

  it("accepts it", () => {
    const { d } = awaiting();
    fireEvent.click(screen.getByText("Agreed"));
    expect(calls("plans.acceptDecision")).toEqual([{ decisionId: d.id }]);
  });

  it("sets it aside by retracting, which is also how reopening works", () => {
    const { d } = awaiting();
    fireEvent.click(screen.getByText("Not yet"));
    expect(calls("plans.retract")).toEqual([{ nodeId: d.id }]);
  });
});

describe("a settled question", () => {
  function settled() {
    const q = node({ kind: "question", body: "Which queue?" });
    const a = node({ kind: "option", parentId: q.id, body: "SQS" });
    const e = node({
      kind: "evidence",
      parentId: a.id,
      body: "already in the stack",
      stance: "supports",
    });
    const d = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      body: "SQS then",
      acceptedAt: 99,
      acceptedByName: "Ada",
    });
    show([q, a, e, d]);
    return { q, a, d };
  }

  it("collapses to one line, under Settled", () => {
    // The compression the whole surface exists for: ninety per cent of a
    // mature plan is settled, and the working must not crowd out what is open.
    settled();
    expect(screen.getByText("Settled")).toBeTruthy();
    // The evidence is not on screen until asked for.
    expect(screen.queryByText("already in the stack")).toBeNull();
  });

  it("shows the working when opened", () => {
    settled();
    const row = screen.getByText("Which queue?").closest("button")!;
    fireEvent.click(row);
    expect(screen.getByText("already in the stack")).toBeTruthy();
  });

  it("reopens by retracting the decision", () => {
    const { d } = settled();
    fireEvent.click(screen.getByText("Which queue?").closest("button")!);
    fireEvent.click(screen.getByText("Reopen this"));
    expect(calls("plans.retract")).toEqual([{ nodeId: d.id }]);
  });
});

describe("what is open comes before what is settled", () => {
  it("puts the thing waiting on you at the top", () => {
    const open = node({ kind: "question", body: "OPEN QUESTION" });
    const q = node({ kind: "question", body: "CLOSED QUESTION" });
    const a = node({ kind: "option", parentId: q.id, body: "yes" });
    const d = node({
      kind: "decision",
      parentId: q.id,
      chosenOptionId: a.id,
      body: "done",
      acceptedAt: 99,
    });
    show([q, a, d, open]);

    const body = document.body.textContent ?? "";
    expect(body.indexOf("OPEN QUESTION")).toBeLessThan(
      body.indexOf("CLOSED QUESTION"),
    );
  });

  it("summarizes the whole plan in one sentence", () => {
    const q = node({ kind: "question" });
    show([q]);
    expect(screen.getByText(/1 untouched/)).toBeTruthy();
  });
});

describe("who said it", () => {
  it("marks an agent's contribution as an agent's", () => {
    // A plan where you cannot tell which reasoning came from a machine is a
    // plan you cannot weigh.
    const q = node({
      kind: "question",
      body: "Which queue?",
      authorType: "agent",
      authorName: "Ada",
    });
    show([q]);
    const article = screen.getByText("Which queue?").closest("article")!;
    expect(within(article).getByText(/Ada/)).toBeTruthy();
  });
});

describe("what was taken back is readable", () => {
  it("is hidden by default and reachable in one click", () => {
    // The storage decision — retract, never delete — was worth nothing while
    // nothing rendered it. `unretract` existed on the backend and could not
    // be reached from anywhere in the app.
    const q = node({ kind: "question", body: "Which queue?" });
    const gone = node({
      kind: "option",
      parentId: q.id,
      body: "Kafka, actually impossible",
      retractedAt: 50,
    });
    show([q, gone]);

    expect(screen.queryByText("Kafka, actually impossible")).toBeNull();
    fireEvent.click(screen.getByText("1 taken back"));
    expect(screen.getByText("Kafka, actually impossible")).toBeTruthy();
  });

  it("puts one back", () => {
    const q = node({ kind: "question", body: "Which queue?" });
    const gone = node({
      kind: "option",
      parentId: q.id,
      body: "Kafka",
      retractedAt: 50,
    });
    show([q, gone]);
    fireEvent.click(screen.getByText("1 taken back"));
    fireEvent.click(screen.getByText("put it back"));
    expect(calls("plans.unretract")).toEqual([{ nodeId: gone.id }]);
  });

  it("says nothing when nothing was taken back", () => {
    show([node({ kind: "question", body: "Which queue?" })]);
    expect(screen.queryByText(/taken back/)).toBeNull();
  });
});
