// Deliberation as a place, not a transcript.
//
// The failure this replaces is specific and it gets worse the more agents you
// add. Thinking currently lives in channels — an append-only, time-ordered
// river of messages. A river has no *state*: to answer "where did we land on
// the auth question" you re-read it, and an agent joining at hour three reads
// two hundred messages and gets it wrong. Every participant pays the cost of
// reconstructing the same small answer, repeatedly, from something enormous.
//
// But a deliberation does have a shape, and the shape is tiny compared to the
// conversation that produced it: what don't we know, what could be true, what
// do we actually know, what did we settle. Four things. So make the shape the
// artifact and let the transcript be the audit trail underneath it rather than
// the interface.
//
// **The vocabulary is four kinds and closed, for the same reason panel
// definitions are closed: agents write into it.** A free-form canvas of boxes
// is unparseable, so nothing can reason over it — which defeats the point of
// having it. Four kinds:
//
//   question   — something undecided
//   option     — a candidate answer to a question
//   evidence   — a fact bearing on an option, with a stance
//   decision   — a question settled, naming the option chosen
//
// Notably absent: a task. Tasks already exist, and a plan that carries its own
// would be a second source of truth about the same work. A decision *links* to
// the tasks it produced.
//
// **Every status here is derived, never typed.** A question with no options is
// one nobody has thought about; a question whose options all carry evidence and
// has no decision is one somebody should decide *now*. That ladder is the
// entire value: it turns "read the thread" into "here are the three decisions
// waiting on you". A status somebody has to remember to set is a status that is
// wrong within a day.
//
// **An agent may propose a decision; a person accepts it.** Same consent shape
// as approval gates, layout proposals and panel proposals, for the same reason
// — the whole product refuses to let a machine close a question a human said
// they wanted to close.

export type NodeKind = "question" | "option" | "evidence" | "decision";

/** Which way a piece of evidence cuts. */
export type Stance = "supports" | "refutes" | "neutral";

/** Something real a node points at, so a plan links back into the work. */
export type PlanRef = {
  kind: "task" | "page" | "list" | "project" | "run";
  id: string;
} | null;

export type PlanNode = {
  id: string;
  kind: NodeKind;
  /** Questions hang off nothing; options off questions; evidence off options. */
  parentId: string | null;
  body: string;
  authorType: "user" | "agent" | "system";
  authorId: string;
  authorName: string;
  createdAt: number;
  /** Questions only: this one may not be closed by a machine. */
  needsHuman: boolean;
  /** Evidence only. */
  stance: Stance;
  /** Decisions only: which option won. */
  chosenOptionId: string | null;
  /** Decisions only: unset means proposed and waiting on a person. */
  acceptedAt: number | null;
  acceptedByName: string | null;
  ref: PlanRef;
  /**
   * Retracted rather than deleted.
   *
   * "We thought X, then learned better" is the most useful thing a plan holds
   * and deleting destroys it. A retracted node is out of every derivation and
   * still readable in the history of its question.
   */
  retractedAt: number | null;
};

export const NODE_KINDS: NodeKind[] = [
  "question",
  "option",
  "evidence",
  "decision",
];
export const STANCES: Stance[] = ["supports", "refutes", "neutral"];
export const REF_KINDS = ["task", "page", "list", "project", "run"] as const;

const MAX_BODY = 600;

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function text(value: unknown, max = MAX_BODY): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRef(input: unknown): PlanRef {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const kind = REF_KINDS.find((k) => k === raw.kind);
  const id = text(raw.id, 64);
  if (!kind || !id) return null;
  return { kind, id };
}

/**
 * Coerce a stored row into a node.
 *
 * Total, like every normalizer here. Nodes arrive from a person, from an agent
 * over MCP, and from rows written by older builds; one that cannot be read must
 * degrade rather than throw. A plan that fails to load is worse than a plan
 * with one odd node in it.
 */
