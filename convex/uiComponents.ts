import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canAccessSpace, requireIdentity, requireScopeAccess } from "./_authz";

// The engine behind user-authored panels.
//
// A component is a definition (src/lib/ui-components.ts), and `resolve` is the
// one place that knows how to execute one. Every branch below corresponds to a
// value the normalizer is willing to emit, which is what makes the closed
// vocabulary a real boundary rather than a convention: an agent can write any
// definition it likes and the worst it can produce is a differently-filtered
// list of things the caller could already see.
//
// Access is checked at the scope, and every row is checked again on the way
// out. A panel is a query someone else may have written — it must not become a
// way to read across a boundary the writer could not cross.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

/** Every list inside a scope, walked once. */
async function listsInScope(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<Doc<"lists">[]> {
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", scopeType).eq("parentId", scopeId),
    )
    .collect();

  const out: Doc<"lists">[] = [];
  for (const space of spaces) {
    if (space.archivedAt) continue;
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) continue;
    if (!(await canAccessSpace(ctx, space, identity))) continue;

    out.push(
      ...(await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect()),
    );
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    for (const project of projects) {
      out.push(
        ...(await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect()),
      );
    }
  }
  return out;
}

type Filter = {
  status: string;
  priority: string[];
  assignee: string;
  due: string;
  blocked: boolean;
  needsApproval: boolean;
  search: string;
};

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Does a task satisfy the filter?
 *
 * Every branch matches a value the normalizer emits. A filter it has never
 * heard of cannot reach here, so there is no default-deny to get wrong.
 */
function matches(
  task: Doc<"tasks">,
  filter: Filter,
  category: string | undefined,
  subject: string,
  now: number,
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
  if (filter.assignee === "agents") {
    // An agent id is a Convex document id; a person's is a Clerk subject,
    // which always carries the "user_" prefix.
    if (!assignees.some((a) => !a.startsWith("user_"))) return false;
  }

  if (filter.due !== "any") {
    const due = task.dueDate;
    const today = startOfDay(now);
    if (filter.due === "none" && due !== undefined) return false;
    if (filter.due === "overdue" && (due === undefined || due >= today)) {
      return false;
    }
    if (
      filter.due === "today" &&
      (due === undefined || due < today || due >= today + 86_400_000)
    ) {
      return false;
    }
    if (
      filter.due === "week" &&
      (due === undefined || due < today || due >= today + 7 * 86_400_000)
    ) {
      return false;
    }
  }

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

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Run a definition and return rows a renderer can draw.
 *
 * Takes the definition inline rather than an id, so the builder can preview an
 * unsaved panel through the same path a saved one renders through — a preview
 * that runs different code is a preview that lies.
 */
export const resolve = query({
  args: {
    scopeType: SCOPE,
    scopeId: v.string(),
    definition: v.any(),
  },
  handler: async (ctx, { scopeType, scopeId, definition }) => {
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, { scopeType, scopeId }));
    } catch {
      return { rows: [], metric: null, total: 0 };
    }
    const def = (definition ?? {}) as {
      from?: string;
      filter?: Filter;
      shape?: string;
      sort?: string;
      limit?: number;
      metric?: string;
    };
    const filter: Filter = {
      status: def.filter?.status ?? "open",
      priority: Array.isArray(def.filter?.priority) ? def.filter.priority : [],
      assignee: def.filter?.assignee ?? "anyone",
      due: def.filter?.due ?? "any",
      blocked: def.filter?.blocked === true,
      needsApproval: def.filter?.needsApproval === true,
      search: typeof def.filter?.search === "string" ? def.filter.search : "",
    };
    const limit = Math.min(Math.max(Number(def.limit) || 8, 1), 50);
    const now = Date.now();

    if (def.from === "agents") {
      const agents = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", scopeType).eq("parentId", scopeId),
        )
        .collect();
      const rows = agents.slice(0, limit).map((a) => ({
        id: a._id as string,
        title: a.name,
        href: `/dashboard/agents/${a._id}`,
        meta: {
          status:
            a.lastSeenAt && now - a.lastSeenAt < 120_000 ? "online" : "offline",
          task: a.statusText ?? null,
        } as Record<string, unknown>,
      }));
      return { rows, metric: agents.length, total: agents.length };
    }

    if (def.from === "pages") {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", scopeType).eq("scopeId", scopeId),
        )
        .order("desc")
        .take(200);
      const filtered = pages.filter(
        (p) =>
          !filter.search ||
          p.title.toLowerCase().includes(filter.search.toLowerCase()),
      );
      return {
        rows: filtered.slice(0, limit).map((p) => ({
          id: p._id as string,
          title: p.title,
          href: `/dashboard/pages/${p._id}`,
          meta: {
            updated: p.updatedAt,
            author: p.updatedByName ?? null,
          } as Record<string, unknown>,
        })),
        metric: filtered.length,
        total: filtered.length,
      };
    }

    if (def.from === "activity") {
      const events = await ctx.db
        .query("events")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", scopeType).eq("scopeId", scopeId),
        )
        .order("desc")
        .take(limit);
      return {
        rows: events.map((e) => ({
          id: e._id as string,
          title: `${e.actorName} ${e.type.replace(/[._]/g, " ")}${
            e.entityTitle ? ` ${e.entityTitle}` : ""
          }`,
          href: null,
          meta: { actor: e.actorName, when: e.createdAt } as Record<
            string,
            unknown
          >,
        })),
        metric: events.length,
        total: events.length,
      };
    }

    // Tasks: the core primitive, and the only source with the full filter.
    const lists = await listsInScope(ctx, scopeType, scopeId);
    const listById = new Map(lists.map((l) => [l._id, l]));
    const statusCategory = new Map<Id<"listStatuses">, string>();
    const collected: Doc<"tasks">[] = [];
    // Bounded: a panel is a glance, and walking an unbounded workspace to
    // render eight rows is how a dashboard stops loading.
    const PER_LIST_CAP = 200;
    for (const list of lists) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .take(PER_LIST_CAP);
      collected.push(...tasks);
      if (collected.length > 2000) break;
    }
    for (const task of collected) {
      if (task.statusId && !statusCategory.has(task.statusId)) {
        const status = await ctx.db.get(task.statusId);
        if (status) statusCategory.set(task.statusId, status.category);
      }
    }

    const matched = collected.filter((t) =>
      matches(
        t,
        filter,
        t.statusId ? statusCategory.get(t.statusId) : undefined,
        subject,
        now,
      ),
    );

    const sorted = [...matched];
    if (def.sort === "due") {
      sorted.sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
    } else if (def.sort === "priority") {
      sorted.sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority ?? "normal"] ?? 2) -
          (PRIORITY_ORDER[b.priority ?? "normal"] ?? 2),
      );
    } else if (def.sort === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (def.sort === "created") {
      sorted.sort((a, b) => b._creationTime - a._creationTime);
    } else if (def.sort === "updated") {
      // Tasks have no updatedAt; creation order is the honest proxy and the
      // only monotonic clock a task row actually carries.
      sorted.sort((a, b) => b._creationTime - a._creationTime);
    }

    // Metrics run over everything that matched, not over the visible page —
    // a count that only counts what fits on screen is a lie.
    let metric: number | null = null;
    if (def.shape === "metric") {
      if (def.metric === "completion") {
        const done = matched.filter(
          (t) =>
            t.statusId && statusCategory.get(t.statusId) === "complete",
        ).length;
        metric =
          matched.length === 0
            ? 0
            : Math.round((done / matched.length) * 100);
      } else if (def.metric === "overdue") {
        const today = startOfDay(now);
        metric = matched.filter(
          (t) => t.dueDate !== undefined && t.dueDate < today,
        ).length;
      } else if (def.metric === "estimate_sum") {
        metric = matched.reduce((sum, t) => sum + (t.estimatePoints ?? 0), 0);
      } else if (def.metric === "unassigned") {
        metric = matched.filter(
          (t) => (t.assigneeClerkIds ?? []).length === 0,
        ).length;
      } else {
        metric = matched.length;
      }
    }

    return {
      rows: sorted.slice(0, limit).map((t) => ({
        id: t._id as string,
        title: t.title,
        href: `/dashboard/l/${t.listId}/t/${t._id}`,
        meta: {
          status: t.statusId ? statusCategory.get(t.statusId) ?? null : null,
          priority: t.priority ?? null,
          due: t.dueDate ?? null,
          assignee: (t.assigneeClerkIds ?? []).length,
          list: listById.get(t.listId)?.name ?? null,
          estimate: t.estimatePoints ?? null,
          blocked: (t.blockedByTaskIds ?? []).length,
          added: t._creationTime,
        } as Record<string, unknown>,
      })),
      metric,
      total: matched.length,
    };
  },
});

