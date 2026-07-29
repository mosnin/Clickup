// Reference tokens: `#[Label](kind:id)`.
//
// The third member of the token family, alongside `@[Name](actorId)` for
// mentions and `[[Page title]]` for pages. Deliberately the same shape as a
// mention so there is one thing to learn and one thing to parse: a visible
// label, and a target in the parentheses.
//
// Why inline in the body rather than a separate table: a message is prose,
// and "which project were we talking about" is answered by reading the
// sentence. Storing the reference only in a join table means the sentence
// stops making sense if the join is dropped. The resolved set IS denormalized
// onto messages.refs, but only as a convenience for agents — the body stays
// the source of truth.
//
// Pure — no ctx, no imports — so the Convex functions and the client can both
// use it.

export const REF_KINDS = [
  "project",
  "list",
  "task",
  "page",
  "sprint",
  "goal",
] as const;

export type RefKind = (typeof REF_KINDS)[number];

export type Ref = { kind: RefKind; id: string; label: string };

const REF = /#\[([^\]\n]+)\]\(([a-z]+):([^)\s]+)\)/g;

function isRefKind(value: string): value is RefKind {
  return (REF_KINDS as readonly string[]).includes(value);
}

/** Every reference token in a body, in order, deduplicated by kind+id. */
export function extractRefs(body: string): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const m of body.matchAll(REF)) {
    const label = m[1].trim();
    const kind = m[2];
    const id = m[3].trim();
    if (!label || !id || !isRefKind(kind)) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id, label });
  }
  return out;
}

/** The token to write into a body. */
export function formatRef(kind: RefKind, id: string, label: string): string {
  // A label containing brackets or parens would break out of the token, and
  // there is no escaping in this grammar by design.
  return `#[${label.replace(/[[\]()]/g, "")}](${kind}:${id})`;
}

/**
 * Body reduced to the words, for previews and notification bodies.
 *
 * Mentions and references collapse to their labels; page links to their
 * titles. `@[Ada](u1) look at #[Billing](project:p1)` reads as
 * "@Ada look at Billing", which is what a notification should say.
 */
export function bodyToText(body: string): string {
  return body
    .replace(REF, "$1")
    .replace(/@\[([^\]\n]+)\]\([^)\s]+\)/g, "@$1")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One-line preview for a channel rail row. */
export function bodyPreview(body: string, max = 120): string {
  const text = bodyToText(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
