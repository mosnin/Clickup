import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// One-shot data migrations, run by hand against a deployment.
//
// These are internal on purpose: nothing in the app should be able to trigger
// a migration, and there is no UI for them. Run with
//   npx convex run migrations:foldersToProjects '{"dryRun": true}'
// read the counts, then run again with dryRun false.
//
// Every migration here must be idempotent. A partial run followed by a full
// run has to land in the same place as one clean run, because the alternative
// is hand-repairing production.

/** The project-identity fields that used to live on `lists`. */
const MOVED_FIELDS = [
  "projectStatus",
  "ownerActorId",
  "notes",
  "targetDate",
  "roadmapId",
  "roadmapPhaseId",
  "roadmapPosition",
] as const;

type MovedField = (typeof MOVED_FIELDS)[number];

function carriesProjectIdentity(list: Doc<"lists">): boolean {
  return MOVED_FIELDS.some(
    (f) => (list as Record<string, unknown>)[f] !== undefined,
  );
}

/** Copies the moved fields off a list, returning the subset that was set. */
function projectFieldsFrom(list: Doc<"lists">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of MOVED_FIELDS) {
    const value = (list as Record<string, unknown>)[f];
    if (value !== undefined) out[f] = value;
  }
  return out;
}

/** The patch that clears them again, so a second run is a no-op. */
const CLEAR_MOVED: Record<MovedField, undefined> = {
  projectStatus: undefined,
  ownerActorId: undefined,
  notes: undefined,
  targetDate: undefined,
  roadmapId: undefined,
  roadmapPhaseId: undefined,
  roadmapPosition: undefined,
};

async function nextProjectPosition(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
): Promise<number> {
  const existing = await ctx.db
    .query("projects")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
  return existing.reduce((max, p) => Math.max(max, p.position), -1) + 1;
}

/**
 * Introduces the Project layer: Workspace → Space → Project → List → Task.
 *
 * Three cases, in order:
 *
 *  1. Every `folders` row becomes a `projects` row and its lists are
 *     reparented. A folder was already this layer with none of the meaning.
 *  2. Every list sitting directly in a space that carries project identity
 *     (a status, an owner, notes, a target date, roadmap membership) gets a
 *     project wrapped around it, named after the list, inheriting that
 *     identity. These are the rows that were relying on "a list IS a project".
 *  3. A bare list directly in a space stays where it is. Wrapping it would
 *     invent structure the user never asked for.
 *
 * Roadmap membership follows the identity onto the project, and the list's
 * copy is cleared so there is exactly one source of truth.
 */
export const foldersToProjects = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }) => {
    const report = {
      dryRun,
      foldersConverted: 0,
      listsReparentedFromFolders: 0,
      listsWrappedInNewProject: 0,
      bareListsLeftInSpace: 0,
      identityFieldsCleared: 0,
      skippedFoldersAlreadyDone: 0,
    };

    // ── 1. folders → projects ──────────────────────────────────────────────
    const folders = await ctx.db.query("folders").collect();
    for (const folder of folders) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "folder").eq("parentId", folder._id),
        )
        .collect();

      // Idempotency: a previous run may have created the project already.
      // Match on (spaceId, name) because the folder id is not preserved.
      const siblings = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", folder.spaceId))
        .collect();
      const already = siblings.find((p) => p.name === folder.name);
      if (already && lists.length === 0) {
        report.skippedFoldersAlreadyDone += 1;
        continue;
      }

      let projectId = already?._id;
      if (!projectId) {
        report.foldersConverted += 1;
        if (!dryRun) {
          projectId = await ctx.db.insert("projects", {
            name: folder.name,
            spaceId: folder.spaceId,
            position: folder.position,
            createdAt: folder.createdAt,
          });
        }
      }

      for (const list of lists) {
        report.listsReparentedFromFolders += 1;
        if (!dryRun && projectId) {
          await ctx.db.patch(list._id, {
            parentType: "project",
            parentId: projectId,
          });
        }
      }

      if (!dryRun) await ctx.db.delete(folder._id);
    }

    // ── 2 & 3. space-parented lists ───────────────────────────────────────
    const spaces = await ctx.db.query("spaces").collect();
    for (const space of spaces) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();

      for (const list of lists) {
        if (!carriesProjectIdentity(list)) {
          report.bareListsLeftInSpace += 1;
          continue;
        }
        report.listsWrappedInNewProject += 1;
        report.identityFieldsCleared += 1;
        if (dryRun) continue;

        const projectId = await ctx.db.insert("projects", {
          name: list.name,
          spaceId: space._id,
          position: await nextProjectPosition(ctx, space._id),
          createdAt: list.createdAt,
          color: list.color,
          ...projectFieldsFrom(list),
        });
        await ctx.db.patch(list._id, {
          parentType: "project",
          parentId: projectId,
          ...CLEAR_MOVED,
        });
      }
    }

    // Any list already inside a project can still be carrying the old
    // fields if an earlier partial run reparented it without clearing them.
    const projects = await ctx.db.query("projects").collect();
    for (const project of projects) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "project").eq("parentId", project._id),
        )
        .collect();
      for (const list of lists) {
        if (!carriesProjectIdentity(list)) continue;
        report.identityFieldsCleared += 1;
        if (dryRun) continue;
        // The project wins if it already has a value; otherwise adopt the
        // list's. Never overwrite a value someone has since edited.
        const adopt: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(projectFieldsFrom(list))) {
          if ((project as Record<string, unknown>)[k] === undefined) {
            adopt[k] = val;
          }
        }
        if (Object.keys(adopt).length > 0) {
          await ctx.db.patch(project._id, adopt);
        }
        await ctx.db.patch(list._id, { ...CLEAR_MOVED });
      }
    }

    return report;
  },
});

