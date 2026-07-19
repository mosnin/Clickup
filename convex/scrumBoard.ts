import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireTaskAccess } from "./_authz";
import { updateTaskCore } from "./tasks";
import { userActor } from "./events";

// Sprint scrum board: every task in one sprint (tasks can come from any
// list in the sprint's workspace — see convex/sprints.ts), grouped into
// four category columns (open / in_progress / complete / closed) on the
// client. Because different lists have different custom-named workflows,
// a card never moves to a hardcoded statusId — `moveTask` maps the target
// *category* onto the card's own list's status of that category, so a
// cross-list board stays safe.

async function requireWorkspaceMember(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!member) throw new Error("Forbidden");
  return identity.subject;
}

export type ScrumBoardTask = {
  _id: Id<"tasks">;
  title: string;
  listId: Id<"lists">;
  listName: string;
  priority?: "urgent" | "high" | "normal" | "low";
  assigneeClerkIds: string[];
  estimatePoints?: number;
  milestone?: boolean;
  checklistDone: number;
  checklistTotal: number;
  blockedOpenCount: number;
  statusId: Id<"listStatuses">;
  statusName: string;
  statusCategory: "open" | "in_progress" | "complete" | "closed";
  statusColor: string;
};

export type ScrumBoardMember = {
  id: string;
  name: string;
  kind: "user" | "agent";
};

// Sprint-scoped board data. Grouping into columns/swimlanes happens
// client-side — this query just returns a flat, fully-resolved task list
// plus a workspace member roster (humans + agents) so the client can
// render assignee names/avatars and by-assignee swimlanes without extra
// round trips. Returns null for a missing sprint or a non-member caller.
export const board = query({
  args: { sprintId: v.id("sprints") },
  handler: async (ctx, { sprintId }) => {
    const sprint = await ctx.db.get(sprintId);
    if (!sprint) return null;
    try {
      await requireWorkspaceMember(ctx, sprint.workspaceId);
    } catch {
      return null;
    }

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
      .collect();

    const listCache = new Map<Id<"lists">, Doc<"lists"> | null>();
    const statusCache = new Map<
      Id<"listStatuses">,
      Doc<"listStatuses"> | null
    >();

    const out: ScrumBoardTask[] = [];
    for (const t of tasks) {
      let list = listCache.get(t.listId);
      if (list === undefined) {
        list = await ctx.db.get(t.listId);
        listCache.set(t.listId, list);
      }
      let status = statusCache.get(t.statusId);
      if (status === undefined) {
        status = await ctx.db.get(t.statusId);
        statusCache.set(t.statusId, status);
      }

      const checklist = t.checklist ?? [];
      let blockedOpenCount = 0;
      for (const blockerId of t.blockedByTaskIds ?? []) {
        const blocker = await ctx.db.get(blockerId);
        if (!blocker) continue;
        const blockerStatus = await ctx.db.get(blocker.statusId);
        if (
          blockerStatus?.category !== "complete" &&
          blockerStatus?.category !== "closed"
        ) {
          blockedOpenCount++;
        }
      }

      out.push({
        _id: t._id,
        title: t.title,
        listId: t.listId,
        listName: list?.name ?? "Unknown list",
        priority: t.priority,
        assigneeClerkIds: t.assigneeClerkIds,
        estimatePoints: t.estimatePoints,
        milestone: t.milestone,
        checklistDone: checklist.filter((c) => c.done).length,
        checklistTotal: checklist.length,
        blockedOpenCount,
        statusId: t.statusId,
        statusName: status?.name ?? "?",
        statusCategory: status?.category ?? "open",
        statusColor: status?.color ?? "#c9ccd4",
      });
    }

    const members: ScrumBoardMember[] = [];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", sprint.workspaceId),
      )
      .collect();
    for (const m of memberships) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
        .unique();
      if (user) {
        members.push({
          id: user.clerkId,
          name: user.name ?? user.email,
          kind: "user",
        });
      }
    }
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", sprint.workspaceId),
      )
      .collect();
    for (const a of agents) {
      members.push({ id: a._id, name: a.name, kind: "agent" });
    }

    return { sprint, tasks: out, members };
  },
});

// Move one card to a new column. `category` is the board's coarse column,
// not a specific statusId — every list can name/color its own workflow
// stages differently, so we resolve the task's OWN list's lowest-position
// status in that category and route the change through updateTaskCore
// (same core the List/Board views use), so blockers/approval
// gates/automations/recurrence/events all still apply identically here.
export const moveTask = mutation({
  args: {
    taskId: v.id("tasks"),
    category: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("complete"),
      v.literal("closed"),
    ),
  },
  handler: async (ctx, { taskId, category }) => {
    const { task, identity } = await requireTaskAccess(ctx, taskId);

    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    const target = statuses
      .filter((s) => s.category === category)
      .sort((a, b) => a.position - b.position)[0];
    if (!target) {
      throw new Error(
        `This task's list has no "${category.replace("_", " ")}" status configured`,
      );
    }
    if (target._id === task.statusId) return;

    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(ctx, { taskId, statusId: target._id }, actor);
  },
});