export function normalizeNode(input: unknown): PlanNode {
  const raw = (input ?? {}) as Record<string, unknown>;
  const kind = pick(raw.kind, NODE_KINDS, "question");
  return {
    id: text(raw.id, 64),
    kind,
    parentId: text(raw.parentId, 64) || null,
    body: text(raw.body),
    authorType: pick(raw.authorType, ["user", "agent", "system"] as const, "user"),
    authorId: text(raw.authorId, 64),
    authorName: text(raw.authorName, 80) || "Someone",
    createdAt: stamp(raw.createdAt) ?? 0,
    needsHuman: kind === "question" && raw.needsHuman === true,
    stance: kind === "evidence" ? pick(raw.stance, STANCES, "neutral") : "neutral",
    chosenOptionId:
      kind === "decision" ? text(raw.chosenOptionId, 64) || null : null,
    acceptedAt: kind === "decision" ? stamp(raw.acceptedAt) : null,
    acceptedByName:
      kind === "decision" ? text(raw.acceptedByName, 80) || null : null,
    ref: normalizeRef(raw.ref),
    retractedAt: stamp(raw.retractedAt),
  };
}

// ── The derived view ────────────────────────────────────────────────────

/**
 * Where a question stands.
 *
 * A ladder, and each rung says what to do next — which is what makes this an
 * interface rather than a record. `ready` and `awaiting` are the two worth the
 * whole exercise: they are the queue.
 */
export type QuestionState =
  /** Nobody has offered an answer. */
  | "unexplored"
  /** Options exist, but at least one has nothing said about it. */
  | "weighing"
  /** Every option has been argued. Somebody should decide. */
  | "ready"
  /** A machine decided, and a person said they wanted to. */
  | "awaiting"
  | "decided";

export type OptionView = {
  node: PlanNode;
  evidence: PlanNode[];
  supports: number;
  refutes: number;
  /** supports − refutes. Not a verdict; a shape you can see across options. */
  weight: number;
  chosen: boolean;
};

export type QuestionView = {
  node: PlanNode;
  options: OptionView[];
  /** The live decision, accepted or proposed. */
  decision: PlanNode | null;
  state: QuestionState;
  /** Newest node anywhere under this question — how fresh the thinking is. */
  lastActivityAt: number;
};

export type PlanView = {
  questions: QuestionView[];
  /** What a person should look at, in the order they should look at it. */
  open: QuestionView[];
  settled: QuestionView[];
  counts: Record<QuestionState, number>;
};

const STATE_ORDER: QuestionState[] = [
  "awaiting",
  "ready",
  "weighing",
  "unexplored",
  "decided",
];

/**
 * Build the whole readable plan from a flat list of nodes.
 *
 * Pure, and the only place question state is decided — the UI, the agent's
 * `read_plan`, and any future watchdog all read this, so there is no way for
 * a person and a machine to disagree about whether something is settled.
 */
export function planView(input: unknown): PlanView {
  const nodes = (Array.isArray(input) ? input : []).map(normalizeNode);
  const live = nodes.filter((n) => n.retractedAt === null && n.id);

  const byParent = new Map<string, PlanNode[]>();
  for (const node of live) {
    if (!node.parentId) continue;
    const bucket = byParent.get(node.parentId);
    if (bucket) bucket.push(node);
    else byParent.set(node.parentId, [node]);
  }

  const questions: QuestionView[] = [];
  for (const q of live.filter((n) => n.kind === "question")) {
    const children = byParent.get(q.id) ?? [];
    // A question can accumulate decisions over time — reopening files a new
    // one. The newest live decision is the current answer.
    const decision =
      children
        .filter((c) => c.kind === "decision")
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

    const options: OptionView[] = children
      .filter((c) => c.kind === "option")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((option) => {
        const evidence = (byParent.get(option.id) ?? [])
          .filter((e) => e.kind === "evidence")
          .sort((a, b) => a.createdAt - b.createdAt);
        const supports = evidence.filter((e) => e.stance === "supports").length;
        const refutes = evidence.filter((e) => e.stance === "refutes").length;
        return {
          node: option,
          evidence,
          supports,
          refutes,
          weight: supports - refutes,
          chosen: decision?.chosenOptionId === option.id,
        };
      });

    const lastActivityAt = Math.max(
      q.createdAt,
      ...children.map((c) => c.createdAt),
      ...options.flatMap((o) => o.evidence.map((e) => e.createdAt)),
    );

    questions.push({
      node: q,
      options,
      decision,
      state: questionState(options, decision),
      lastActivityAt,
    });
  }

  // Most urgent first, then most recently touched — a plan is read top-down
  // and the top is where the thing you have to do belongs.
  questions.sort((a, b) => {
    const rank = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return rank !== 0 ? rank : b.lastActivityAt - a.lastActivityAt;
  });

  const counts = {
    unexplored: 0,
    weighing: 0,
    ready: 0,
    awaiting: 0,
    decided: 0,
  } as Record<QuestionState, number>;
  for (const q of questions) counts[q.state] += 1;

  return {
    questions,
    open: questions.filter((q) => q.state !== "decided"),
    settled: questions.filter((q) => q.state === "decided"),
    counts,
  };
}