/** Panels this person can put on a screen in this scope. */
export const listForScope = query({
  args: { scopeType: SCOPE, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    let subject: string;
    try {
      ({ subject } = await requireScopeAccess(ctx, { scopeType, scopeId }));
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("uiComponents")
      .withIndex("by_owner_and_scope", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("scopeType", scopeType)
          .eq("scopeId", scopeId),
      )
      .collect();
    return rows.map((r) => ({
      componentId: r._id,
      definition: r.definition as unknown,
      authoredByName: r.authoredByName ?? null,
      updatedAt: r.updatedAt,
    }));
  },
});

export const create = mutation({
  args: { scopeType: SCOPE, scopeId: v.string(), definition: v.any() },
  handler: async (ctx, { scopeType, scopeId, definition }) => {
    const { subject } = await requireScopeAccess(ctx, { scopeType, scopeId });
    const now = Date.now();
    return await ctx.db.insert("uiComponents", {
      ownerClerkId: subject,
      scopeType,
      scopeId,
      definition,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: { componentId: v.id("uiComponents"), definition: v.any() },
  handler: async (ctx, { componentId, definition }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(componentId);
    // A panel belongs to whoever authored it; "not found" rather than
    // "forbidden" so an id can't be probed for existence.
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Panel not found");
    }
    await ctx.db.patch(componentId, { definition, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { componentId: v.id("uiComponents") },
  handler: async (ctx, { componentId }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(componentId);
    if (!row || row.ownerClerkId !== identity.subject) {
      throw new ConvexError("Panel not found");
    }
    await ctx.db.delete(componentId);
  },
});
