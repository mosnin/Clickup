import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
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
