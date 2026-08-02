// The rules a situation is evaluated by, on the side of the wire that
// evaluates them.
//
// `src/lib/situation.ts` is the spec and holds the reasoning; this is the same
// arithmetic where a Convex cron can reach it, because the Convex tree cannot
// import from `src/`. Two copies of a rule drift, so
// `tests/situations-backend.test.ts` imports both sides and fails the moment
// they disagree — the treatment `held` gets in `calibration.ts`, and cheaper
// than the bug.
//
// The second half of this file has no counterpart in `src/`, and could not:
// it is a description of what `convex/dataStream.ts` actually does, filter by
// filter and source by source. It lives here because it is only true of the
// code next to it.

export type Comparison = "at_least" | "at_most" | "equals";

export const COMPARISONS: readonly Comparison[] = [
  "at_least",
  "at_most",
  "equals",
];

export type Situation = {
  id: string;
  label: string;
  query: unknown;
  compare: Comparison;
  threshold: number;
};

/** See `deadBand` in `src/lib/situation.ts` — the floor matters more than the ratio. */
export function deadBand(threshold: number): number {
  if (!Number.isFinite(threshold)) return 1;
  return Math.max(1, Math.abs(threshold) * 0.1);
}

/**
 * Is this situation true, given what it measures and whether it was true
 * before?
 *
 * `wasTrue` is the whole hysteresis mechanism, which is why the subscription
 * row persists it: a poll that started from `false` every time would have no
 * band at all, and a value sitting on its threshold would flap once per cron
 * tick — the failure the dead band exists to prevent, reintroduced by the
 * storage layer.
 */
export function isSituationTrue(
  situation: { compare: Comparison; threshold: number },
  value: number,
  wasTrue: boolean,
): boolean {
  const { compare, threshold } = situation;
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  const band = wasTrue ? deadBand(threshold) : 0;

  switch (compare) {
    case "at_least":
      return value >= threshold - band;
    case "at_most":
      return value <= threshold + band;
    case "equals":
      // No band, on purpose. "About 5" is a different claim from "5".
      return value === threshold;
  }
}

/** The condition in words, for the event payload and for an agent to read. */
export function describeSituation(situation: {
  compare: Comparison;
  threshold: number;
  label: string;
}): string {
  const { compare, threshold, label } = situation;
  switch (compare) {
    case "at_least":
      return `${label} reached ${threshold}`;
    case "at_most":
      return `${label} fell to ${threshold}`;
    case "equals":
      return `${label} is exactly ${threshold}`;
  }
}

/**
 * Coerce anything into a situation, or refuse.
 *
 * Null rather than a repaired object, for the reason the pure module gives: a
 * malformed *condition* would make panels appear for reasons that are not
 * true, and the honest failure is that the subscription does nothing.
 */
export function normalizeSituation(input: unknown): Situation | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const compare = raw.compare as Comparison;
  const threshold = raw.threshold;

  if (!id || !label) return null;
  if (!COMPARISONS.includes(compare)) return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
  if (typeof raw.query !== "object" || raw.query === null) return null;

  return {
    id: id.slice(0, 64),
    label: label.slice(0, 80),
    // Normalized by the resolver on its way to being asked — the same closed
    // vocabulary, the same single place.
    query: raw.query,
    compare,
    threshold,
  };
}

