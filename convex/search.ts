// Global search across tasks, docs, lists, and spaces (access-checked).
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

const EMPTY = { tasks: [], docs: [], lists: [], spaces: [] } as const;

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
    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", subject),
      )
      .unique();
    if (personal && !personal.archivedAt) spaces.push(personal);

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
    const docsOut: {
      docId: Id<"docs">;
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

      if (docsOut.length < CAP) {
        const docs = await ctx.db
          .query("docs")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "space").eq("parentId", space._id),
          )
          .collect();
        for (const d of docs) {
          if (docsOut.length >= CAP) break;
          if (matches(d.title)) {
            docsOut.push({ docId: d._id, title: d.title, spaceName: space.name });
          }
        }
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

    return {
      tasks: tasksOut,
      docs: docsOut,
      lists: listsOut,
      spaces: spacesOut,
    };
  },
});
