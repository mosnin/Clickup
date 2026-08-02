import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireScopeAccess } from "./_authz";
import { allListsInScope, listsInScope, listsInScopeAs } from "./_scope";

// The one resolver.
//
// `src/lib/data-stream.ts` defines the question — source, filter, dimension,
// measure — and this executes it, returning the single envelope every
// component reads: `{ rows, series, scalar, total, meta }`. A list reads rows,
// a chart reads series, a metric reads scalar. There is no second code path
// per shape, which is what makes "pick a source, pick a shape" a real sentence
// rather than four hard-coded panels.
//
// **Every branch here corresponds to a value the normalizer is willing to
// emit.** Agents author these definitions, so that correspondence is the
// security boundary: nothing arriving in `query` is a script, an expression or
// a path into the database, and the worst a hostile definition can produce is
// a differently-grouped view of records its author could already read. Access
// is checked at the scope and every record is gathered through `listsInScope`,
// which re-checks each space.
//
// Bounded on purpose. A panel is a glance, not a report: the walk stops at
// PER_LIST_CAP per list and TOTAL_CAP overall, and `truncated` says so out
// loud rather than quietly showing a number that is wrong.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

const PER_LIST_CAP = 300;
const TOTAL_CAP = 3000;
/** Buckets a chart can carry before it stops being readable. */
const MAX_BUCKETS = 60;

const DAY = 86_400_000;

/** What a query with nothing said about filtering means. */
const EMPTY_FILTER = {
  status: "any",
  priority: [] as string[],
  assignee: "anyone",
  due: "any",
  window: "all",
  blocked: false,
  needsApproval: false,
  search: "",
  scopeToKind: "",
  scopeToId: "",
};

type Filter = {
  status: string;
  priority: string[];
  assignee: string;
  due: string;
  window: string;
  blocked: boolean;
  needsApproval: boolean;
  search: string;
  scopeToKind: string;
  scopeToId: string;
};

type Query = {
  from: string;
  filter: Filter;
  dimension: string;
  breakdown: string;
  measure: string;
  sort: string;
  limit: number;
  dimensionFieldId: string;
  measureFieldId: string;
};

type Point = { key: string; label: string; value: number; color?: string };
type Series = { key: string; label: string; points: Point[] };
type Row = {
  id: string;
  title: string;
  href: string | null;
  meta: Record<string, unknown>;
};

/**
 * The one shape every source returns.
 *
 * Annotated rather than inferred, because inference gives each branch its own
 * literal `meta` type and the union of those is not indexable — which defeats
 * the entire point of having one envelope. A renderer that has to narrow by
 * source is a renderer with a branch per source.
 */
type Envelope = {
  rows: Row[];
  series: Series[];
  scalar: number;
  total: number;
  truncated: boolean;
  meta: { unit: string; dimensionLabel: string; measureLabel: string };
};

const EMPTY: Envelope = {
  rows: [] as Row[],
  series: [] as Series[],
  scalar: 0,
  total: 0,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "", measureLabel: "" },
};

// ── Local time ──────────────────────────────────────────────────────────
//
// Convex runs in UTC, and a person's "today" is not UTC's. The client sends
// its offset so a day bucket is the reader's day; without it every chart of
// daily activity is wrong by up to a day at the edges, which is exactly the
// kind of error nobody notices and everybody acts on.

function startOfDay(at: number, offsetMinutes: number): number {
  const shifted = at - offsetMinutes * 60_000;
  return Math.floor(shifted / DAY) * DAY + offsetMinutes * 60_000;
}

function startOfWeek(at: number, offsetMinutes: number): number {
  const day = startOfDay(at, offsetMinutes);
  // 1 Jan 1970 was a Thursday; shift so the week starts on Monday.
  const weekday = (Math.floor((day - offsetMinutes * 60_000) / DAY) + 3) % 7;
  return day - weekday * DAY;
}

