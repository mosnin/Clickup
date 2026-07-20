// Phase F — workspace Portfolio timeline: cross-project rows for every
// list (project) the caller can see across a workspace, laid out on a
// shared date axis. Read-only; the frontend renders bars + milestones.
//
// Walks spaces -> folders -> lists -> tasks for the given workspace, same
// O(tasks-in-scope) shape as homeOverview / reports.workspaceSummary; fine
// at target scale. Private spaces are skipped unless the caller passes
// _authz.canAccessSpace; archived spaces are always skipped (their data
// stays, it just doesn't show up on live surfaces).

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessSpace, requireIdentity, type Identity } from "./_authz";
import { getRollup } from "./rollups";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SPAN_MS = 14 * DAY_MS;
const MAX_MILESTONES_PER_LIST = 20;

export type PortfolioRow = {
  listId: Id<"lists">;
  name: string;
  description?: string;
  spaceName: string;
  health?: Doc<"lists">["projectStatus"];
  ownerActorId?: string;
  total: number;
  done: number;
  inProgress: number;
  start: number;
  end: number;
  targetDate?: number;
  milestones: {
    taskId: Id<"tasks">;
    title: string;
    dueDate: number;
    done: boolean;
  }[];
};

// Mirrors the membership check in convex/sprints.ts. Queries can't throw
// their way into a nice UI state, so callers wrap this and return null on
// failure rather than surfacing a raw error.
async function requireWorkspaceMember(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Identity> {
  const identity = await requireIdentity(ctx);
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!member) throw new Error("Forbidden");
  return identity;
}

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

export const forWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (
    ctx,
    { workspaceId },
  ): Promise<{
    rows: PortfolioRow[];
    minDate: number;
    maxDate: number;
  } | null> => {
    let identity: Identity;
    try {
      identity = await requireWorkspaceMember(ctx, workspaceId);
    } catch {
      return null;
    }

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    const rows: PortfolioRow[] = [];
    const now = Date.now();

    for (const space of spaces) {
      if (space.archivedAt) continue;
      if (!(await canAccessSpace(ctx, space, identity))) continue;

      const lists = await listsForSpace(ctx, space._id);
      for (const list of lists) {
        const statuses = await ctx.db
          .query("listStatuses")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        const categoryByStatus = new Map(
          statuses.map((s) => [s._id, s.category]),
        );

        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();

        const rollup = await getRollup(ctx, list._id);
        let total: number;
        let done: number;
        let inProgress: number;
        if (rollup) {
          total = rollup.total;
          done = rollup.done;
          inProgress = rollup.inProgress;
        } else {
          total = tasks.length;
          done = 0;
          inProgress = 0;
          for (const t of tasks) {
            const category = categoryByStatus.get(t.statusId);
            if (category === "complete" || category === "closed") done += 1;
            else if (category === "in_progress") inProgress += 1;
          }
        }

        const starts = tasks
          .map((t) => t.startDate)
          .filter((d): d is number => d !== undefined);
        const dueDates = tasks
          .map((t) => t.dueDate)
          .filter((d): d is number => d !== undefined);

        const start = starts.length > 0 ? Math.min(...starts) : list.createdAt;
        const maxDue = dueDates.length > 0 ? Math.max(...dueDates) : undefined;
        let end = list.targetDate ?? maxDue ?? start + DEFAULT_SPAN_MS;
        if (end < start) end = start + DAY_MS;

        const milestones = tasks
          .filter(
            (t): t is Doc<"tasks"> & { dueDate: number } =>
              t.milestone === true && t.dueDate !== undefined,
          )
          .sort((a, b) => a.dueDate - b.dueDate)
          .slice(0, MAX_MILESTONES_PER_LIST)
          .map((t) => {
            const category = categoryByStatus.get(t.statusId);
            return {
              taskId: t._id,
              title: t.title,
              dueDate: t.dueDate,
              done: category === "complete" || category === "closed",
            };
          });

        rows.push({
          listId: list._id,
          name: list.name,
          description: list.description,
          spaceName: space.name,
          health: list.projectStatus,
          ownerActorId: list.ownerActorId,
          total,
          done,
          inProgress,
          start,
          end,
          targetDate: list.targetDate,
          milestones,
        });
      }
    }

    rows.sort((a, b) => a.start - b.start);

    if (rows.length === 0) {
      return { rows: [], minDate: now, maxDate: now };
    }
    const minDate = Math.min(...rows.map((r) => r.start));
    const maxDate = Math.max(...rows.map((r) => r.end));
    return { rows, minDate, maxDate };
  },
});
