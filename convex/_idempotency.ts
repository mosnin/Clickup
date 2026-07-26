import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Idempotent agent writes.
//
// Wrap a mutation body in `once()` and pass the caller's key. The first call
// runs the body and stores its return value; every later call with the same key
// replays that value without touching anything. A retry after a lost response
// therefore returns the ids the first attempt created, instead of creating a
// second copy of the work.
//
// Deliberately opt-in per call rather than automatic: a key the caller does not
// supply cannot be invented server-side, and forcing one on every mutation
// would break callers that legitimately repeat an action (adding two identical
// comments, ticking the same checklist twice).
//
// Note on transactionality: Convex mutations are single transactions, so the
// receipt insert and the work it describes commit together. There is no window
// where the work exists without its receipt, which is what makes the replay
// trustworthy.

export type OperationReceipt<T> = T & {
  /** True when this response is a replay of an earlier identical call. */
  replayed?: boolean;
};

export async function once<T>(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  args: { idempotencyKey?: string; tool: string },
  body: () => Promise<T>,
): Promise<OperationReceipt<T>> {
  const key = args.idempotencyKey?.trim();
  if (!key) return (await body()) as OperationReceipt<T>;

  const existing = await ctx.db
    .query("agentOperations")
    .withIndex("by_agent_and_key", (q) =>
      q.eq("agentId", agent._id).eq("idempotencyKey", key),
    )
    .unique();
  if (existing) {
    // Same key, different tool means the caller reused a key by mistake.
    // Replaying a create_list receipt for a create_task call would be worse
    // than an error, so this is surfaced rather than papered over.
    if (existing.tool !== args.tool) {
      throw new Error(
        `Idempotency key already used by ${existing.tool}. Use a fresh key per operation.`,
      );
    }
    return { ...(existing.result as T), replayed: true };
  }

  const result = await body();
  await ctx.db.insert("agentOperations", {
    agentId: agent._id,
    idempotencyKey: key,
    tool: args.tool,
    result,
    createdAt: Date.now(),
  });
  return result as OperationReceipt<T>;
}

/**
 * A create receipt worth returning. The audit note this answers: several
 * mutations returned nothing but a quoted id, so a caller had to make another
 * (possibly failing) request just to learn what it had made.
 */
export function receipt(args: {
  id: string;
  type: string;
  name: string;
  parentId?: string;
  url?: string;
}): {
  id: string;
  type: string;
  name: string;
  parentId?: string;
  url?: string;
  createdAt: number;
} {
  return { ...args, createdAt: Date.now() };
}

/** Deep-link path for the objects agents create, so receipts carry a URL. */
export function urlFor(
  type: "task" | "list" | "doc" | "folder" | "sprint",
  id: string,
  listId?: Id<"lists">,
): string | undefined {
  switch (type) {
    case "task":
      return listId ? `/dashboard/l/${listId}/t/${id}` : undefined;
    case "list":
      return `/dashboard/l/${id}`;
    case "doc":
      return `/dashboard/d/${id}`;
    default:
      return undefined;
  }
}