function startOfMonth(at: number, offsetMinutes: number): number {
  const d = new Date(at - offsetMinutes * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + offsetMinutes * 60_000;
}

function bucket(dimension: string, at: number, offsetMinutes: number): number {
  if (dimension.endsWith("_week")) return startOfWeek(at, offsetMinutes);
  if (dimension.endsWith("_month")) return startOfMonth(at, offsetMinutes);
  return startOfDay(at, offsetMinutes);
}

function windowStart(w: string, now: number): number | null {
  if (w === "7d") return now - 7 * DAY;
  if (w === "30d") return now - 30 * DAY;
  if (w === "90d") return now - 90 * DAY;
  if (w === "quarter") return now - 91 * DAY;
  if (w === "year") return now - 365 * DAY;
  return null;
}

function dateFieldFor(d: string): "due" | "created" | "completed" | null {
  if (d.startsWith("due_")) return "due";
  if (d.startsWith("created_")) return "created";
  if (d.startsWith("completed_")) return "completed";
  return null;
}

function unitFor(measure: string): string {
  if (measure === "completion_rate") return "percent";
  if (measure === "time_logged") return "hours";
  if (measure === "estimate_sum") return "points";
  if (measure === "spend") return "currency";
  return "count";
}

/** An agent id is a Convex document id; a person's is a Clerk subject. */
function isAgentActor(id: string): boolean {
  return !id.startsWith("user_");
}

// ── Filtering ───────────────────────────────────────────────────────────

function taskMatches(
  task: Doc<"tasks">,
  filter: Filter,
  category: string | undefined,
  subject: string,
  now: number,
  offsetMinutes: number,
): boolean {
  if (filter.status !== "any" && category !== filter.status) return false;
  if (
    filter.priority.length > 0 &&
    !filter.priority.includes(task.priority ?? "normal")
  ) {
    return false;
  }

  const assignees = task.assigneeClerkIds ?? [];
  if (filter.assignee === "me" && !assignees.includes(subject)) return false;
  if (filter.assignee === "unassigned" && assignees.length > 0) return false;
  if (filter.assignee === "agents" && !assignees.some(isAgentActor)) return false;
  if (
    filter.assignee === "humans" &&
    !assignees.some((a) => !isAgentActor(a))
  ) {
    return false;
  }

  if (filter.due !== "any") {
    const due = task.dueDate;
    const today = startOfDay(now, offsetMinutes);
    if (filter.due === "none" && due !== undefined) return false;
    if (filter.due === "overdue" && (due === undefined || due >= today)) return false;
    if (
      filter.due === "today" &&
      (due === undefined || due < today || due >= today + DAY)
    ) {
      return false;
    }
    if (
      filter.due === "week" &&
      (due === undefined || due < today || due >= today + 7 * DAY)
    ) {
      return false;
    }
    if (
      filter.due === "month" &&
      (due === undefined || due < today || due >= today + 30 * DAY)
    ) {
      return false;
    }
  }

  const from = windowStart(filter.window, now);
  if (from !== null && task._creationTime < from) return false;

  if (filter.blocked && (task.blockedByTaskIds ?? []).length === 0) return false;
  if (filter.needsApproval && !(task.requiresApproval && !task.approvedAt)) {
    return false;
  }
  if (
    filter.search &&
    !task.title.toLowerCase().includes(filter.search.toLowerCase())
  ) {
    return false;
  }
  return true;
}

// ── Grouping ────────────────────────────────────────────────────────────

type Names = {
  status: Map<string, { name: string; color?: string; order: number }>;
  category: Map<string, string>;
  list: Map<string, string>;
  project: Map<string, string>;
  space: Map<string, string>;
  sprint: Map<string, string>;
  actor: Map<string, string>;
  listSpace: Map<string, string>;
  listProject: Map<string, string>;
};

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Which bucket a task belongs to, as `[key, label]`.
 *
 * `null` means the task does not participate — a task with no due date has no
 * place on a due-week axis, and inventing an "unknown" column for it would be
 * inventing data. Assignee is the exception: "nobody" is a real answer and one
 * people specifically look for.
 */
function bucketOf(
  task: Doc<"tasks">,
  dimension: string,
  names: Names,
  offsetMinutes: number,
  fieldValues: Map<string, string>,
): [string, string, string | undefined] | null {
  switch (dimension) {
    case "none":
      return ["all", "All", undefined];
    case "status": {
      if (!task.statusId) return null;
      const s = names.status.get(task.statusId);
      return [task.statusId, s?.name ?? "Status", s?.color];
    }
    case "priority": {
      const p = task.priority ?? "normal";
      return [p, PRIORITY_LABEL[p] ?? p, undefined];
    }
    case "assignee": {
      const first = (task.assigneeClerkIds ?? [])[0];
      if (!first) return ["__none", "Unassigned", undefined];
      return [first, names.actor.get(first) ?? "Someone", undefined];
    }
    case "list":
      return [task.listId, names.list.get(task.listId) ?? "List", undefined];
    case "project": {
      const id = names.listProject.get(task.listId);
      if (!id) return null;
      return [id, names.project.get(id) ?? "Project", undefined];
    }
    case "space": {
      const id = names.listSpace.get(task.listId);
      if (!id) return null;
      return [id, names.space.get(id) ?? "Space", undefined];
    }
    case "sprint": {
      if (!task.sprintId) return null;
      return [task.sprintId, names.sprint.get(task.sprintId) ?? "Sprint", undefined];
    }
    case "custom_field": {
      const value = fieldValues.get(task._id);
      if (value === undefined) return null;
      return [value, value, undefined];
    }
    default: {
      const field = dateFieldFor(dimension);
      if (!field) return null;
      const at =
        field === "due"
          ? task.dueDate
          : field === "completed"
            ? task.completedAt
            : task._creationTime;
      if (at === undefined || at === null) return null;
      const b = bucket(dimension, at, offsetMinutes);
      return [String(b), "", undefined];
    }
  }
}

/** Reduce one bucket of tasks to a number. */
function reduceTasks(
  tasks: Doc<"tasks">[],
  measure: string,
  names: Names,
  now: number,
  offsetMinutes: number,
  hours: Map<string, number>,
  fieldNumbers: Map<string, number>,
): number {
  const isComplete = (t: Doc<"tasks">) =>
    t.statusId ? names.category.get(t.statusId) === "complete" : false;

  switch (measure) {
    case "count":
      return tasks.length;
    case "completed":
      return tasks.filter(isComplete).length;
    case "open":
      return tasks.filter((t) => !isComplete(t)).length;
    case "overdue": {
      const today = startOfDay(now, offsetMinutes);
      return tasks.filter(
        (t) => t.dueDate !== undefined && t.dueDate < today && !isComplete(t),
      ).length;
    }
    case "completion_rate":
      return tasks.length === 0
        ? 0
        : Math.round((tasks.filter(isComplete).length / tasks.length) * 100);
    case "estimate_sum":
      return tasks.reduce((sum, t) => sum + (t.estimatePoints ?? 0), 0);
    case "unassigned":
      return tasks.filter((t) => (t.assigneeClerkIds ?? []).length === 0).length;
    case "time_logged":
      return (
        Math.round(
          tasks.reduce((sum, t) => sum + (hours.get(t._id) ?? 0), 0) * 10,
        ) / 10
      );
    case "custom_field_sum":
      return tasks.reduce((sum, t) => sum + (fieldNumbers.get(t._id) ?? 0), 0);
    case "custom_field_avg": {
      const present = tasks.filter((t) => fieldNumbers.has(t._id));
      if (present.length === 0) return 0;
      const sum = present.reduce((s, t) => s + (fieldNumbers.get(t._id) ?? 0), 0);
      return Math.round((sum / present.length) * 10) / 10;
    }
    default:
      return tasks.length;
  }
}

// ── The query ───────────────────────────────────────────────────────────

async function nameActors(
  ctx: QueryCtx,
  ids: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    if (isAgentActor(id)) {
      const agent = await ctx.db.get(id as Id<"agents">).catch(() => null);
      out.set(id, agent && "name" in agent ? (agent.name as string) : "Agent");
    } else {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", id))
        .first();
      out.set(id, user?.name ?? "Someone");
    }
  }
  return out;
}

