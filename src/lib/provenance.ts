import { describeQuery, type DataQuery } from "@/lib/data-stream";
import { describePanel, type PanelDef } from "@/lib/panel";

// Why is this number what it is?
//
// The question every dashboard provokes and none of them answer. You read "14
// overdue" and you have three thoughts in order: which fourteen, who decided
// what counts as overdue, and can I trust it. Everywhere else those cost a
// conversation. Here they cost a click, and the reason is architectural rather
// than clever:
//
//   - the panel is a **definition**, so the question it asked is readable
//   - the answer is an **envelope**, so the records behind it are enumerable
//   - the rule that shaped it is a **plan decision**, so the argument is
//     retrievable and signed
//
// No other system has all three as inspectable data, which is why nobody else
// can do this. It is not a feature bolted on; it is what falls out.
//
// **Every layer is derived, never narrated.** There is no stored explanation
// to go stale, and nothing here is written by a model — the chain is computed
// from the same objects the screen already rendered. An explanation that can
// disagree with the thing it explains is worse than no explanation, because
// people believe it.

/** One step in the answer to "why is this what it is". */
export type ProvenanceStep = {
  /** Stable key, for tests and for keying a list. */
  key: string;
  /** What kind of thing this step is about, for the UI to draw it. */
  kind: "question" | "records" | "rule" | "decision" | "author";
  /** One line, in the product's words. */
  text: string;
  /** Where to go to see it for yourself. Null when the step is the panel. */
  href: string | null;
};

export type ProvenanceInput = {
  def: PanelDef;
  /** What the resolver actually returned. */
  total: number;
  truncated: boolean;
  /** Rows behind the number, when the shape had any. */
  rows?: { id: string; title: string; href: string | null }[];
  /** Who wrote the definition, when it was not the reader. */
  authoredByName?: string | null;
  /** Decisions whose subject matches this panel's question. */
  decisions?: {
    question: string;
    body: string;
    decidedByName: string;
    projectId: string;
  }[];
};

/**
 * The chain, from the number back to the argument.
 *
 * Ordered the way the doubt actually arrives: what was asked, what answered,
 * what shaped it, who said so. Truncation is a step of its own rather than a
 * footnote — a number that only counts what the walk reached is a number
 * people will act on, and it has to say so where the acting happens.
 */
export function provenanceOf(input: ProvenanceInput): ProvenanceStep[] {
  const steps: ProvenanceStep[] = [];

  steps.push({
    key: "question",
    kind: "question",
    text: `Asked for ${describeQuery(input.def.query)}.`,
    href: null,
  });

  if (input.truncated) {
    // Before the count, not after it. A caveat under a number is a caveat
    // nobody reads.
    steps.push({
      key: "truncated",
      kind: "records",
      text: `Counted the first ${input.total} it reached, not everything that matches. Narrow it to see the rest.`,
      href: null,
    });
  } else {
    steps.push({
      key: "records",
      kind: "records",
      text:
        input.total === 1
          ? "One record matched."
          : `${input.total} records matched.`,
      href: null,
    });
  }

  for (const row of (input.rows ?? []).slice(0, 5)) {
    steps.push({
      key: `row:${row.id}`,
      kind: "records",
      text: row.title,
      href: row.href,
    });
  }
  const extra = (input.rows ?? []).length - 5;
  if (extra > 0) {
    steps.push({
      key: "rows-more",
      kind: "records",
      text: `and ${extra} more`,
      href: null,
    });
  }

  for (const decision of input.decisions ?? []) {
    steps.push({
      key: `decision:${decision.question}`,
      kind: "decision",
      text: `${decision.decidedByName} settled "${decision.question}" — ${decision.body}`,
      href: `/dashboard/p/${decision.projectId}/plan`,
    });
  }

  if (input.authoredByName) {
    steps.push({
      key: "author",
      kind: "author",
      text: `This panel was written by ${input.authoredByName}.`,
      href: null,
    });
  }

  return steps;
}

/**
 * Which settled decisions plausibly bear on this panel.
 *
 * Plain word overlap against the panel's own description, and deliberately
 * nothing cleverer. A model asked "which decision explains this number" would
 * produce a confident sentence nobody can check, in the one place where being
 * wrong is worst — the feature exists to make a number *trustworthy*, so it
 * cannot itself be a guess. Overlap is dumb, visibly dumb, and either matches
 * or does not.
 *
 * The threshold is deliberately mean. A provenance panel listing four
 * marginally-related decisions is noise, and noise here reads as the system
 * not knowing either.
 */
export function relevantDecisions<
  T extends { question: string; body: string },
>(def: PanelDef, decisions: T[], limit = 2): T[] {
  const subject = new Set(words(describePanel(def)));
  if (subject.size === 0) return [];

  return decisions
    .map((d) => {
      const theirs = new Set(words(`${d.question} ${d.body}`));
      let shared = 0;
      for (const word of theirs) if (subject.has(word)) shared += 1;
      return { d, shared };
    })
    .filter((s) => s.shared >= 2)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map((s) => s.d);
}

/** Words worth matching on — the short and the ubiquitous carry nothing. */
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "how",
  "are",
  "was",
  "were",
  "our",
  "their",
  "from",
  "into",
  "over",
  "than",
  "them",
  "they",
  "does",
  "should",
  "would",
  "could",
  "have",
  "has",
  "not",
  "any",
  "all",
  "one",
  "two",
  "who",
  "when",
  "where",
  "which",
  "will",
  "can",
  "its",
  "his",
  "her",
  "look",
  "like",
  "some",
  "more",
  "most",
  "much",
  "many",
  "everything",
  "something",
  "anything",
  "nothing",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** The whole chain as one sentence, for a tooltip or an agent's read. */
export function describeProvenance(steps: ProvenanceStep[]): string {
  return steps
    .filter((s) => s.kind !== "records" || s.key === "records" || s.key === "truncated")
    .map((s) => s.text)
    .join(" ");
}

/** Does this panel's question even have records to point at? */
export function hasRecords(query: DataQuery): boolean {
  return query.from !== "activity";
}
