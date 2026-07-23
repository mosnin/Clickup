// Precomputed per-list task rollups maintained by the task write cores
// (convex/tasks.ts). Home's overview and the Space overview used to scan
// every task in scope on each reactive tick; these helpers let them read
// one small row per list instead.
//
// `adjustRollup`/`computeRollup` are plain async helpers — NOT mutations —
// so the *Core write paths in tasks.ts can call them inline inside the
// same transaction as the task write they're accounting for. `getRollup`
// is the read-side counterpart for queries, which can't write: a missing
// row means the caller should fall back to scanning that one list itself.
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type RollupDelta = {
  total?: number;
  done?: number;
  inProgress?: number;
};

export type RollupSnapshot = {
  total: number;
  done: number;
  inProgress: number;
  updatedAt: number;
};

function clamp(n: number): number {
  return n < 0 ? 0 : n;
}

async function findRow(ctx: MutationCtx | QueryCtx, listId: Id<"lists">) {
  return await ctx.db
    .query("listRollups")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .unique();
}

// Apply an incremental delta to a list's rollup row, creating it on first
// use. Buckets are clamped at 0 so a stray double-decrement (which
// shouldn't happen, but drift is possible via paths outside the *Core
// write functions — see tasks.ts) can never go negative and poison every
// later read. Call this from inside a mutation, right alongside the task
// write it's accounting for.
export async function adjustRollup(
  ctx: MutationCtx,
  listId: Id<"lists">,
  delta: RollupDelta,
): Promise<void> {
  const row = await findRow(ctx, listId);
  const now = Date.now();
  if (!row) {
    await ctx.db.insert("listRollups", {
      listId,
      total: clamp(delta.total ?? 0),
      done: clamp(delta.done ?? 0),
      inProgress: clamp(delta.inProgress ?? 0),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(row._id, {
    total: clamp(row.total + (delta.total ?? 0)),
    done: clamp(row.done + (delta.done ?? 0)),
    inProgress: clamp(row.inProgress + (delta.inProgress ?? 0)),
    updatedAt: now,
  });
}

// Full recount from tasks + statuses. This is the lazy backfill / repair
// path: anything that drifts a rollup out of sync with reality (a direct
// db.patch on statusId outside the *Core functions, a bulk cascade
// reassignment, a pre-rollup list with no row yet) is corrected the next
// time this runs. Safe to call repeatedly; it's idempotent.
export async function computeRollup(
  ctx: MutationCtx,
  listId: Id<"lists">,
): Promise<{ total: number; done: number; inProgress: number }> {
  const statuses = await ctx.db
    .query("listStatuses")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  const categoryByStatus = new Map(statuses.map((s) => [s._id, s.category]));

  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();

  let done = 0;
  let inProgress = 0;
  for (const t of tasks) {
    const category = categoryByStatus.get(t.statusId);
    if (category === "complete" || category === "closed") done += 1;
    else if (category === "in_progress") inProgress += 1;
  }
  const total = tasks.length;

  const row = await findRow(ctx, listId);
  const now = Date.now();
  if (row) {
    await ctx.db.patch(row._id, { total, done, inProgress, updatedAt: now });
  } else {
    await ctx.db.insert("listRollups", {
      listId,
      total,
      done,
      inProgress,
      updatedAt: now,
    });
  }
  return { total, done, inProgress };
}

// Read-side counterpart for queries (which can't write). Returns null when
// no row exists yet for this list — callers should fall back to scanning
// that single list themselves rather than trying to backfill inline.
export async function getRollup(
  ctx: QueryCtx,
  listId: Id<"lists">,
): Promise<RollupSnapshot | null> {
  const row = await findRow(ctx, listId);
  if (!row) return null;
  return {
    total: row.total,
    done: row.done,
    inProgress: row.inProgress,
    updatedAt: row.updatedAt,
  };
}

// One-time (or repair-on-demand) recompute of every list's rollup. Queries
// can't write, so this is the only way to backfill rows for lists that
// existed before this table did, or to repair any drift accumulated from
// write paths outside tasks.ts's *Core functions (see tasks.ts for the
// documented ones). Batches through the `lists` table; fine as a one-shot
// post-deploy invocation, not scheduled.
export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const lists = await ctx.db.query("lists").collect();
    for (const list of lists) {
      await computeRollup(ctx, list._id);
    }
    return { listsRecomputed: lists.length };
  },
});