export const resolve = query({
  args: {
    scopeType: SCOPE,
    scopeId: v.string(),
    /** The definition, inline — see the note on preview fidelity below. */
    query: v.any(),
    /**
     * The reader's UTC offset in minutes, so a "day" is their day.
     * Convex runs in UTC; without this every daily chart is wrong at the
     * edges, which is the kind of error nobody notices and everybody acts on.
     */
    tzOffsetMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Envelope> => {
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
      }));
    } catch {
      // A panel pointed at somewhere you cannot see renders empty, not an
      // error: existence is information too.
      return EMPTY;
    }
    return await resolveEnvelope(ctx, args, subject);
  },
});

/**
 * Execute a query and return the envelope. The body of `resolve`, lifted.
 *
 * Lifted so a cron can run the same code a screen runs. Calibration has to
 * evaluate an expectation on a schedule, and the alternative — a second
 * evaluator that handles "just the scalar" — is the drift this codebase keeps
 * deleting: two implementations of one vocabulary, and the newer one grows a
 * filter the older one silently ignores.
 *
 * `subject` is passed in rather than resolved, because the caller knows how it
 * got here. A cron has no subject, and a query whose answer depends on who is
 * asking cannot be evaluated on a schedule — see `normalizeExpectation`, which
 * refuses "assigned to me" for exactly that reason.
 */
