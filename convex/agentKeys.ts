"use node";

import { randomBytes, createHash } from "crypto";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// API-key minting. Lives in the Node runtime for a real CSPRNG; the
// plaintext key is returned exactly once and only its SHA-256 lands in
// the database. Verification happens in the default runtime with the
// pure-JS SHA-256 in _agentAuth.ts — same algorithm, same hex output.

export const createKey = action({
  args: { agentId: v.id("agents") },
  handler: async (
    ctx,
    { agentId },
  ): Promise<{ key: string; keyPrefix: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    // Throws if the caller can't manage this agent.
    await ctx.runQuery(internal.agents._assertManageAccess, { agentId });

    const key = `cua_${randomBytes(24).toString("hex")}`;
    const keyPrefix = key.slice(0, 12);
    const keyHash = createHash("sha256").update(key).digest("hex");
    await ctx.runMutation(internal.agents._storeKey, {
      agentId,
      keyHash,
      keyPrefix,
    });
    return { key, keyPrefix };
  },
});
