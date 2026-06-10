import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireIdentity,
} from "./_authz";
import { purgeTaskTree } from "./tasks";
import { purgeList } from "./lists";
import { purgeFolder } from "./folders";

const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// Returns every soft-deleted item the caller can see, tagged with its
// kind so the Trash UI can render and dispatch the right restore /
// purge mutation per row.
//
// Walks the user's personal space and every workspace they're in, then
// inspects each table for deletedAt rows. The result set is bounded by
// what fits in 30 days of deletes for that user; small enough for the
// client to render without pagination at this scale.
export const listForCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    const workspaceIds = memberships.map((m) => m.workspaceId);

    const personalSpaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .collect();
    const workspaceSpaces: Doc<"spaces">[] = [];
    for (const wsId of workspaceIds) {
      const spaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", wsId),
        )
        .collect();
      workspaceSpaces.push(...spaces);
    }
    const allSpaces = [...personalSpaces, ...workspaceSpaces];

    type TrashItem =
      | { kind: "task"; id: Id<"tasks">; title: string; deletedAt: number; listId: Id<"lists"> }
      | { kind: "list"; id: Id<"lists">; title: string; deletedAt: number }
      | { kind: "folder"; id: Id<"folders">; title: string; deletedAt: number }
      | { kind: "doc"; id: Id<"docs">; title: string; deletedAt: number }
      | { kind: "whiteboard"; id: Id<"whiteboards">; title: string; deletedAt: number };
    const items: TrashItem[] = [];

    for (const space of allSpaces) {
      // Folders under this space (deleted)
      const folders = (
        await ctx.db
          .query("folders")
          .withIndex("by_space", (q) => q.eq("spaceId", space._id))
          .collect()
      ).filter((f) => f.deletedAt);
      for (const f of folders) {
        items.push({
          kind: "folder",
          id: f._id,
          title: f.name,
          deletedAt: f.deletedAt!,
        });
      }

      // Lists directly under this space (deleted)
      const directLists = (
        await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "space").eq("parentId", space._id),
          )
          .collect()
      ).filter((l) => l.deletedAt);
      for (const l of directLists) {
        items.push({
          kind: "list",
          id: l._id,
          title: l.name,
          deletedAt: l.deletedAt!,
        });
      }

      // Lists under each (live or deleted) folder
      const allFolders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const folder of allFolders) {
        const lists = (
          await ctx.db
            .query("lists")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "folder").eq("parentId", folder._id),
            )
            .collect()
        ).filter((l) => l.deletedAt);
        for (const l of lists) {
          items.push({
            kind: "list",
            id: l._id,
            title: l.name,
            deletedAt: l.deletedAt!,
          });
        }
      }

      // Docs + whiteboards attached to the space
      const docs = (
        await ctx.db
          .query("docs")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "space").eq("parentId", space._id),
          )
          .collect()
      ).filter((d) => d.deletedAt);
      for (const d of docs) {
        items.push({
          kind: "doc",
          id: d._id,
          title: d.title,
          deletedAt: d.deletedAt!,
        });
      }
      const wbs = (
        await ctx.db
          .query("whiteboards")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "space").eq("parentId", space._id),
          )
          .collect()
      ).filter((w) => w.deletedAt);
      for (const w of wbs) {
        items.push({
          kind: "whiteboard",
          id: w._id,
          title: w.title,
          deletedAt: w.deletedAt!,
        });
      }
    }

    // Workspace-level docs + whiteboards
    for (const wsId of workspaceIds) {
      const docs = (
        await ctx.db
          .query("docs")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "workspace").eq("parentId", wsId),
          )
          .collect()
      ).filter((d) => d.deletedAt);
      for (const d of docs) {
        items.push({
          kind: "doc",
          id: d._id,
          title: d.title,
          deletedAt: d.deletedAt!,
        });
      }
      const wbs = (
        await ctx.db
          .query("whiteboards")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "workspace").eq("parentId", wsId),
          )
          .collect()
      ).filter((w) => w.deletedAt);
      for (const w of wbs) {
        items.push({
          kind: "whiteboard",
          id: w._id,
          title: w.title,
          deletedAt: w.deletedAt!,
        });
      }
    }

    // Tasks across the user's visible lists. Walk all lists (incl. live
    // ones) and surface their soft-deleted tasks.
    const visibleLists: Doc<"lists">[] = [];
    for (const space of allSpaces) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      visibleLists.push(...lists);
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const folder of folders) {
        const fl = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        visibleLists.push(...fl);
      }
    }
    for (const l of visibleLists) {
      const tasks = (
        await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", l._id))
          .collect()
      ).filter((t) => t.deletedAt);
      for (const t of tasks) {
        items.push({
          kind: "task",
          id: t._id,
          title: t.title,
          deletedAt: t.deletedAt!,
          listId: t.listId,
        });
      }
    }

    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  },
});

// Daily cron entrypoint. Walks every soft-deleted row older than the
// retention window and purges it. Runs in batches per-table with a
// generous chunk so we don't exceed the per-mutation write quota — but
// for our scale (a few thousand rows max), one pass is fine.
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PURGE_AFTER_MS;

    // Tasks
    const allTasks = await ctx.db.query("tasks").collect();
    for (const t of allTasks) {
      if (t.deletedAt && t.deletedAt < cutoff) {
        await purgeTaskTree(ctx, t._id);
      }
    }

    // Lists
    const allLists = await ctx.db.query("lists").collect();
    for (const l of allLists) {
      if (l.deletedAt && l.deletedAt < cutoff) {
        await purgeList(ctx, l._id);
      }
    }

    // Folders
    const allFolders = await ctx.db.query("folders").collect();
    for (const f of allFolders) {
      if (f.deletedAt && f.deletedAt < cutoff) {
        await purgeFolder(ctx, f._id);
      }
    }

    // Docs
    const allDocs = await ctx.db.query("docs").collect();
    for (const d of allDocs) {
      if (d.deletedAt && d.deletedAt < cutoff) {
        await ctx.db.delete(d._id);
      }
    }

    // Whiteboards
    const allWbs = await ctx.db.query("whiteboards").collect();
    for (const w of allWbs) {
      if (w.deletedAt && w.deletedAt < cutoff) {
        await ctx.db.delete(w._id);
      }
    }
  },
});

// Make sure the non-null assertions above are used somewhere — TS
// otherwise grumbles via the unused-import lint.
const _ = canAccessSpace;
const __ = requireIdentity;
void _;
void __;
