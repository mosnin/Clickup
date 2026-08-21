import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isEmailRootAdmin } from "./_adminAuth";

// Complimentary entitlements for platform-admin accounts.
//
// Staff accounts are unpaid by construction: they must be able to run the
// product (unlimited agents, no credit metering) without holding a paid
// plan. That is not the same as "no limits at all" — a compromised admin
// agent still needs a circuit breaker, so complimentary scopes keep an
// extreme daily budget and a high-but-finite burst cap.
//
// Complimentary follows the *owner* of the scope, not membership. An admin
// who joins a customer's workspace does not turn that workspace free.

export const ADMIN_DAILY_ACTION_LIMIT = 100_000;
export const ADMIN_BURST_LIMIT_PER_MINUTE = 600;

// Free-tier cap used only when `max_agents_per_workspace` is a positive
// number. 0 / unset means the operator has not turned the cap on.
export async function readAgentCap(
  ctx: QueryCtx | MutationCtx,
): Promise<number | null> {
  const row = await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "max_agents_per_workspace"))
    .unique();
  const value = row?.value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
}

export async function isPlatformAdminClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
): Promise<boolean> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique();
  // A hold strips complimentary access the same way it strips admin
  // powers — otherwise a suspended staff account would keep a free
  // unlimited fleet.
  if (user?.suspendedAt) return false;
  if (isEmailRootAdmin(user?.email)) return true;
  const row = await ctx.db
    .query("platformAdmins")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique();
  return row !== null && row.revokedAt === undefined;
}

export async function isComplimentaryScope(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<boolean> {
  if (scopeType === "user") {
    return await isPlatformAdminClerkId(ctx, scopeId);
  }
  const ws = await ctx.db.get(scopeId as Id<"workspaces">);
  if (!ws) return false;
  return await isPlatformAdminClerkId(ctx, ws.ownerClerkId);
}

// A hold that only blocks Clerk writes is not a hold: the product's agents
// authenticate with API keys and never pass through requireIdentity. The
// same principal complimentary already follows (the personal user, or the
// workspace owner) must go dark, or a suspended staff account keeps an
// unpaid fleet and a suspended tenant keeps consuming the product.
export async function assertAgentScopeNotHeld(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<void> {
  if (scopeType === "user") {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", scopeId))
      .first();
    if (user?.suspendedAt) {
      throw new ConvexError("Account suspended");
    }
    return;
  }
  const ws = await ctx.db.get(scopeId as Id<"workspaces">);
  if (!ws) throw new ConvexError("Workspace not found");
  if (ws.suspendedAt) {
    throw new ConvexError("Workspace suspended");
  }
  const owner = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", ws.ownerClerkId))
    .first();
  if (owner?.suspendedAt) {
    throw new ConvexError("Account suspended");
  }
}

export async function assertCanCreateAgent(
  ctx: QueryCtx | MutationCtx,
  parentType: "user" | "workspace",
  parentId: string,
): Promise<void> {
  if (await isComplimentaryScope(ctx, parentType, parentId)) return;
  const cap = await readAgentCap(ctx);
  if (cap === null) return;
  const existing = await ctx.db
    .query("agents")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", parentType).eq("parentId", parentId),
    )
    .collect();
  if (existing.length >= cap) {
    throw new ConvexError(
      `Agent limit reached (${cap} per ${parentType === "workspace" ? "workspace" : "personal space"}). Upgrade, or ask support to raise the cap.`,
    );
  }
}