function questionState(
  options: OptionView[],
  decision: PlanNode | null,
): QuestionState {
  if (decision) {
    // A decision a machine made on a question flagged for a person is a
    // proposal until they say so. Nothing else in this product lets an agent
    // close a gate a human raised, and a plan is not the exception.
    if (decision.acceptedAt === null) return "awaiting";
    return "decided";
  }
  if (options.length === 0) return "unexplored";
  if (options.some((o) => o.evidence.length === 0)) return "weighing";
  // Every option has been argued, so the next move is somebody's call. Whether
  // that somebody must be human is `needsHuman`, and it is read where a
  // decision is *made* rather than here — a question is equally ready either
  // way, and only the closing differs.
  return "ready";
}

const STATE_WORDS: Record<QuestionState, string> = {
  unexplored: "Nobody has answered this yet",
  weighing: "Being thought about",
  ready: "Ready to decide",
  awaiting: "Waiting on you",
  decided: "Settled",
};

export function stateLabel(state: QuestionState): string {
  return STATE_WORDS[state];
}

/**
 * The plan in one sentence.
 *
 * What an agent reads first and what a person sees at the top. A plan you
 * cannot summarize is a plan nobody will open.
 */
export function describePlan(view: PlanView): string {
  if (view.questions.length === 0) return "No questions have been raised yet.";
  const bits: string[] = [];
  if (view.counts.awaiting > 0) {
    bits.push(`${view.counts.awaiting} waiting on you`);
  }
  if (view.counts.ready > 0) bits.push(`${view.counts.ready} ready to decide`);
  if (view.counts.weighing > 0) {
    bits.push(`${view.counts.weighing} being worked out`);
  }
  if (view.counts.unexplored > 0) {
    bits.push(`${view.counts.unexplored} untouched`);
  }
  if (view.counts.decided > 0) bits.push(`${view.counts.decided} settled`);
  return bits.join(", ");
}

/**
 * Can this node legally hang off that one?
 *
 * Enforced on write rather than repaired on read, because unlike a panel — a
 * view somebody can shrug at — a malformed plan misrepresents what a team
 * agreed. Evidence filed under a question rather than an option is evidence
 * for nothing.
 */
export function parentKindFor(kind: NodeKind): NodeKind | null {
  switch (kind) {
    case "question":
      return null;
    case "option":
    case "decision":
      return "question";
    case "evidence":
      return "option";
  }
}

/** One node, in words — for a feed line, a notification, or an agent's read. */
export function describeNode(node: PlanNode): string {
  const who = node.authorName;
  switch (node.kind) {
    case "question":
      return `${who} asked: ${node.body}`;
    case "option":
      return `${who} offered: ${node.body}`;
    case "evidence":
      return node.stance === "refutes"
        ? `${who} argued against: ${node.body}`
        : node.stance === "supports"
          ? `${who} argued for: ${node.body}`
          : `${who} noted: ${node.body}`;
    case "decision":
      return node.acceptedAt === null
        ? `${who} proposed settling it: ${node.body}`
        : `${who} settled it: ${node.body}`;
  }
}