// ── What the resolver actually honours ──────────────────────────────────
//
// The query vocabulary in `src/lib/data-stream.ts` is one list of filters for
// every source, but `convex/dataStream.ts` is not one implementation. Tasks are
// answered by the walk in `resolveEnvelope`, which runs `taskMatches` over
// every collected task and therefore applies all nine filters. **Every other
// source is answered by `resolveOther`, which never calls `taskMatches` at
// all** — each branch applies its own two or three filters by hand and ignores
// the rest in silence.
//
// That silence is fine for a panel: a drawn panel is read next to its own
// caption, and a filter that did nothing is visible in the records on screen. It
// is not fine for a situation, which is read by nobody and decides whether a
// panel appears. A situation carrying `scopeToId: <one list>` against
// `from: "pages"` would measure the whole workspace and announce a condition
// that is not true of the thing it names — the exact failure this feature
// cannot have. So a situation whose query names a filter its source ignores is
// REFUSED at subscribe time rather than evaluated wrongly.
//
// Read off the resolver, source by source:
//
//   tasks     `taskMatches` applies status, priority, assignee, due, window
//             (against `_creationTime`), blocked, needsApproval and search.
//             `scopeTo` is applied by the list walk — and only branches on
//             "list" and "project". A `scopeToKind` of "space" or "sprint" is
//             in the vocabulary, is accepted by `normalizeQuery`, and falls
//             through the walk without narrowing anything.
//   pages     window (against `updatedAt`) and search (title).
//   agents    search (name). Nothing else, including window.
//   activity  window (`createdAt`) and search (actor / type / entity title).
//   time      window (`startedAt`) only — not even search.
//   goals     search (title). The rows are read with `parentType` hardcoded to
//             "workspace", so a personal scope answers zero forever.
//   sprints   search (name), and only in a workspace scope; a personal scope
//             falls through to the empty envelope.
//
// The measures are the same story one level down. `scalar` for every
// `resolveOther` branch except goals and time is `matched.length` whatever the
// measure says, so "completion rate of sprints at most 20" would compare a
// COUNT to 20 and be permanently true. `spend` is in the vocabulary and is
// implemented nowhere: it falls to the default in `reduceTasks` and returns a
// count too.

type SourceName =
  | "tasks"
  | "pages"
  | "agents"
  | "activity"
  | "time"
  | "goals"
  | "sprints";

/** Filter keys as `dataStream`'s `EMPTY_FILTER` spells them; `scopeTo` is the pair. */
type FilterKey =
  | "status"
  | "priority"
  | "assignee"
  | "due"
  | "window"
  | "blocked"
  | "needsApproval"
  | "search"
  | "scopeTo";

const HONOURED_FILTERS: Record<SourceName, FilterKey[]> = {
  tasks: [
    "status",
    "priority",
    "assignee",
    "due",
    "window",
    "blocked",
    "needsApproval",
    "search",
    "scopeTo",
  ],
  pages: ["window", "search"],
  agents: ["search"],
  activity: ["window", "search"],
  time: ["window"],
  goals: ["search"],
  sprints: ["search"],
};

/** The only two `scopeToKind` values the task walk branches on. */
const HONOURED_SCOPE_KINDS = ["list", "project"];

/**
 * Measures that reach `scalar` as the thing they name.
 *
 * Anything absent here is answered with a match count under a different word,
 * which for a threshold comparison is not a smaller error than the wrong
 * filter — it is the same error.
 */
const REAL_MEASURES: Record<SourceName, string[]> = {
  tasks: [
    "count",
    "completed",
    "open",
    "overdue",
    "completion_rate",
    "estimate_sum",
    "unassigned",
    "time_logged",
    "custom_field_sum",
    "custom_field_avg",
  ],
  pages: ["count"],
  agents: ["count"],
  activity: ["count"],
  time: ["count", "time_logged"],
  goals: ["count", "completion_rate"],
  sprints: ["count"],
};

/** Sources whose rows only exist under a workspace. */
const WORKSPACE_ONLY: SourceName[] = ["goals", "sprints"];

/**
 * What a filter looks like when nothing has been said about it.
 *
 * These are `dataStream`'s `EMPTY_FILTER` values — what the resolver assumes
 * when the key is absent — with one addition. `status: "open"` is neutral too,
 * because `DEFAULT_QUERY` in `src/lib/data-stream.ts` stamps it onto every
 * query `normalizeQuery` touches whatever the source, so every pages, agents
 * and activity panel the builder produces carries it without anyone having
 * chosen it. Refusing that would refuse the entire feature for five of the
 * seven sources. A status somebody actually picked ("complete", "closed") is
 * still refused.
 */