/**
 * Which lists a resolution may see — the one place that decides.
 *
 * Three callers with three different answers to "on whose behalf", and putting
 * the choice in one function is what keeps a fourth from quietly picking the
 * wrong one: a screen walks as the requester, grading walks unchecked and then
 * narrows to an already-authorized project, and a situation's cron walks as the
 * person who owns the subscription.
 */
async function gatherLists(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  on: { unscoped?: boolean; asSubject?: string },
): Promise<Doc<"lists">[]> {
  if (on.unscoped) return await allListsInScope(ctx, scopeType, scopeId);
  if (on.asSubject !== undefined) {
    return await listsInScopeAs(ctx, scopeType, scopeId, on.asSubject);
  }
  return await listsInScope(ctx, scopeType, scopeId);
}

export async function resolveEnvelope(
  ctx: QueryCtx,
  args: {
    scopeType: "user" | "workspace";
    scopeId: string;
    query: unknown;
    tzOffsetMinutes?: number;
    /**
     * Skip the per-space visibility check.
     *
     * Only grading passes it, and only alongside a `scopeTo` filter that
     * narrows to a project the caller has already been authorized for — see
     * `allListsInScope`.
     */
    unscoped?: boolean;
    /**
     * Run the visibility walk as a named person rather than as the request's
     * identity. What a situation's cron passes, so a subscription measures
     * exactly what its owner can see — see `listsInScopeAs`. Ignored when
     * `unscoped` is set, which already means "no check".
     */
    asSubject?: string;
  },
  subject: string,
): Promise<Envelope> {
  {
    // Belt and braces, and now load-bearing. The renderer normalizes before
    // every read, so for a long time "the caller normalized" was true by
    // construction. A cron grading an expectation reads a query out of a row
    // instead, and an absent `dimension` reaches a `startsWith` and takes the
    // whole pass down. Every scalar gets the same treatment the filter got:
    // absence means the default, never a crash.
    const raw = (args.query ?? {}) as Partial<Query>;
    const q: Query = {
      from: raw.from ?? "tasks",
      filter: { ...EMPTY_FILTER, ...(raw.filter ?? {}) },
      dimension: raw.dimension ?? "none",
      breakdown: raw.breakdown ?? "none",
      measure: raw.measure ?? "count",
      sort: raw.sort ?? "manual",
      limit: raw.limit ?? 8,
      dimensionFieldId: raw.dimensionFieldId ?? "",
      measureFieldId: raw.measureFieldId ?? "",
    };
    const filter: Filter = q.filter;
    const now = Date.now();
    const tz = Math.max(-840, Math.min(840, args.tzOffsetMinutes ?? 0));
    const limit = Math.min(Math.max(Number(q.limit) || 8, 1), 60);
    const meta = {
      unit: unitFor(q.measure),
      dimensionLabel: q.dimension,
      measureLabel: q.measure,
    };

    // Non-task sources: simpler shapes, same envelope.
    if (q.from !== "tasks") {
      return await resolveOther(ctx, args.scopeType, args.scopeId, q, {
        unscoped: args.unscoped,
        asSubject: args.asSubject,
        now,
        tz,
        limit,
        meta,
      });
    }

    // ── Gather ──
    let lists = await gatherLists(ctx, args.scopeType, args.scopeId, args);
    if (filter.scopeToKind === "list") {
      lists = lists.filter((l) => l._id === filter.scopeToId);
    } else if (filter.scopeToKind === "project") {
      lists = lists.filter(
        (l) => l.parentType === "project" && l.parentId === filter.scopeToId,
      );
    }

    const listById = new Map(lists.map((l) => [l._id as string, l]));
    const collected: Doc<"tasks">[] = [];
    let truncated = false;
    for (const list of lists) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (qb) => qb.eq("listId", list._id))
        .take(PER_LIST_CAP);
      if (tasks.length === PER_LIST_CAP) truncated = true;
      collected.push(...tasks);
      if (collected.length >= TOTAL_CAP) {
        truncated = true;
        break;
      }
    }

    // ── Names, once ──
    const names: Names = {
      status: new Map(),
      category: new Map(),
      list: new Map(),
      project: new Map(),
      space: new Map(),
      sprint: new Map(),
      actor: new Map(),
      listSpace: new Map(),
      listProject: new Map(),
    };
    for (const list of lists) {
      names.list.set(list._id, list.name);
      if (list.parentType === "space") names.listSpace.set(list._id, list.parentId);
      if (list.parentType === "project") {
        names.listProject.set(list._id, list.parentId);
      }
    }
    for (const seen of new Set(names.listProject.values())) {
      const project = await ctx.db.get(seen as Id<"projects">).catch(() => null);
      if (project && "name" in project) {
        names.project.set(seen, project.name as string);
        if ("spaceId" in project) {
          for (const [listId, projectId] of names.listProject) {
            if (projectId === seen) {
              names.listSpace.set(listId, project.spaceId as string);
            }
          }
        }
      }
    }
    for (const seen of new Set(names.listSpace.values())) {
      const space = await ctx.db.get(seen as Id<"spaces">).catch(() => null);
      if (space && "name" in space) names.space.set(seen, space.name as string);
    }
    for (const task of collected) {
      if (task.statusId && !names.status.has(task.statusId)) {
        const status = await ctx.db.get(task.statusId);
        if (status) {
          names.status.set(task.statusId, {
            name: status.name,
            color: status.color,
            order: status.position ?? 0,
          });
          names.category.set(task.statusId, status.category);
        }
      }
    }

    // ── Filter ──
    const matched = collected.filter((t) =>
      taskMatches(
        t,
        filter,
        t.statusId ? names.category.get(t.statusId) : undefined,
        subject,
        now,
        tz,
      ),
    );

    // Actor names only for what survived the filter — naming every assignee in
    // a three-thousand-task scope to render eight rows is a lot of reads.
    const actorIds = new Set<string>();
    for (const t of matched) {
      for (const a of t.assigneeClerkIds ?? []) actorIds.add(a);
    }
    if (actorIds.size <= 60) {
      for (const [id, name] of await nameActors(ctx, actorIds)) {
        names.actor.set(id, name);
      }
    }

    // Sprints, if the dimension needs them.
    if (q.dimension === "sprint") {
      for (const id of new Set(matched.map((t) => t.sprintId).filter(Boolean))) {
        const sprint = await ctx.db.get(id as Id<"sprints">).catch(() => null);
        if (sprint && "name" in sprint) {
          names.sprint.set(id as string, sprint.name as string);
        }
      }
    }

    // ── Side tables the measure or dimension needs ──
    const hours = new Map<string, number>();
    if (q.measure === "time_logged") {
      for (const task of matched) {
        const entries = await ctx.db
          .query("timeEntries")
          .withIndex("by_task", (qb) => qb.eq("taskId", task._id))
          .take(200);
        const ms = entries.reduce(
          (sum, e) => sum + ((e.endedAt ?? now) - e.startedAt),
          0,
        );
        if (ms > 0) hours.set(task._id, ms / 3_600_000);
      }
    }

    const fieldValues = new Map<string, string>();
    const fieldNumbers = new Map<string, number>();
    const needsFieldText = q.dimension === "custom_field" && q.dimensionFieldId;
    const needsFieldNumber =
      (q.measure === "custom_field_sum" || q.measure === "custom_field_avg") &&
      q.measureFieldId;
    if (needsFieldText || needsFieldNumber) {
      for (const task of matched) {
        const values = await ctx.db
          .query("taskFieldValues")
          .withIndex("by_task", (qb) => qb.eq("taskId", task._id))
          .take(50);
        for (const value of values) {
          if (needsFieldText && value.fieldId === q.dimensionFieldId) {
            const text =
              value.textValue ??
              (value.numberValue !== undefined ? String(value.numberValue) : null);
            if (text) fieldValues.set(task._id, text);
          }
          if (
            needsFieldNumber &&
            value.fieldId === q.measureFieldId &&
            value.numberValue !== undefined
          ) {
            fieldNumbers.set(task._id, value.numberValue);
          }
        }
      }
    }

    // ── Rows ──
    const sorted = [...matched];
    if (q.sort === "due") {
      sorted.sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
    } else if (q.sort === "priority") {
      sorted.sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority ?? "normal"] ?? 2) -
          (PRIORITY_ORDER[b.priority ?? "normal"] ?? 2),
      );
    } else if (q.sort === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (q.sort === "created" || q.sort === "updated") {
      sorted.sort((a, b) => b._creationTime - a._creationTime);
    }

    const rows: Row[] = sorted.slice(0, limit).map((t) => ({
      id: t._id,
      title: t.title,
      href: `/dashboard/l/${t.listId}/t/${t._id}`,
      meta: {
        status: t.statusId ? (names.status.get(t.statusId)?.name ?? null) : null,
        statusColor: t.statusId ? (names.status.get(t.statusId)?.color ?? null) : null,
        priority: t.priority ?? null,
        due: t.dueDate ?? null,
        added: t._creationTime,
        list: names.list.get(t.listId) ?? null,
        estimate: t.estimatePoints ?? null,
        assignee: (t.assigneeClerkIds ?? []).length,
        assigneeName:
          names.actor.get((t.assigneeClerkIds ?? [])[0] ?? "") ?? null,
        blocked: (t.blockedByTaskIds ?? []).length,
      },
    }));

    // ── Series ──
    //
    // Grouped once by the dimension, then split by the breakdown. One pass,
    // two Maps: a stacked chart is the same walk as a plain one, so there is
    // no second code path to keep in agreement.
    const buckets = new Map<
      string,
      { label: string; color?: string; byBreakdown: Map<string, Doc<"tasks">[]> }
    >();
    const breakdownLabels = new Map<string, string>();

    for (const task of matched) {
      const b = bucketOf(task, q.dimension, names, tz, fieldValues);
      if (!b) continue;
      const [key, label, color] = b;
      let entry = buckets.get(key);
      if (!entry) {
        entry = { label, color, byBreakdown: new Map() };
        buckets.set(key, entry);
      }
      let bkKey = "all";
      if (q.breakdown !== "none") {
        const bk = bucketOf(task, q.breakdown, names, tz, fieldValues);
        if (!bk) continue;
        bkKey = bk[0];
        breakdownLabels.set(bkKey, bk[1] || bk[0]);
      }
      const list = entry.byBreakdown.get(bkKey) ?? [];
      list.push(task);
      entry.byBreakdown.set(bkKey, list);
    }

    // Date dimensions come out chronological; status comes out in workflow
    // order. Both are more meaningful than anything re-sorting could produce.
    let keys = [...buckets.keys()];
    if (dateFieldFor(q.dimension)) {
      keys.sort((a, b) => Number(a) - Number(b));
    } else if (q.dimension === "status") {
      keys.sort(
        (a, b) =>
          (names.status.get(a)?.order ?? 0) - (names.status.get(b)?.order ?? 0),
      );
    } else if (q.dimension === "priority") {
      keys.sort((a, b) => (PRIORITY_ORDER[a] ?? 2) - (PRIORITY_ORDER[b] ?? 2));
    }
    if (keys.length > MAX_BUCKETS) {
      // A date axis keeps its NEWEST buckets; everything else keeps its first.
      //
      // The keys are already chronological here, so the old `slice(0, …)` kept
      // the sixty *oldest* days — a "finished each day" chart on a two-year-old
      // account drew that account's first two months and called it recent. It
      // is the more expensive half of the `filter.window` trap: dropping the
      // window to make a completion chart honest about which tasks it counts
      // would have made it dishonest about which days it shows.
      keys = dateFieldFor(q.dimension)
        ? keys.slice(-MAX_BUCKETS)
        : keys.slice(0, MAX_BUCKETS);
      truncated = true;
    }

    const seriesKeys =
      q.breakdown === "none" ? ["all"] : [...breakdownLabels.keys()];
    const series: Series[] = seriesKeys.map((sk) => ({
      key: sk,
      label: q.breakdown === "none" ? meta.measureLabel : (breakdownLabels.get(sk) ?? sk),
      points: keys.map((k) => {
        const entry = buckets.get(k)!;
        const tasks = entry.byBreakdown.get(sk) ?? [];
        return {
          key: k,
          label: entry.label,
          value: reduceTasks(tasks, q.measure, names, now, tz, hours, fieldNumbers),
          ...(entry.color ? { color: entry.color } : {}),
        };
      }),
    }));

    // The scalar runs over everything that matched, never over the visible
    // page — a count that only counts what fits on screen is a lie.
    const scalar = reduceTasks(
      matched,
      q.measure,
      names,
      now,
      tz,
      hours,
      fieldNumbers,
    );

    void listById;
    return { rows, series, scalar, total: matched.length, truncated, meta };
  }
}

