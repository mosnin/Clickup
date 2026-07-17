import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// The Home page's single live subscription: where every project stands
// right now, plus the numbers that matter today. Convex queries are
// reactive, so every tile on Home moves the moment the data does — a task
// completes, an agent heartbeats, a comment lands.
//
// Walks the user's accessible lists (same O(tasks-in-scope) shape as
// reports.workspaceSummary / myWork); fine at target scale.

type ProjectCard = {
  listId: Id<"lists">;
  name: string;
  place: string; // "Personal · HQ" or "Acme · Growth"
  description?: string;
  projectStatus?: Doc<"lists">["projectStatus"];
  targetDate?: number;
  total: number;
  done: number;
  inProgress: number;
  overdue: number;
  dueSoon: number; // next 7 days
  /** ms of the newest event touching this list, for recency sort. */
  lastActivityAt: number;
};

async function listsForSpace(
  ctx: QueryCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"lists">[]> {
  const direct = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "space").eq("parentId", spaceId),
    )
    .collect();
  const folders = await ctx.db
    .query("folders")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
  const nested = await Promise.all(
    folders.map((f) =>
      ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "folder").eq("parentId", f._id),
        )
        .collect(),
    ),
  );
  return [...direct, ...nested.flat()];
}

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const subject = identity.subject;
    const now = Date.now();
    const weekAhead = now + 7 * 24 * 60 * 60 * 1000;

    // ── Scope: personal space + member workspaces ──
    const scopes: {
      space: Doc<"spaces">;
      place: string;
      scopeType: "user" | "workspace";
      scopeId: string;
    }[] = [];
    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", subject),
      )
      .unique();
    if (personal) {
      scopes.push({
        space: personal,
        place: "Personal",
        scopeType: "user",
        scopeId: subject,
      });
    }
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .collect();
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (!ws) continue;
      const wsSpaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", m.workspaceId),
        )
        .collect();
      for (const sp of wsSpaces) {
        scopes.push({
          space: sp,
          place: ws.name,
          scopeType: "workspace",
          scopeId: m.workspaceId,
        });
      }
    }

    // ── Recent events per scope: recency + the live ticker ──
    const scopeKeys = new Set<string>();
    const ticker: {
      type: string;
      entityTitle?: string;
      actorName: string;
      actorType: string;
      listId?: Id<"lists">;
      createdAt: number;
    }[] = [];
    const lastEventByList = new Map<string, number>();
    for (const sc of scopes) {
      const key = `${sc.scopeType}:${sc.scopeId}`;
      if (scopeKeys.has(key)) continue;
      scopeKeys.add(key);
      const events = await ctx.db
        .query("events")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", sc.scopeType).eq("scopeId", sc.scopeId),
        )
        .order("desc")
        .take(25);
      for (const e of events) {
        if (e.listId) {
          const cur = lastEventByList.get(e.listId) ?? 0;
          if (e.createdAt > cur) lastEventByList.set(e.listId, e.createdAt);
        }
        ticker.push({
          type: e.type,
          entityTitle: e.entityTitle,
          actorName: e.actorName,
          actorType: e.actorType,
          listId: e.listId,
          createdAt: e.createdAt,
        });
      }
    }
    ticker.sort((a, b) => b.createdAt - a.createdAt);

    // ── Per-project rollups ──
    const projects: ProjectCard[] = [];
    let myOpen = 0;
    let myOverdue = 0;
    let myDueToday = 0;
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    for (const sc of scopes) {
      const lists = await listsForSpace(ctx, sc.space._id);
      for (const list of lists) {
        const statuses = await ctx.db
          .query("listStatuses")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        const doneIds = new Set(
          statuses
            .filter(
              (s) => s.category === "complete" || s.category === "closed",
            )
            .map((s) => s._id),
        );
        const inProgressIds = new Set(
          statuses
            .filter((s) => s.category === "in_progress")
            .map((s) => s._id),
        );
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();

        let done = 0;
        let inProgress = 0;
        let overdue = 0;
        let dueSoon = 0;
        for (const t of tasks) {
          const isDone = doneIds.has(t.statusId);
          if (isDone) done += 1;
          else if (inProgressIds.has(t.statusId)) inProgress += 1;
          if (!isDone && t.dueDate) {
            if (t.dueDate < now) overdue += 1;
            else if (t.dueDate < weekAhead) dueSoon += 1;
          }
          if (!isDone && t.assigneeClerkIds.includes(subject)) {
            myOpen += 1;
            if (t.dueDate) {
              if (t.dueDate < now) myOverdue += 1;
              else if (t.dueDate <= todayEnd.getTime()) myDueToday += 1;
            }
          }
        }

        projects.push({
          listId: list._id,
          name: list.name,
          place: `${sc.place} · ${sc.space.name}`,
          description: list.description,
          projectStatus: list.projectStatus,
          targetDate: list.targetDate,
          total: tasks.length,
          done,
          inProgress,
          overdue,
          dueSoon,
          lastActivityAt: lastEventByList.get(list._id) ?? list.createdAt,
        });
      }
    }
    projects.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    // ── Agents: who's online / working right now ──
    const agentsWorking: {
      agentId: Id<"agents">;
      name: string;
      statusText?: string;
      online: boolean;
    }[] = [];
    const seenScopes = new Set<string>();
    for (const sc of scopes) {
      const key = `${sc.scopeType}:${sc.scopeId}`;
      if (seenScopes.has(key)) continue;
      seenScopes.add(key);
      const agents = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q
            .eq("parentType", sc.scopeType)
            .eq("parentId", sc.scopeId),
        )
        .collect();
      for (const a of agents) {
        if (a.status !== "active") continue;
        const online =
          a.lastSeenAt !== undefined && now - a.lastSeenAt < 5 * 60 * 1000;
        agentsWorking.push({
          agentId: a._id,
          name: a.name,
          statusText: a.statusText,
          online,
        });
      }
    }
    agentsWorking.sort((a, b) => Number(b.online) - Number(a.online));

    return {
      projects: projects.slice(0, 12),
      totalProjects: projects.length,
      me: { open: myOpen, overdue: myOverdue, dueToday: myDueToday },
      agents: agentsWorking.slice(0, 8),
      ticker: ticker.slice(0, 10),
    };
  },
});
