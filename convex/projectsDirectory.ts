// Searchable all-projects directory: every list ("project") the current
// user can access, across their personal space and every workspace they're
// a member of — so a company with thousands of projects stays navigable
// from one screen instead of only the sidebar tree.
//
// Access shape mirrors homeOverview.get: personal space + member
// workspaces' spaces, with archived spaces skipped outright and private
// spaces gated through the same canAccessSpace check every other read
// uses. Nothing here bypasses _authz — a project only appears if the
// viewer could already open the space that contains it.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessSpace } from "./_authz";
import { getRollup } from "./rollups";

const MAX_ROWS = 500;

const projectStatusValidator = v.union(
  v.literal("on_track"),
  v.literal("at_risk"),
  v.literal("off_track"),
  v.literal("paused"),
);

export type ProjectDirectoryRow = {
  listId: Id<"lists">;
  name: string;
  place: string;
  description?: string;
  projectStatus?: Doc<"lists">["projectStatus"];
  targetDate?: number;
  color?: string;
  total: number;
  done: number;
  inProgress: number;
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

// Rollup fallback for lists that predate the rollups table or have drifted
// out of sync — same shape as homeOverview's scan, just without the
// due-date bookkeeping this surface doesn't need.
async function countTasks(
  ctx: QueryCtx,
  listId: Id<"lists">,
): Promise<{ total: number; done: number; inProgress: number }> {
  const statuses = await ctx.db
    .query("listStatuses")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  const doneIds = new Set(
    statuses
      .filter((s) => s.category === "complete" || s.category === "closed")
      .map((s) => s._id),
  );
  const inProgressIds = new Set(
    statuses.filter((s) => s.category === "in_progress").map((s) => s._id),
  );
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  let done = 0;
  let inProgress = 0;
  for (const t of tasks) {
    if (doneIds.has(t.statusId)) done += 1;
    else if (inProgressIds.has(t.statusId)) inProgress += 1;
  }
  return { total: tasks.length, done, inProgress };
}

export const list = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(projectStatusValidator),
  },
  handler: async (
    ctx,
    { search, status },
  ): Promise<{ rows: ProjectDirectoryRow[]; totalCount: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { rows: [], totalCount: 0 };
    const subject = identity.subject;

    // ── Scope: personal space + every accessible space in every member
    // workspace. Archived spaces are dropped outright; private spaces go
    // through the exact same canAccessSpace gate every other human read
    // uses, so a private space's projects never leak to a non-member. ──
    const scopes: { spaceId: Id<"spaces">; place: string }[] = [];

    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", subject),
      )
      .unique();
    if (personal && !personal.archivedAt) {
      scopes.push({ spaceId: personal._id, place: `Personal · ${personal.name}` });
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
        if (sp.archivedAt) continue;
        if (!(await canAccessSpace(ctx, sp, { subject }))) continue;
        scopes.push({ spaceId: sp._id, place: `${ws.name} · ${sp.name}` });
      }
    }

    const needle = search?.trim().toLowerCase();
    const matched: ProjectDirectoryRow[] = [];

    for (const sc of scopes) {
      const lists = await listsForSpace(ctx, sc.spaceId);
      for (const l of lists) {
        if (status && l.projectStatus !== status) continue;
        if (needle) {
          const haystack = `${l.name} ${l.description ?? ""}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }

        const rollup = await getRollup(ctx, l._id);
        const counts = rollup ?? (await countTasks(ctx, l._id));

        matched.push({
          listId: l._id,
          name: l.name,
          place: sc.place,
          description: l.description,
          projectStatus: l.projectStatus,
          targetDate: l.targetDate,
          color: l.color,
          total: counts.total,
          done: counts.done,
          inProgress: counts.inProgress,
        });
      }
    }

    matched.sort((a, b) => a.name.localeCompare(b.name));
    return { rows: matched.slice(0, MAX_ROWS), totalCount: matched.length };
  },
});
