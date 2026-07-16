import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// "My Work": every open task assigned to the current user across their
// personal space and every workspace they belong to. Assignees live in an
// array column (not indexable), so this walks the user's accessible lists
// and filters — the same O(tasks-in-scope) shape as reports.workspaceSummary,
// fine at target scale.

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

export const listForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const subject = identity.subject;

    // Every space the user can see: personal + member workspaces'.
    const spaces: Doc<"spaces">[] = [];
    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", subject),
      )
      .unique();
    if (personal) spaces.push(personal);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .collect();
    for (const m of memberships) {
      const wsSpaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", m.workspaceId),
        )
        .collect();
      spaces.push(...wsSpaces);
    }

    const out: {
      _id: Id<"tasks">;
      title: string;
      listId: Id<"lists">;
      listName: string;
      dueDate?: number;
      priority?: Doc<"tasks">["priority"];
      statusId: Id<"listStatuses">;
      statusName: string;
      statusColor: string;
      requiresApproval?: boolean;
      approvedAt?: number;
    }[] = [];

    for (const space of spaces) {
      const lists = await listsForSpace(ctx, space._id);
      for (const list of lists) {
        const statuses = await ctx.db
          .query("listStatuses")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        const statusById = new Map(statuses.map((s) => [s._id, s]));
        const doneIds = new Set(
          statuses
            .filter(
              (s) => s.category === "complete" || s.category === "closed",
            )
            .map((s) => s._id),
        );
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        for (const t of tasks) {
          if (!t.assigneeClerkIds.includes(subject)) continue;
          if (doneIds.has(t.statusId)) continue;
          const status = statusById.get(t.statusId);
          out.push({
            _id: t._id,
            title: t.title,
            listId: list._id,
            listName: list.name,
            dueDate: t.dueDate,
            priority: t.priority,
            statusId: t.statusId,
            statusName: status?.name ?? "—",
            statusColor: status?.color ?? "#c9ccd4",
            requiresApproval: t.requiresApproval,
            approvedAt: t.approvedAt,
          });
        }
      }
    }

    // Soonest due first; no-date last, newest of those first.
    out.sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
    return out;
  },
});
