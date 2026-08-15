// Searchable all-projects directory: every project the current user can
// access, across their personal space and every workspace they're a member
// of — so a company with hundreds of projects stays navigable from one
// screen instead of only the sidebar tree.
//
// A row is a Project, and its counts are the sum of its lists. Lists sitting
// straight in a Space are deliberately absent: they are boards nobody
// promoted to a project, and padding the directory with them would make the
// screen answer a different question than the one it is for.
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
import { listUserSpaces } from "./_userSpaces";
import { getRollup } from "./rollups";

const MAX_ROWS = 500;

const projectStatusValidator = v.union(
  v.literal("on_track"),
  v.literal("at_risk"),
  v.literal("off_track"),
  v.literal("paused"),
);

export type ProjectDirectoryRow = {
  projectId: Id<"projects">;
  name: string;
  place: string;
  description?: string;
  projectStatus?: Doc<"projects">["projectStatus"];
  targetDate?: number;
  color?: string;
  ownerActorId?: string;
  listCount: number;
  total: number;
  done: number;
  inProgress: number;
  // ── Sort/group inputs ──
  // Sidebar manual order within the parent space.
  position: number;
  // Cheapest available "recent activity" signal: the newest rollup
  // updatedAt across the project's lists (bumped on every task write) when
  // any rollup row exists, else the project's createdAt. No extra scans.
  activityAt: number;
  // Structured place parts so the client can group without string-splitting
  // the display-oriented `place`. workspaceName is "Personal" for the
  // viewer's personal space.
  workspaceName: string;
  spaceName: string;
  // ── Roadmap context, when this project sits in a roadmap phase ──
  roadmapName?: string;
  phaseName?: string;
};

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
    const scopes: {
      spaceId: Id<"spaces">;
      place: string;
      workspaceId?: Id<"workspaces">;
      workspaceName: string;
      spaceName: string;
    }[] = [];

    for (const personal of await listUserSpaces(ctx, subject)) {
      scopes.push({
        spaceId: personal._id,
        place: `Personal · ${personal.name}`,
        workspaceName: "Personal",
        spaceName: personal.name,
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
        if (sp.archivedAt) continue;
        if (!(await canAccessSpace(ctx, sp, { subject }))) continue;
        scopes.push({
          spaceId: sp._id,
          place: `${ws.name} · ${sp.name}`,
          workspaceId: m.workspaceId,
          workspaceName: ws.name,
          spaceName: sp.name,
        });
      }
    }

    const needle = search?.trim().toLowerCase();
    const matched: ProjectDirectoryRow[] = [];

    // Roadmap docs are shared across many projects in the same workspace —
    // fetch each at most once per query, keyed by id. `null` caches a
    // miss (deleted roadmap with a stale pointer) so we don't re-fetch it.
    const roadmapCache = new Map<Id<"roadmaps">, Doc<"roadmaps"> | null>();
    async function getRoadmap(
      id: Id<"roadmaps">,
    ): Promise<Doc<"roadmaps"> | null> {
      const hit = roadmapCache.get(id);
      if (hit !== undefined) return hit;
      const doc = await ctx.db.get(id);
      roadmapCache.set(id, doc);
      return doc;
    }

    for (const sc of scopes) {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", sc.spaceId))
        .collect();

      for (const p of projects) {
        if (p.archivedAt !== undefined) continue;
        if (status && p.projectStatus !== status) continue;
        if (needle) {
          const haystack = `${p.name} ${p.description ?? ""}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }

        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", p._id),
          )
          .collect();

        let total = 0;
        let done = 0;
        let inProgress = 0;
        let activityAt = p.createdAt;
        for (const l of lists) {
          const rollup = await getRollup(ctx, l._id);
          const counts = rollup ?? (await countTasks(ctx, l._id));
          total += counts.total;
          done += counts.done;
          inProgress += counts.inProgress;
          if (rollup && rollup.updatedAt > activityAt) {
            activityAt = rollup.updatedAt;
          }
        }

        // Roadmap context: resolve the phase name via the cached roadmap
        // doc. Roadmaps are workspace-level, so only attach when the
        // roadmap belongs to this scope's workspace — a stale or
        // cross-workspace pointer never leaks another workspace's roadmap
        // name to this viewer.
        let roadmapName: string | undefined;
        let phaseName: string | undefined;
        if (p.roadmapId && sc.workspaceId) {
          const roadmap = await getRoadmap(p.roadmapId);
          if (roadmap && roadmap.workspaceId === sc.workspaceId) {
            roadmapName = roadmap.name;
            phaseName = roadmap.phases.find(
              (ph) => ph.id === p.roadmapPhaseId,
            )?.name;
          }
        }

        matched.push({
          projectId: p._id,
          name: p.name,
          place: sc.place,
          description: p.description,
          projectStatus: p.projectStatus,
          targetDate: p.targetDate,
          color: p.color,
          ownerActorId: p.ownerActorId,
          listCount: lists.length,
          total,
          done,
          inProgress,
          position: p.position,
          activityAt,
          workspaceName: sc.workspaceName,
          spaceName: sc.spaceName,
          roadmapName,
          phaseName,
        });
      }
    }

    matched.sort((a, b) => a.name.localeCompare(b.name));
    return { rows: matched.slice(0, MAX_ROWS), totalCount: matched.length };
  },
});