/**
 * The other sources.
 *
 * Same envelope, narrower vocabulary — `dimensionsFor`/`measuresFor` in the
 * pure layer already refuse anything these cannot answer, so there is no
 * combination to defend against here that the normalizer would let through.
 */
async function resolveOther(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  q: Query,
  ctxo: {
    now: number;
    tz: number;
    limit: number;
    meta: { unit: string; dimensionLabel: string; measureLabel: string };
    /** See `allListsInScope` — only grading passes it. */
    unscoped?: boolean;
    /** See `listsInScopeAs` — only a situation's cron passes it. */
    asSubject?: string;
  },
): Promise<Envelope> {
  const { now, tz, limit, meta } = ctxo;
  const search = q.filter.search.toLowerCase();
  const from = windowStart(q.filter.window, now);

  /** Group `items` by a date or a keyed dimension into one series. */
  const seriesOf = (
    items: { key: string; label: string; at?: number; value?: number }[],
  ): Series[] => {
    if (q.dimension === "none") {
      return [
        {
          key: "all",
          label: meta.measureLabel,
          points: [
            {
              key: "all",
              label: "All",
              value: items.reduce((s, i) => s + (i.value ?? 1), 0),
            },
          ],
        },
      ];
    }
    const buckets = new Map<string, { label: string; value: number }>();
    for (const item of items) {
      let key = item.key;
      let label = item.label;
      if (dateFieldFor(q.dimension)) {
        if (item.at === undefined) continue;
        key = String(bucket(q.dimension, item.at, tz));
        label = "";
      }
      const entry = buckets.get(key) ?? { label, value: 0 };
      entry.value += item.value ?? 1;
      buckets.set(key, entry);
    }
    let keys = [...buckets.keys()];
    if (dateFieldFor(q.dimension)) keys.sort((a, b) => Number(a) - Number(b));
    // The newest buckets on a date axis, the first ones otherwise — the same
    // rule the task walk above uses, and for the same reason.
    if (keys.length > MAX_BUCKETS) {
      keys = dateFieldFor(q.dimension)
        ? keys.slice(-MAX_BUCKETS)
        : keys.slice(0, MAX_BUCKETS);
    }
    return [
      {
        key: "all",
        label: meta.measureLabel,
        points: keys.map((k) => ({
          key: k,
          label: buckets.get(k)!.label,
          value: buckets.get(k)!.value,
        })),
      },
    ];
  };

  if (q.from === "agents") {
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (qb) =>
        qb.eq("parentType", scopeType).eq("parentId", scopeId),
      )
      .collect();
    const matched = agents.filter(
      (a) => !search || a.name.toLowerCase().includes(search),
    );
    const online = (a: Doc<"agents">) =>
      a.lastSeenAt !== undefined && now - a.lastSeenAt < 120_000;
    const rows: Row[] = matched.slice(0, limit).map((a) => ({
      id: a._id,
      title: a.name,
      href: `/dashboard/agents/${a._id}`,
      meta: {
        status: online(a) ? "online" : "offline",
        task: a.statusText ?? null,
        spend: null,
      },
    }));
    const items = matched.map((a) => ({
      key: online(a) ? "online" : "offline",
      label: online(a) ? "Online" : "Offline",
      at: a._creationTime,
    }));
    return {
      rows,
      series: seriesOf(items),
      scalar: matched.length,
      total: matched.length,
      truncated: false,
      meta,
    };
  }

  if (q.from === "pages") {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (qb) =>
        qb.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .order("desc")
      .take(500);
    const matched = pages.filter(
      (p) =>
        (!search || p.title.toLowerCase().includes(search)) &&
        (from === null || p.updatedAt >= from),
    );
    return {
      rows: matched.slice(0, limit).map((p) => ({
        id: p._id,
        title: p.title,
        href: `/dashboard/pages/${p._id}`,
        meta: { updated: p.updatedAt, author: p.updatedByName ?? null },
      })),
      series: seriesOf(
        matched.map((p) => ({ key: "all", label: "Pages", at: p._creationTime })),
      ),
      scalar: matched.length,
      total: matched.length,
      truncated: pages.length === 500,
      meta,
    };
  }

  if (q.from === "activity") {
    const events = await ctx.db
      .query("events")
      .withIndex("by_scope", (qb) =>
        qb.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .order("desc")
      .take(500);
    const matched = events.filter(
      (e) =>
        (from === null || e.createdAt >= from) &&
        (!search ||
          `${e.actorName} ${e.type} ${e.entityTitle ?? ""}`
            .toLowerCase()
            .includes(search)),
    );
    return {
      rows: matched.slice(0, limit).map((e) => ({
        id: e._id,
        title: `${e.actorName} ${e.type.replace(/[._]/g, " ")}${
          e.entityTitle ? ` ${e.entityTitle}` : ""
        }`,
        href: null,
        meta: { actor: e.actorName, when: e.createdAt },
      })),
      series: seriesOf(
        matched.map((e) => ({
          key: e.actorName,
          label: e.actorName,
          at: e.createdAt,
        })),
      ),
      scalar: matched.length,
      total: matched.length,
      truncated: events.length === 500,
      meta,
    };
  }

  if (q.from === "sprints" && scopeType === "workspace") {
    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (qb) => qb.eq("workspaceId", scopeId as Id<"workspaces">))
      .collect();
    const matched = sprints.filter(
      (s) => !search || s.name.toLowerCase().includes(search),
    );
    return {
      rows: matched.slice(0, limit).map((s) => ({
        id: s._id,
        title: s.name,
        href: null,
        meta: { status: s.status, due: s.endDate ?? null },
      })),
      series: seriesOf(
        matched.map((s) => ({ key: s.status, label: s.status, at: s._creationTime })),
      ),
      scalar: matched.length,
      total: matched.length,
      truncated: false,
      meta,
    };
  }

  if (q.from === "goals") {
    const goals = await ctx.db
      .query("goals")
      .withIndex("by_parent", (qb) =>
        qb.eq("parentType", "workspace").eq("parentId", scopeId),
      )
      .collect();
    const matched = goals.filter(
      (g) => !search || g.title.toLowerCase().includes(search),
    );
    const rate = (g: Doc<"goals">) =>
      g.targetValue > 0
        ? Math.round(((g.currentValue ?? 0) / g.targetValue) * 100)
        : 0;
    return {
      rows: matched.slice(0, limit).map((g) => ({
        id: g._id,
        title: g.title,
        href: null,
        meta: { value: rate(g), due: g.dueDate ?? null },
      })),
      series: seriesOf(
        matched.map((g) => ({
          key: g._id,
          label: g.title,
          at: g._creationTime,
          value: q.measure === "completion_rate" ? rate(g) : 1,
        })),
      ),
      scalar:
        q.measure === "completion_rate"
          ? matched.length === 0
            ? 0
            : Math.round(
                matched.reduce((s, g) => s + rate(g), 0) / matched.length,
              )
          : matched.length,
      total: matched.length,
      truncated: false,
      meta,
    };
  }

  if (q.from === "time") {
    const lists = await gatherLists(ctx, scopeType, scopeId, ctxo);
    const listIds = new Set(lists.map((l) => l._id as string));
    const entries = await ctx.db.query("timeEntries").order("desc").take(1000);
    const matched: { key: string; label: string; at: number; value: number }[] = [];
    let totalHours = 0;
    const rows: Row[] = [];
    for (const e of entries) {
      if (from !== null && e.startedAt < from) continue;
      const task = await ctx.db.get(e.taskId).catch(() => null);
      if (!task || !("listId" in task) || !listIds.has(task.listId as string)) {
        continue;
      }
      const hours = ((e.endedAt ?? now) - e.startedAt) / 3_600_000;
      totalHours += hours;
      matched.push({
        key: e.userClerkId,
        label: e.userClerkId,
        at: e.startedAt,
        value: q.measure === "time_logged" ? hours : 1,
      });
      if (rows.length < limit) {
        rows.push({
          id: e._id,
          title: (task as Doc<"tasks">).title,
          href: `/dashboard/l/${(task as Doc<"tasks">).listId}/t/${task._id}`,
          meta: { when: e.startedAt, value: Math.round(hours * 10) / 10 },
        });
      }
    }
    // Name the people, not their subjects — a chart axis reading "user_2ab…"
    // is a chart nobody can use.
    const actorNames = await nameActors(
      ctx,
      new Set(matched.map((m) => m.key).slice(0, 60)),
    );
    for (const m of matched) m.label = actorNames.get(m.key) ?? "Someone";
    return {
      rows,
      series: seriesOf(matched),
      scalar:
        q.measure === "time_logged"
          ? Math.round(totalHours * 10) / 10
          : matched.length,
      total: matched.length,
      truncated: entries.length === 1000,
      meta,
    };
  }

  return { ...EMPTY, meta };
}
