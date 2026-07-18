import { v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireDocLikeParentAccess, requireIdentity } from "./_authz";

const parentTypeValidator = v.union(
  v.literal("user"),
  v.literal("workspace"),
  v.literal("space"),
);

// Wiki nesting: a subpage's depth is its number of ancestors (a root doc
// has depth 0). Kept shallow so breadcrumbs/move menus stay simple.
const MAX_DOC_DEPTH = 3;

// Counts hops from `doc` up to its root via parentDocId. Capped one hop
// past MAX_DOC_DEPTH — callers only ever need to know "is this <= the max".
async function docDepth(
  ctx: QueryCtx | MutationCtx,
  doc: Doc<"docs">,
): Promise<number> {
  let depth = 0;
  let current: Doc<"docs"> = doc;
  while (current.parentDocId && depth <= MAX_DOC_DEPTH + 1) {
    const parent = await ctx.db.get(current.parentDocId);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    try {
      await requireDocLikeParentAccess(ctx, parentType, parentId);
    } catch {
      return [];
    }
    const docs = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const get = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    try {
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    } catch {
      return null;
    }
    return doc;
  },
});

export const create = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    title: v.optional(v.string()),
    parentDocId: v.optional(v.id("docs")),
  },
  handler: async (ctx, { parentType, parentId, title, parentDocId }) => {
    const { identity } = await requireDocLikeParentAccess(
      ctx,
      parentType,
      parentId,
    );
    if (parentDocId) {
      const parentDoc = await ctx.db.get(parentDocId);
      if (!parentDoc) throw new Error("Parent doc not found");
      if (
        parentDoc.parentType !== parentType ||
        parentDoc.parentId !== parentId
      ) {
        throw new Error("Parent doc is in a different scope");
      }
      const parentDepth = await docDepth(ctx, parentDoc);
      if (parentDepth + 1 > MAX_DOC_DEPTH) {
        throw new Error("Maximum nesting depth reached");
      }
    }
    const now = Date.now();
    const docId = await ctx.db.insert("docs", {
      parentType,
      parentId,
      parentDocId,
      title: title?.trim() || "Untitled",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      createdByClerkId: identity.subject,
      updatedAt: now,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
    return docId;
  },
});

// Direct subpages of a doc, sorted by title. Access is checked once via the
// doc's own parent scope (same rule as `get`). There's no `by_parent_doc`
// index, so this filters the (already-indexed) `by_parent` result set —
// fine at the scale a single doc's scope reaches.
export const children = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const doc = await ctx.db.get(docId);
    if (!doc) return [];
    try {
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    } catch {
      return [];
    }
    const siblings = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", doc.parentType).eq("parentId", doc.parentId),
      )
      .collect();
    return siblings
      .filter((d) => d.parentDocId === docId)
      .map((d) => ({ _id: d._id, title: d.title, updatedAt: d.updatedAt }))
      .sort((a, b) => a.title.localeCompare(b.title));
  },
});

// Ancestor chain, root-first, NOT including the doc itself — callers that
// want the leaf's own title (for the trailing, non-link crumb) already have
// it from `get`. Access is checked once at the leaf; every ancestor is
// guaranteed to share its scope (create/move enforce that invariant).
export const breadcrumbs = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const leaf = await ctx.db.get(docId);
    if (!leaf) return [];
    try {
      await requireDocLikeParentAccess(ctx, leaf.parentType, leaf.parentId);
    } catch {
      return [];
    }
    const chain: { _id: Doc<"docs">["_id"]; title: string }[] = [];
    let current: Doc<"docs"> | null = leaf;
    let hops = 0;
    while (current?.parentDocId && hops <= MAX_DOC_DEPTH) {
      const parent: Doc<"docs"> | null = await ctx.db.get(current.parentDocId);
      if (!parent) break;
      chain.push({ _id: parent._id, title: parent.title });
      current = parent;
      hops++;
    }
    return chain.reverse();
  },
});

export const move = mutation({
  args: {
    docId: v.id("docs"),
    parentDocId: v.union(v.id("docs"), v.null()),
  },
  handler: async (ctx, { docId, parentDocId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) throw new Error("Doc not found");
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);

    if (parentDocId === null) {
      await ctx.db.patch(docId, { parentDocId: undefined });
      return;
    }
    if (parentDocId === docId) {
      throw new Error("A doc cannot be its own parent");
    }

    const newParent = await ctx.db.get(parentDocId);
    if (!newParent) throw new Error("Parent doc not found");
    if (
      newParent.parentType !== doc.parentType ||
      newParent.parentId !== doc.parentId
    ) {
      throw new Error("Parent doc is in a different scope");
    }

    // Cycle check: walking up from the new parent must not reach docId —
    // otherwise docId would become an ancestor of itself.
    let cursor: Doc<"docs"> | null = newParent;
    let hops = 0;
    while (cursor) {
      if (cursor._id === docId) {
        throw new Error("Cannot move a doc under one of its own descendants");
      }
      if (!cursor.parentDocId || hops >= MAX_DOC_DEPTH + 5) break;
      cursor = await ctx.db.get(cursor.parentDocId);
      hops++;
    }

    const parentDepth = await docDepth(ctx, newParent);
    if (parentDepth + 1 > MAX_DOC_DEPTH) {
      throw new Error("Maximum nesting depth reached");
    }

    // The doc's own descendants move with it — their depths shift too.
    // Height of the moved subtree (0 = leaf), bounded by the small cap.
    const subtreeHeight = async (id: typeof docId, depth: number): Promise<number> => {
      if (depth > MAX_DOC_DEPTH) return depth;
      const kids = await ctx.db
        .query("docs")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", doc.parentType).eq("parentId", doc.parentId),
        )
        .collect();
      const direct = kids.filter((k) => k.parentDocId === id);
      if (direct.length === 0) return 0;
      let deepest = 0;
      for (const k of direct) {
        deepest = Math.max(deepest, 1 + (await subtreeHeight(k._id, depth + 1)));
      }
      return deepest;
    };
    const height = await subtreeHeight(docId, 0);
    if (parentDepth + 1 + height > MAX_DOC_DEPTH) {
      throw new Error(
        "Moving this doc here would push its subpages past the nesting limit",
      );
    }

    await ctx.db.patch(docId, { parentDocId });
  },
});

export const rename = mutation({
  args: { docId: v.id("docs"), title: v.string() },
  handler: async (ctx, { docId, title }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) throw new Error("Doc not found");
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { title: title.trim() || "Untitled" });
  },
});

export const updateContent = mutation({
  args: { docId: v.id("docs"), content: v.any() },
  handler: async (ctx, { docId, content }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) throw new Error("Doc not found");
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    await ctx.db.patch(docId, { content, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
  },
});

export const remove = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);

    // Re-parent any subpages up to the deleted doc's own parent (or to
    // top-level, if it had none) so deleting a doc never orphans a branch
    // of the wiki tree.
    const siblings = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", doc.parentType).eq("parentId", doc.parentId),
      )
      .collect();
    for (const child of siblings.filter((d) => d.parentDocId === docId)) {
      await ctx.db.patch(child._id, { parentDocId: doc.parentDocId });
    }

    await ctx.db.delete(docId);
    await ctx.scheduler.runAfter(0, internal.ai.dropEmbeddings, {
      parentType: "doc",
      parentId: docId,
    });
  },
});
