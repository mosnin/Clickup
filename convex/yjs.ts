"use node";

import { v } from "convex/values";
import * as Y from "yjs";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Compaction: load the doc's existing snapshot + every pending update,
// merge them into a single Yjs state (encodeStateAsUpdate), write that
// back as the new snapshot, and prune the old update rows. The whole
// finalize step runs in one mutation so the snapshot+prune is atomic.
//
// Lives in convex/yjs.ts under the Node runtime because Yjs touches
// browser-y APIs at the edges; running in V8 has occasionally surfaced
// minor incompatibilities. Node runtime is a safe default and the
// throughput here is "background, occasional".
export const compactDoc = internalAction({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const data = await ctx.runQuery(internal.yjs._loadForCompaction, {
      docId,
    });
    if (!data) return;

    const ydoc = new Y.Doc();
    if (data.snapshot) {
      Y.applyUpdate(ydoc, new Uint8Array(data.snapshot));
    }
    for (const u of data.updates) {
      Y.applyUpdate(ydoc, new Uint8Array(u.update));
    }
    const newSnapshot = Y.encodeStateAsUpdate(ydoc);

    await ctx.runMutation(internal.yjs._writeSnapshot, {
      docId,
      snapshot: newSnapshot.buffer.slice(
        newSnapshot.byteOffset,
        newSnapshot.byteOffset + newSnapshot.byteLength,
      ) as ArrayBuffer,
      throughSequence: data.maxSequence,
    });
  },
});

// Helper query consumed by compactDoc — collects everything we need
// in a single round-trip.
import { internalQuery } from "./_generated/server";

export const _loadForCompaction = internalQuery({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    const updates = await ctx.db
      .query("docUpdates")
      .withIndex("by_doc_seq", (q) =>
        q.eq("docId", docId).gt("sequence", doc.snapshotSequence ?? 0),
      )
      .collect();
    if (updates.length === 0) return null;
    const sorted = updates.sort((a, b) => a.sequence - b.sequence);
    return {
      snapshot: doc.snapshot ?? null,
      snapshotSequence: doc.snapshotSequence ?? 0,
      maxSequence: sorted[sorted.length - 1].sequence,
      updates: sorted.map((u) => ({
        sequence: u.sequence,
        update: u.update,
      })),
    };
  },
});

export const _writeSnapshot = internalMutation({
  args: {
    docId: v.id("docs"),
    snapshot: v.bytes(),
    throughSequence: v.number(),
  },
  handler: async (ctx, { docId, snapshot, throughSequence }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    // Race guard: another writer may have advanced the snapshot
    // already. Don't go backwards.
    if ((doc.snapshotSequence ?? 0) >= throughSequence) return;

    await ctx.db.patch(docId, {
      snapshot,
      snapshotSequence: throughSequence,
    });

    // Prune updates we just folded in.
    const stale = await ctx.db
      .query("docUpdates")
      .withIndex("by_doc_seq", (q) =>
        q.eq("docId", docId).lte("sequence", throughSequence),
      )
      .collect();
    for (const row of stale) await ctx.db.delete(row._id);
  },
});