function filterIsSet(key: FilterKey, filter: Record<string, unknown>): boolean {
  switch (key) {
    case "status":
      return (
        filter.status !== undefined &&
        filter.status !== "any" &&
        filter.status !== "open"
      );
    case "priority":
      return Array.isArray(filter.priority) && filter.priority.length > 0;
    case "assignee":
      return filter.assignee !== undefined && filter.assignee !== "anyone";
    case "due":
      return filter.due !== undefined && filter.due !== "any";
    case "window":
      return filter.window !== undefined && filter.window !== "all";
    case "blocked":
      return filter.blocked === true;
    case "needsApproval":
      return filter.needsApproval === true;
    case "search":
      return typeof filter.search === "string" && filter.search.trim() !== "";
    case "scopeTo":
      return (
        (typeof filter.scopeToKind === "string" && filter.scopeToKind !== "") ||
        (typeof filter.scopeToId === "string" && filter.scopeToId !== "")
      );
  }
}

const FILTER_WORDS: Record<FilterKey, string> = {
  status: "status",
  priority: "priority",
  assignee: "assignee",
  due: "due date",
  window: "time window",
  blocked: "blocked",
  needsApproval: "waiting on approval",
  search: "search text",
  scopeTo: "the list/project/space it is narrowed to",
};

/**
 * Why this query cannot be a situation, or null if it can.
 *
 * A sentence rather than a boolean: the caller is a person or an agent putting
 * a condition together, and "that filter does nothing here" is the whole
 * usable content of the refusal.
 */
export function situationRefusal(
  query: unknown,
  scopeType: "user" | "workspace",
): string | null {
  const raw = (query ?? {}) as Record<string, unknown>;
  const from = (raw.from ?? "tasks") as SourceName;

  if (!(from in HONOURED_FILTERS)) {
    // An unknown source is answered with the empty envelope, so its scalar is
    // zero forever — and zero satisfies `at_most` permanently. A situation that
    // is true because nothing could be read is the worst shape this can take.
    return `"${String(raw.from)}" is not something a situation can measure.`;
  }

  if (WORKSPACE_ONLY.includes(from) && scopeType === "user") {
    return `${from} only exist in a team workspace, so this condition would measure zero forever.`;
  }

  const filter = (raw.filter ?? {}) as Record<string, unknown>;
  const honoured = HONOURED_FILTERS[from];
  const ignored: string[] = [];
  for (const key of Object.keys(FILTER_WORDS) as FilterKey[]) {
    if (honoured.includes(key)) continue;
    if (filterIsSet(key, filter)) ignored.push(FILTER_WORDS[key]);
  }
  if (ignored.length > 0) {
    return `A situation over ${from} can't use ${ignored.join(", ")} — that filter is ignored when ${from} are counted, so the condition would be measured against the wrong records.`;
  }

  // Inside tasks, the pair is honoured for two of its four kinds.
  if (
    from === "tasks" &&
    filterIsSet("scopeTo", filter) &&
    !HONOURED_SCOPE_KINDS.includes(String(filter.scopeToKind))
  ) {
    return `Narrowing to a ${String(filter.scopeToKind) || "scope"} is ignored when tasks are counted — use a list or a project, or the condition would be measured across everything.`;
  }

  const measure = String(raw.measure ?? "count");
  if (!REAL_MEASURES[from].includes(measure)) {
    return `"${measure}" isn't computed for ${from} — the number would be a plain count under another name.`;
  }
  if (
    (measure === "custom_field_sum" || measure === "custom_field_avg") &&
    !raw.measureFieldId
  ) {
    // Without the field id every task contributes nothing and the total is
    // zero, which `at_most` reads as permanently true.
    return "That measure needs a field to measure, and none was named.";
  }

  return null;
}
