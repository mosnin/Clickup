import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireListAccess, requireTaskAccess } from "./_authz";

// Dependency-graph data for a list's Network view. Reuses the same
// `blockedByTaskIds` edges the claim/blocker system already enforces
// (tasks.ts, _authz.ts) — this is a read-only projection, no new state.
//
// blockedByTaskIds is not scoped to the list it's declared on: a task can
// be blocked by a task from a different list (even a different space), so
// long as the blocking task is a valid id. In-list blockers become graph
// edges; cross-list blockers can't be laid out in this list's graph, so
// they're surfaced separately as a badge with just enough detail (title,
// list, still-open?) to explain why a "root" node isn't really unblocked.

export type NetworkCrossListBlocker = {
  taskId: Id<"tasks">;
  title: string;
  listId: Id<"lists">;
  listName: string;
  open: boolean;
};

export type NetworkTask = {
  _id: Id<"tasks">;
  title: string;
  statusId: Id<"listStatuses">;
  statusName: string;
  statusColor: string;
  statusCategory: Doc<"listStatuses">["category"];
  priority?: Doc<"tasks">["priority"];
  assigneeClerkIds: string[];
  estimatePoints?: number;
  milestone?: boolean;
  parentTaskId?: Id<"tasks">;
  position: number;
  /** Blockers that are also on this list — these become graph edges. */
  blockedByTaskIds: Id<"tasks">[];
  /** Blockers that live outside this list, badged rather than drawn. */
  crossListBlockers: NetworkCrossListBlocker[];
};

export const forList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }): Promise<NetworkTask[] | null> => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return null;
    }

    const [tasks, statuses] = await Promise.all([
      ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
      ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
    ]);

    const statusById = new Map(statuses.map((s) => [s._id, s]));
    const inListIds = new Set(tasks.map((t) => t._id));

    // Cache cross-list blocker resolution: the same task can block several
    // tasks on this list, and requireTaskAccess does a hierarchy walk.
    const crossCache = new Map<Id<"tasks">, NetworkCrossListBlocker | null>();

    async function resolveCrossListBlocker(
      blockerId: Id<"tasks">,
    ): Promise<NetworkCrossListBlocker | null> {
      if (crossCache.has(blockerId)) return crossCache.get(blockerId) ?? null;
      let resolved: NetworkCrossListBlocker | null = null;
      try {
        const { task: blockerTask, list: blockerList } =
          await requireTaskAccess(ctx, blockerId);
        const blockerStatus = await ctx.db.get(blockerTask.statusId);
        const open = blockerStatus
          ? blockerStatus.category !== "complete" &&
            blockerStatus.category !== "closed"
          : true;
        resolved = {
          taskId: blockerTask._id,
          title: blockerTask.title,
          listId: blockerList._id,
          listName: blockerList.name,
          open,
        };
      } catch {
        // Deleted or inaccessible (e.g. lives in a space the caller lost
        // access to) — drop silently rather than leaking a title.
        resolved = null;
      }
      crossCache.set(blockerId, resolved);
      return resolved;
    }

    const out: NetworkTask[] = [];
    for (const task of tasks) {
      const status = statusById.get(task.statusId);
      const blockerIds = task.blockedByTaskIds ?? [];
      const inListBlockers: Id<"tasks">[] = [];
      const crossListBlockers: NetworkCrossListBlocker[] = [];

      for (const blockerId of blockerIds) {
        if (inListIds.has(blockerId)) {
          inListBlockers.push(blockerId);
          continue;
        }
        const cross = await resolveCrossListBlocker(blockerId);
        if (cross) crossListBlockers.push(cross);
      }

      out.push({
        _id: task._id,
        title: task.title,
        statusId: task.statusId,
        statusName: status?.name ?? "Unknown",
        statusColor: status?.color ?? "#c9ccd4",
        statusCategory: status?.category ?? "open",
        priority: task.priority,
        assigneeClerkIds: task.assigneeClerkIds,
        estimatePoints: task.estimatePoints,
        milestone: task.milestone,
        parentTaskId: task.parentTaskId,
        position: task.position,
        blockedByTaskIds: inListBlockers,
        crossListBlockers,
      });
    }

    return out;
  },
});