/**
 * Invariant check for the Project layer, safe to run any time.
 *
 * Read-only. Exists because the migration ran against live data: "it
 * reported the right counts" is not the same claim as "nothing is orphaned".
 * Every finding here is something a user would eventually hit as a broken
 * page or a missing row.
 */
export const auditProjectLayer = internalQuery({
  args: {},
  handler: async (ctx) => {
    const problems: { kind: string; id: string; detail: string }[] = [];

    const projects = await ctx.db.query("projects").collect();
    const lists = await ctx.db.query("lists").collect();
    const folders = await ctx.db.query("folders").collect();

    const spaceIds = new Set(
      (await ctx.db.query("spaces").collect()).map((s) => s._id as string),
    );
    const projectIds = new Set(projects.map((p) => p._id as string));

    // 1. Nothing should still be parented to a folder, and no folders left.
    for (const l of lists) {
      if (l.parentType === "folder") {
        problems.push({
          kind: "list_still_in_folder",
          id: l._id,
          detail: `"${l.name}" still has parentType "folder"`,
        });
      }
    }
    for (const f of folders) {
      problems.push({
        kind: "folder_row_remains",
        id: f._id,
        detail: `folder "${f.name}" was not converted`,
      });
    }

    // 2. Every list's parent must exist. A dangling parentId renders as a
    // list that loads nowhere.
    for (const l of lists) {
      const ok =
        l.parentType === "space"
          ? spaceIds.has(l.parentId)
          : l.parentType === "project"
            ? projectIds.has(l.parentId)
            : false;
      if (!ok) {
        problems.push({
          kind: "orphan_list",
          id: l._id,
          detail: `"${l.name}" points at missing ${l.parentType} ${l.parentId}`,
        });
      }
    }

    // 3. Every project must sit in a real space.
    for (const p of projects) {
      if (!spaceIds.has(p.spaceId)) {
        problems.push({
          kind: "orphan_project",
          id: p._id,
          detail: `"${p.name}" points at missing space ${p.spaceId}`,
        });
      }
    }

    // 4. Project identity must live in exactly one place. A list still
    // carrying it means two sources of truth that will disagree.
    for (const l of lists) {
      const stale = MOVED_FIELDS.filter(
        (f) => (l as Record<string, unknown>)[f] !== undefined,
      );
      if (stale.length > 0) {
        problems.push({
          kind: "list_retains_project_identity",
          id: l._id,
          detail: `"${l.name}" still carries ${stale.join(", ")}`,
        });
      }
    }

    // 5. Roadmap membership must point at a roadmap that exists, and at a
    // phase that still exists on it.
    const roadmaps = new Map(
      (await ctx.db.query("roadmaps").collect()).map((r) => [r._id as string, r]),
    );
    for (const p of projects) {
      if (p.roadmapId === undefined) continue;
      const rm = roadmaps.get(p.roadmapId as string);
      if (!rm) {
        problems.push({
          kind: "project_points_at_missing_roadmap",
          id: p._id,
          detail: `"${p.name}" references roadmap ${p.roadmapId}`,
        });
        continue;
      }
      if (
        p.roadmapPhaseId !== undefined &&
        !rm.phases.some((ph) => ph.id === p.roadmapPhaseId)
      ) {
        problems.push({
          kind: "project_points_at_missing_phase",
          id: p._id,
          detail: `"${p.name}" references phase ${p.roadmapPhaseId} on "${rm.name}"`,
        });
      }
    }

    return {
      counts: {
        projects: projects.length,
        lists: lists.length,
        listsInProjects: lists.filter((l) => l.parentType === "project").length,
        listsInSpaces: lists.filter((l) => l.parentType === "space").length,
        foldersRemaining: folders.length,
        projectsOnRoadmaps: projects.filter((p) => p.roadmapId !== undefined)
          .length,
      },
      healthy: problems.length === 0,
      problems,
    };
  },
});
