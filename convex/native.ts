import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Admetos Native Provisioning Protocol (v1) — operate.to internals.
 *
 * When a user creates an Admetos-owned account, Admetos POSTs a signed request
 * to `/native/provision` (see convex/http.ts). That HTTP action authenticates
 * the request by HMAC — there is no Clerk user behind it — and then calls
 * these internal mutations to mint the native identity: an agent in a
 * designated host workspace plus its API key.
 *
 * Idempotency is keyed on the Admetos account id, stamped into the agent's
 * `createdByClerkId` as `admetos:<accountId>`. Re-provisioning the same
 * account returns the existing agent instead of creating a duplicate — the
 * same contract every other end of the protocol keeps.
 */

const ADMETOS_MARKER = "admetos:";

/** The stamped owner marker for an Admetos-provisioned agent. */
export function admetosOwner(accountId: string): string {
  return `${ADMETOS_MARKER}${accountId}`;
}

export const provisionAgent = internalMutation({
  args: {
    accountId: v.string(),
    displayName: v.string(),
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ agentId: Id<"agents">; created: boolean }> => {
    const owner = admetosOwner(args.accountId);

    // Idempotent: an agent for this account in this workspace already exists?
    const existing = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", args.workspaceId),
      )
      .collect();
    const found = existing.find((a) => a.createdByClerkId === owner);
    if (found) return { agentId: found._id, created: false };

    const agentId = await ctx.db.insert("agents", {
      name: `Admetos · ${args.displayName}`.slice(0, 120),
      description: "Native identity owned by Admetos Cloud.",
      parentType: "workspace",
      parentId: args.workspaceId,
      status: "active",
      createdByClerkId: owner,
      createdAt: Date.now(),
    });
    return { agentId, created: true };
  },
});

export const storeKey = internalMutation({
  args: {
    agentId: v.id("agents"),
    keyHash: v.string(),
    keyPrefix: v.string(),
  },
  handler: async (ctx, args) => {
    // One live key per Admetos-owned agent: drop any prior keys so
    // re-provisioning rotates rather than accumulating.
    const prior = await ctx.db
      .query("agentKeys")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();
    for (const key of prior) {
      if (!key.revokedAt) await ctx.db.patch(key._id, { revokedAt: Date.now() });
    }
    await ctx.db.insert("agentKeys", {
      agentId: args.agentId,
      keyHash: args.keyHash,
      keyPrefix: args.keyPrefix,
      createdAt: Date.now(),
    });
  },
});

/** Guard used by the HTTP action; keeps the ConvexError text in one place. */
export function requireWorkspaceConfigured(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new ConvexError(
      "ADMETOS_PROVISION_WORKSPACE_ID is not configured on this deployment.",
    );
  }
  return workspaceId;
}
