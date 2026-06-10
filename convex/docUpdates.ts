import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireDocLikeParentAccess, requireIdentity } from "./_authz";

// Compaction trigger: once a doc has more than COMPACT_THRESHOLD
// pending updates, append() schedules an internal action to merge
// them into a single snapshot. Picked low so a busy doc doesn't
// accumulate a long tail; picked high enough that idle docs don't
// thrash compaction.
const COMPACT_THRESHOLD = 60;

async function ensureDocAccess(
  ctx: Parameters<typeof requireIdentity>[0],
  docId: import("./_generated/dataModel").Id<"docs">,
) {
  await requireIdentity(ctx);
  const doc = await ctx.db.get(docId);
  if (!doc || doc.deletedAt) throw new Error("Doc not found");
  await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
  return doc;
}

// Append a single Yjs update to the log. Sequence is max+1 within a
// doc; OCC handles concurrent appends. After insert, if we're past
// COMPACT_THRESHOLD pending updates, schedule a background compaction.
export const append = mutation({
  args: {
    docId: v.id("docs"),
    update: v.bytes(),
  },
  handler: async (ctx, { docId, update }) => {
    const identity = await requireIdentity(ctx);
    const doc = await ensureDocAccess(ctx, docId);

    const last = await ctx.db
      .query("docUpdates")
      .withIndex("by_doc_seq", (q) => q.eq("docId", docId))
      .order("desc")
      .take(1);
    const nextSeq = (last[0]?.sequence ?? doc.snapshotSequence ?? 0) + 1;

    await ctx.db.insert("docUpdates", {
      docId,
      sequence: nextSeq,
      update,
      authorClerkId: identity.subject,
      createdAt: Date.now(),
    });

    // Touch updatedAt so the doc list re-sorts.
    await ctx.db.patch(docId, { updatedAt: Date.now() });

    // Pending updates = total - snapshotSequence. Snapshot covers
    // everything up to its sequence, so we only count after that.
    const since = doc.snapshotSequence ?? 0;
    const pending = nextSeq - since;
    if (pending >= COMPACT_THRESHOLD) {
      await ctx.scheduler.runAfter(0, internal.yjs.compactDoc, { docId });
    }
  },
});

// Returns updates with sequence > since. Client passes the sequence
// it last applied; we hand back everything new in order.
export const listSinceSequence = query({
  args: { docId: v.id("docs"), since: v.number() },
  handler: async (ctx, { docId, since }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const doc = await ctx.db.get(docId);
    if (!doc || doc.deletedAt) return [];
    try {
      await requireDocLikeParentAccess(ctx, doc.parentType, doc.parentId);
    } catch {
      return [];
    }
    const updates = await ctx.db
      .query("docUpdates")
      .withIndex("by_doc_seq", (q) =>
        q.eq("docId", docId).gt("sequence", since),
      )
      .collect();
    return updates.sort((a, b) => a.sequence - b.sequence);
  },
});
