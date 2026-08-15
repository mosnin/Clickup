// Global search across tasks, pages, lists, and spaces (access-checked).
//
// Walks the same accessible-space set as myWork.ts/sidebar.ts (personal
// space + every member workspace's spaces, private-space-checked via
// _authz.canAccessSpace), then does a case-insensitive substring match on
// names/titles within that set. Capped per bucket so a broad query stays
// cheap and the UI never has to paginate.

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canAccessSpace } from "./_authz";
import { listUserSpaces } from "./_userSpaces";

const CAP = 15;

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
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
  const nested = await Promise.all(
    projects.map((f) =>
      ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "project").eq("parentId", f._id),
        )
        .collect(),
    ),
  );
  return [...direct, ...nested.flat()];
}

const EMPTY = { tasks: [], pages: [], lists: [], spaces: [] } as const;

export const everything = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const needle = text.trim().toLowerCase();
    if (needle.length < 2) return EMPTY;

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return EMPTY;
    const subject = identity.subject;

    // Every space the user can see: personal (always, never archived-out
    // of existence) + accessible, non-archived workspace spaces. Private
    // spaces are gated the same way canAccessSpace gates every other read.
    const spaces: Doc<"spaces">[] = [];
    spaces.push(...(await listUserSpaces(ctx, subject)));

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
      for (const sp of wsSpaces) {
        if (sp.archivedAt) continue;
        if (await canAccessSpace(ctx, sp, { subject })) spaces.push(sp);
      }
    }

    const matches = (name: string) => name.toLowerCase().includes(needle);

    const spacesOut: {
      spaceId: Id<"spaces">;
      name: string;
      private: boolean;
    }[] = [];
    const listsOut: {
      listId: Id<"lists">;
      name: string;
      spaceName: string;
      projectStatus?: Doc<"lists">["projectStatus"];
    }[] = [];
    const pagesOut: {
      pageId: Id<"pages">;
      title: string;
      spaceName: string;
    }[] = [];
    const tasksOut: {
      taskId: Id<"tasks">;
      listId: Id<"lists">;
      title: string;
      listName: string;
    }[] = [];

    for (const space of spaces) {
      if (spacesOut.length < CAP && matches(space.name)) {
        spacesOut.push({
          spaceId: space._id,
          name: space.name,
          private: space.private ?? false,
        });
      }

      const lists = await listsForSpace(ctx, space._id);
      for (const list of lists) {
        if (listsOut.length < CAP && matches(list.name)) {
          listsOut.push({
            listId: list._id,
            name: list.name,
            spaceName: space.name,
            projectStatus: list.projectStatus,
          });
        }

        if (tasksOut.length < CAP) {
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", list._id))
            .collect();
          for (const t of tasks) {
            if (tasksOut.length >= CAP) break;
            if (matches(t.title)) {
              tasksOut.push({
                taskId: t._id,
                listId: list._id,
                title: t.title,
                listName: list.name,
              });
            }
          }
        }
      }
    }

    // Pages — the writing primitive. They live in a scope (a person or a
    // workspace) rather than in a space, so this is one sweep per scope
    // rather than a walk of the tree.
    //
    // Consolidating onto pages while leaving them out of search would make
    // the surviving primitive the one the app can't find, which is the worst
    // possible outcome of a consolidation. Both search indexes are used:
    // titles carry most searches, bodies catch the rest.
    const scopes: { scopeType: "user" | "workspace"; scopeId: string; name: string }[] =
      [{ scopeType: "user", scopeId: subject, name: "Personal" }];
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (ws) {
        scopes.push({
          scopeType: "workspace",
          scopeId: ws._id,
          name: ws.name,
        });
      }
    }

    const seenPages = new Set<string>();
    for (const scope of scopes) {
      if (pagesOut.length >= CAP) break;
      for (const field of ["title", "markdown"] as const) {
        if (pagesOut.length >= CAP) break;
        const hits = await ctx.db
          .query("pages")
          .withSearchIndex(
            field === "title" ? "by_title" : "by_text",
            (q) =>
              q
                .search(field, needle)
                .eq("scopeType", scope.scopeType)
                .eq("scopeId", scope.scopeId),
          )
          .take(CAP);
        for (const page of hits) {
          if (pagesOut.length >= CAP) break;
          if (page.archivedAt !== undefined) continue;
          if (seenPages.has(page._id)) continue;
          seenPages.add(page._id);
          pagesOut.push({
            pageId: page._id,
            title: page.title,
            spaceName: scope.name,
          });
        }
      }
    }

    return {
      tasks: tasksOut,
      pages: pagesOut,
      lists: listsOut,
      spaces: spacesOut,
    };
  },
});
