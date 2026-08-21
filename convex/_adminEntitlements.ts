import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isEmailRootAdmin } from "./_adminAuth";

// Owner-admin entitlements. The application owner (env-allowlisted via
// PLATFORM_ADMIN_EMAILS) and any account granted a live platformAdmins row
// are unpaid and uncapped: no Starter agent cap, no workspace cap, no
// action-budget cap, no credit metering.
//
// Complimentary follows the *owner* of the scope, not membership. An admin
// who joins a customer's workspace does not turn that workspace free, and
// cannot raise that tenant's caps. Tenant isolation is unchanged.

/** Starter marketing cap: 3 agents per personal space or workspace. */
export const STARTER_MAX_AGENTS = 3;
/** Starter marketing cap: 1 team workspace (personal space is separate). */
export const STARTER_MAX_WORKSPACES = 1;

function positiveCap(value: unknown): number | null | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > 0) return Math.floor(value);
  // Explicit 0 is the operator override: unlimited for ordinary accounts.
  return null;
}

// Starter default of 3 when the setting is unset. A positive
// `max_agents_per_workspace` raises or lowers that number. 0 means the
// operator turned the cap off. Complimentary scopes never consult this.
export async function readAgentCap(
  ctx: QueryCtx | MutationCtx,
): Promise<number | null> {
  const row = await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "max_agents_per_workspace"))
    .unique();
  const override = positiveCap(row?.value);
  if (override !== undefined) return override;
  return STARTER_MAX_AGENTS;
}

// Same shape as the agent cap: unset → Starter's one workspace; explicit 0
// → unlimited; a positive number is the tenant ceiling.
export async function readWorkspaceCap(
  ctx: QueryCtx | MutationCtx,
): Promise<number | null> {
  const row = await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "max_workspaces_per_user"))
    .unique();
  const override = positiveCap(row?.value);
  if (override !== undefined) return override;
  return STARTER_MAX_WORKSPACES;
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

export async function assertCanCreateWorkspace(
  ctx: QueryCtx | MutationCtx,
  ownerClerkId: string,
): Promise<void> {
  if (await isPlatformAdminClerkId(ctx, ownerClerkId)) return;
  const cap = await readWorkspaceCap(ctx);
  if (cap === null) return;
  const existing = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerClerkId", ownerClerkId))
    .collect();
  if (existing.length >= cap) {
    throw new ConvexError(
      `Workspace limit reached (${cap} on the Starter plan). Upgrade, or ask support to raise the cap.`,
    );
  }
}
