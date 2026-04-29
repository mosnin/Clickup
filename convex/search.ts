import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Cross-table search for the command palette. Walks the user's visible
// scope (personal space + every workspace they're a member of), gathers
// every list / task / doc / whiteboard, and returns matches against the
// query string ranked by where the match fell.
//
// We do this with a substring scan rather than vector search because:
//   - The palette wants exact-keystroke responsiveness on every '/' tap.
//   - Vector search costs an embed per query.
//   - A workspace's tree is small enough (low thousands) for this to be
//     fast inside one Convex query.
// Once any workspace exceeds ~5k items this should move to a paginated
// cursor + a per-table search index.

export const palette = query({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { q, limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const needle = q.trim().toLowerCase();
    const cap = limit ?? 12;
    if (!needle) return [];

    type Hit =
      | { kind: "list"; id: Id<"lists">; name: string; rank: number }
      | { kind: "task"; id: Id<"tasks">; title: string; listId: Id<"lists">; rank: number }
      | { kind: "doc"; id: Id<"docs">; title: string; rank: number }
      | { kind: "whiteboard"; id: Id<"whiteboards">; title: string; rank: number }
      | { kind: "person"; clerkId: string; name: string; email: string; rank: number };
    const hits: Hit[] = [];

    function rankFor(value: string): number {
      const lower = value.toLowerCase();
      const i = lower.indexOf(needle);
      if (i < 0) return -1;
      // Prefix match wins over mid-string match; shorter strings tie-break.
      return i === 0 ? 0 + value.length : 100 + i;
    }

    // Personal scope: spaces under this user + everything beneath.
    // Workspace scope: every membership-linked workspace + everything beneath.
    const personalSpaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (qq) =>
        qq.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .collect();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (qq) => qq.eq("userClerkId", identity.subject))
      .collect();
    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaceSpaces: Doc<"spaces">[] = [];
    for (const wsId of workspaceIds) {
      const spaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "workspace").eq("parentId", wsId),
        )
        .collect();
      workspaceSpaces.push(...spaces);
    }
    const allSpaces = [...personalSpaces, ...workspaceSpaces];

    // Lists (direct under spaces + under folders) and docs/whiteboards
    // attached to those spaces.
    for (const space of allSpaces) {
      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (qq) => qq.eq("spaceId", space._id))
        .collect();
      const folderListsArr = await Promise.all(
        folders.map((f) =>
          ctx.db
            .query("lists")
            .withIndex("by_parent", (qq) =>
              qq.eq("parentType", "folder").eq("parentId", f._id),
            )
            .collect(),
        ),
      );
      const allLists = [...directLists, ...folderListsArr.flat()];

      for (const list of allLists) {
        const r = rankFor(list.name);
        if (r >= 0) {
          hits.push({ kind: "list", id: list._id, name: list.name, rank: r });
        }
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (qq) => qq.eq("listId", list._id))
          .collect();
        for (const t of tasks) {
          const tr = rankFor(t.title);
          if (tr >= 0) {
            hits.push({
              kind: "task",
              id: t._id,
              title: t.title,
              listId: t.listId,
              rank: tr,
            });
          }
        }
      }

      const docs = await ctx.db
        .query("docs")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const d of docs) {
        const r = rankFor(d.title);
        if (r >= 0) hits.push({ kind: "doc", id: d._id, title: d.title, rank: r });
      }
      const whiteboards = await ctx.db
        .query("whiteboards")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const w of whiteboards) {
        const r = rankFor(w.title);
        if (r >= 0) {
          hits.push({
            kind: "whiteboard",
            id: w._id,
            title: w.title,
            rank: r,
          });
        }
      }
    }

    // Workspace-level docs / whiteboards
    for (const wsId of workspaceIds) {
      const docs = await ctx.db
        .query("docs")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "workspace").eq("parentId", wsId),
        )
        .collect();
      for (const d of docs) {
        const r = rankFor(d.title);
        if (r >= 0) hits.push({ kind: "doc", id: d._id, title: d.title, rank: r });
      }
      const wbs = await ctx.db
        .query("whiteboards")
        .withIndex("by_parent", (qq) =>
          qq.eq("parentType", "workspace").eq("parentId", wsId),
        )
        .collect();
      for (const w of wbs) {
        const r = rankFor(w.title);
        if (r >= 0) {
          hits.push({
            kind: "whiteboard",
            id: w._id,
            title: w.title,
            rank: r,
          });
        }
      }
    }

    // People — every member of every workspace the caller is in.
    const peopleSeen = new Set<string>();
    for (const wsId of workspaceIds) {
      const ms = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (qq) => qq.eq("workspaceId", wsId))
        .collect();
      for (const m of ms) {
        if (peopleSeen.has(m.userClerkId)) continue;
        peopleSeen.add(m.userClerkId);
        const u = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (qq) => qq.eq("clerkId", m.userClerkId))
          .unique();
        if (!u) continue;
        const candidate = `${u.name ?? ""} ${u.email}`;
        const r = rankFor(candidate);
        if (r >= 0) {
          hits.push({
            kind: "person",
            clerkId: u.clerkId,
            name: u.name ?? u.email,
            email: u.email,
            rank: r,
          });
        }
      }
    }

    return hits.sort((a, b) => a.rank - b.rank).slice(0, cap);
  },
});
