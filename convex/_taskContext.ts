// Everything an agent needs to know before touching a task, in one answer.
//
// Assembling context is currently four round trips — packets, decisions in
// force, open revisions, what previous runs did — and the ORDER they are read
// in, and what gets dropped when there is too much, is each runtime's private
// guess. That guess is most of the difference between a good agent runtime and
// a bad one, which makes it exactly the wrong thing to leave to the runtime.
// The dispatcher already computes a context load and a version fingerprint per
// assignment; that logic belongs to the task, where the pull path can use it
// too.
//
// This module is the part with judgement in it: what order, and what to drop.
// Pure, so both are testable without a database.
//
// **Order is a claim about consequences, not about size.** The sections are
// ranked by what it costs to have missed them. Getting the readiness verdict
// wrong means working on a task you were not cleared for; missing an open
// revision means confidently redoing work somebody has already asked you to
// change; violating a standing decision wastes the entire run and produces
// something that has to be reverted. Not knowing what a previous run tried is
// the mildest — you repeat some work. So that is the order, and it is the
// reverse of the order they would fall in if sorted by how interesting they
// look.
//
// **What is dropped is NAMED.** This is the property the whole budget exists
// for. An agent handed a silently truncated context believes it has the whole
// picture and acts with unearned confidence; an agent told "3 packets omitted,
// 14k tokens" knows to ask for them, work narrowly, or refuse. Silent
// truncation is worse than no budget at all.
//
// **Never-trimmed sections are never trimmed, even when they do not fit.** A
// budget small enough to exclude the readiness verdict is a budget that is
// wrong, and honouring it would mean answering a question about safety by
// omitting the safety information. It comes back over budget, and says so.

/** Roughly four characters per token. Good enough to budget with. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ContextSectionKey =
  | "readiness"
  | "revisions"
  | "decisions"
  | "packets"
  | "outcomes";

/**
 * Relevance order, worst-to-miss first. See the note above — this is the one
 * decision this module exists to make on every runtime's behalf.
 */
export const SECTION_ORDER: ContextSectionKey[] = [
  "readiness",
  "revisions",
  "decisions",
  "packets",
  "outcomes",
];

/**
 * The sections that survive any budget.
 *
 * Small, and their absence is dangerous rather than merely inconvenient: an
 * agent that does not know it is unready, or does not know a change was
 * requested, does the wrong work confidently. Trimming these to fit would be
 * optimising the wrong thing.
 */
export const NEVER_TRIMMED: ContextSectionKey[] = ["readiness", "revisions"];

export type ContextItem = {
  /** Stable id within its section, so an agent can ask for one back. */
  id: string;
  /** What it is, for the omission notice. */
  label: string;
  tokens: number;
  /** The payload. Opaque here; the caller builds it. */
  value: unknown;
};

export type ContextSection = {
  key: ContextSectionKey;
  items: ContextItem[];
};

export type Omission = {
  section: ContextSectionKey;
  /** How many items of this section did not fit. */
  count: number;
  tokens: number;
  /** Their ids, so asking for them back is possible rather than a guess. */
  ids: string[];
};

export type TrimResult = {
  sections: { key: ContextSectionKey; items: ContextItem[] }[];
  omitted: Omission[];
  tokens: number;
  /** True when the never-trimmed sections alone exceeded the budget. */
  overBudget: boolean;
};

/**
 * Fit the sections into a token budget, worst-to-miss first.
 *
 * Trims from the BOTTOM of the relevance order and, within a section, drops
 * the later items — sections arrive already ordered by their own notion of
 * recency or importance, so "later" is "less relevant" by the time it gets
 * here. Partial sections are the point rather than an accident: three of eight
 * decisions plus a note saying five were dropped beats zero decisions, and
 * beats eight decisions that blew the budget.
 *
 * `budget` of `undefined` means no budget — everything, no omissions. That is
 * the default, because a runtime that has not thought about its budget should
 * get the complete answer rather than one this module guessed at.
 */
export function trimToBudget(
  sections: ContextSection[],
  budget?: number,
): TrimResult {
  const ordered = SECTION_ORDER.map(
    (key) => sections.find((s) => s.key === key) ?? { key, items: [] },
  );

  if (budget === undefined || budget <= 0) {
    return {
      sections: ordered,
      omitted: [],
      tokens: ordered.reduce(
        (n, s) => n + s.items.reduce((m, i) => m + i.tokens, 0),
        0,
      ),
      overBudget: false,
    };
  }

  // The floor: everything that cannot be dropped, taken first and in full.
  let spent = 0;
  const kept = new Map<ContextSectionKey, ContextItem[]>();
  for (const section of ordered) {
    if (!NEVER_TRIMMED.includes(section.key)) continue;
    kept.set(section.key, section.items);
    spent += section.items.reduce((n, i) => n + i.tokens, 0);
  }
  const overBudget = spent > budget;

  const omitted: Omission[] = [];
  for (const section of ordered) {
    if (NEVER_TRIMMED.includes(section.key)) continue;
    const take: ContextItem[] = [];
    const drop: ContextItem[] = [];
    for (const item of section.items) {
      // Once over budget nothing further is taken — including a small item
      // that would have squeezed in. Taking whatever happens to fit would make
      // the answer depend on item order in a way nobody asked for, and would
      // quietly reorder relevance by size.
      if (drop.length === 0 && spent + item.tokens <= budget) {
        take.push(item);
        spent += item.tokens;
      } else {
        drop.push(item);
      }
    }
    kept.set(section.key, take);
    if (drop.length > 0) {
      omitted.push({
        section: section.key,
        count: drop.length,
        tokens: drop.reduce((n, i) => n + i.tokens, 0),
        ids: drop.map((i) => i.id),
      });
    }
  }

  return {
    sections: ordered.map((s) => ({
      key: s.key,
      items: kept.get(s.key) ?? [],
    })),
    omitted,
    tokens: spent,
    overBudget,
  };
}

/**
 * The omission notice, in one sentence.
 *
 * Written to be read by something deciding what to do next, so it leads with
 * the instruction rather than the arithmetic. An empty list returns null
 * rather than a reassuring sentence — "nothing was omitted" is a claim, and a
 * caller that renders a claim on every response teaches its reader to skip it.
 */
export function describeOmissions(
  omitted: Omission[],
  overBudget: boolean,
): string | null {
  if (omitted.length === 0 && !overBudget) return null;
  const parts = omitted.map(
    (o) => `${o.count} ${o.section} (~${o.tokens} tokens)`,
  );
  const head =
    parts.length > 0
      ? `Context was trimmed to your budget: ${parts.join(", ")} omitted. Ask for them by id with get_task_context and a larger budget if the work depends on them.`
      : "";
  const tail = overBudget
    ? "Your budget was smaller than the context that cannot be omitted (readiness and open revisions), so this response exceeds it. Raise the budget."
    : "";
  return [head, tail].filter(Boolean).join(" ");
}
