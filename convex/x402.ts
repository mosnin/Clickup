import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { requireAgentByKey } from "./_agentAuth";
import { requirePlatformAdmin, logAdminAction } from "./_adminAuth";
import {
  buildPaymentRequired,
  creditsToAtomic,
  creditsToDisplayAmount,
  facilitatorConfigured,
  x402Config,
} from "./_x402";

// x402 agent-payment surface. Agents top up a prepaid credit wallet by
// paying via the x402 protocol; metered actions consume credits (enforced
// in _agentAuth.requireAgentByKey). This module owns wallet reads, the 402
// challenge builder, and the settlement writes. Facilitator verify/settle
// (external HTTP) lives in x402Actions.ts (Node runtime) and calls the
// internal applySettlement mutation here after a payment clears.

const SCOPE = v.union(v.literal("user"), v.literal("workspace"));

// A resource identifier for a scope's top-up endpoint (goes in the 402
// challenge's `resource` field).
function topupResource(scopeType: string, scopeId: string): string {
  return `x402://credits/${scopeType}/${scopeId}`;
}

// ── Metering config (admin-tunable, default OFF so existing agents keep
// working until an operator turns metering on) ─────────────────────────────
export async function readMetering(
  ctx: QueryCtx | MutationCtx,
): Promise<{ enabled: boolean; actionCredits: number }> {
  const cfg = x402Config();
  const row = await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "x402.metering"))
    .unique();
  const priceRow = await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "x402.actionCredits"))
    .unique();
  const enabled = row?.value === "on" || row?.value === true;
  const actionCredits =
    typeof priceRow?.value === "number" && priceRow.value >= 0
      ? priceRow.value
      : cfg.actionCredits;
  return { enabled, actionCredits };
}

// ── Wallet helpers ─────────────────────────────────────────────────────────
async function getWallet(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<Doc<"agentWallets"> | null> {
  return await ctx.db
    .query("agentWallets")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", scopeType).eq("scopeId", scopeId),
    )
    .unique();
}

async function ensureWallet(
  ctx: MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<Doc<"agentWallets">> {
  const existing = await getWallet(ctx, scopeType, scopeId);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("agentWallets", {
    scopeType,
    scopeId,
    balance: 0,
    lifetimeCredits: 0,
    lifetimeSpent: 0,
    createdAt: now,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

async function canAccessScope(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  subject: string,
): Promise<boolean> {
  if (scopeType === "user") return scopeId === subject;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", subject)
        .eq("workspaceId", scopeId as Id<"workspaces">),
    )
    .unique();
  return membership !== null;
}

function pricingSummary() {
  const cfg = x402Config();
  return {
    network: cfg.network,
    asset: cfg.asset,
    assetSymbol: cfg.assetSymbol,
    assetDecimals: cfg.assetDecimals,
    creditPriceAtomic: cfg.creditPriceAtomic,
    payTo: cfg.payTo,
    facilitator: cfg.facilitatorUrl ?? "mock",
    // What 1000 credits costs, for display.
    exampleBundle: {
      credits: 1000,
      atomic: creditsToAtomic(1000, cfg),
      display: creditsToDisplayAmount(1000, cfg),
    },
  };
}

// ── Agent-facing (API key) ──────────────────────────────────────────────────

// The agent's own wallet: balance, pricing, metering status, recent ledger.
export const walletByKey = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "read");
    const wallet = await getWallet(ctx, agent.parentType, agent.parentId);
    const metering = await readMetering(ctx);
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .order("desc")
      .take(10);
    return {
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      balance: wallet?.balance ?? 0,
      lifetimeCredits: wallet?.lifetimeCredits ?? 0,
      lifetimeSpent: wallet?.lifetimeSpent ?? 0,
      metering,
      pricing: pricingSummary(),
      recentPayments: payments.map((p) => ({
        amountAtomic: p.amountAtomic,
        creditsGranted: p.creditsGranted,
        asset: p.asset,
        network: p.network,
        status: p.status,
        txReference: p.txReference,
        createdAt: p.createdAt,
      })),
    };
  },
});

// The x402 402 challenge for buying `credits` credits — what an agent gets
// when it needs to pay. The agent constructs an X-PAYMENT from `accepts` and
// submits it to the settle endpoint / MCP tool.
export const topupRequirements = query({
  args: { apiKey: v.string(), credits: v.number() },
  handler: async (ctx, { apiKey, credits }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "read");
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error("credits must be a positive integer");
    }
    const cfg = x402Config();
    const resource = topupResource(agent.parentType, agent.parentId);
    const challenge = buildPaymentRequired(credits, resource, cfg);
    const wallet = await getWallet(ctx, agent.parentType, agent.parentId);
    return {
      ...challenge,
      currentBalance: wallet?.balance ?? 0,
      creditsRequested: credits,
      displayAmount: creditsToDisplayAmount(credits, cfg),
    };
  },
});

// Internal: resolve the paying scope + config from an API key (used by the
// settlement action, which runs in Node and can't touch the db directly).
export const resolveScopeByKey = internalQuery({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "read");
    return {
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      agentId: agent._id,
    };
  },
});

// Internal: apply a *verified* settlement. Called only from the settlement
// action after the facilitator confirms payment. The nonce is enforced
// unique here (by_nonce) so a payment can never be replayed to double-credit.
export const applySettlement = internalMutation({
  args: {
    scopeType: SCOPE,
    scopeId: v.string(),
    agentId: v.optional(v.id("agents")),
    asset: v.string(),
    network: v.string(),
    amountAtomic: v.string(),
    creditsGranted: v.number(),
    payer: v.optional(v.string()),
    nonce: v.string(),
    txReference: v.optional(v.string()),
    facilitator: v.string(),
  },
  handler: async (ctx, args) => {
    // Replay protection: a nonce that has already SETTLED can never be
    // credited twice. We match only settled rows (not failed observability
    // rows) so a transient failure that recorded the nonce doesn't
    // permanently block a legitimate retry of the same authorization.
    const sameNonce = await ctx.db
      .query("payments")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .collect();
    if (sameNonce.some((p) => p.status === "settled")) {
      throw new Error("This payment has already been settled");
    }
    if (!Number.isInteger(args.creditsGranted) || args.creditsGranted <= 0) {
      throw new Error("creditsGranted must be a positive integer");
    }

    await ctx.db.insert("payments", {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      agentId: args.agentId,
      asset: args.asset,
      network: args.network,
      amountAtomic: args.amountAtomic,
      creditsGranted: args.creditsGranted,
      payer: args.payer,
      nonce: args.nonce,
      txReference: args.txReference,
      facilitator: args.facilitator,
      status: "settled",
      createdAt: Date.now(),
    });

    const wallet = await ensureWallet(ctx, args.scopeType, args.scopeId);
    const balance = wallet.balance + args.creditsGranted;
    await ctx.db.patch(wallet._id, {
      balance,
      lifetimeCredits: wallet.lifetimeCredits + args.creditsGranted,
      updatedAt: Date.now(),
    });
    return { balance, creditsGranted: args.creditsGranted };
  },
});

// Internal: record a failed settlement attempt for observability (no credit).
export const recordFailedPayment = internalMutation({
  args: {
    scopeType: SCOPE,
    scopeId: v.string(),
    agentId: v.optional(v.id("agents")),
    nonce: v.string(),
    reason: v.string(),
    facilitator: v.string(),
  },
  handler: async (ctx, args) => {
    const cfg = x402Config();
    await ctx.db.insert("payments", {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      agentId: args.agentId,
      asset: cfg.asset,
      network: cfg.network,
      amountAtomic: "0",
      creditsGranted: 0,
      nonce: args.nonce,
      facilitator: args.facilitator,
      status: "failed",
      reason: args.reason,
      createdAt: Date.now(),
    });
  },
});

// ── Human-facing (Clerk) ────────────────────────────────────────────────────

// Wallet view for the UI. Access-checked against the caller's scope.
export const walletForScope = query({
  args: { scopeType: SCOPE, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    const { subject } = await requireIdentity(ctx);
    if (!(await canAccessScope(ctx, scopeType, scopeId, subject))) {
      throw new Error("Forbidden");
    }
    const wallet = await getWallet(ctx, scopeType, scopeId);
    const metering = await readMetering(ctx);
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .order("desc")
      .take(25);
    return {
      balance: wallet?.balance ?? 0,
      lifetimeCredits: wallet?.lifetimeCredits ?? 0,
      lifetimeSpent: wallet?.lifetimeSpent ?? 0,
      metering,
      pricing: pricingSummary(),
      payments: payments.map((p) => ({
        _id: p._id,
        amountAtomic: p.amountAtomic,
        creditsGranted: p.creditsGranted,
        asset: p.asset,
        network: p.network,
        status: p.status,
        reason: p.reason,
        txReference: p.txReference,
        payer: p.payer,
        createdAt: p.createdAt,
      })),
    };
  },
});

// ── Admin (platform revenue) ────────────────────────────────────────────────
export const platformRevenue = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    // Settled payments across the platform (bounded scan; payments are
    // low-volume relative to events/tasks).
    const settled = await ctx.db
      .query("payments")
      .order("desc")
      .take(500);
    let totalCredits = 0;
    let settledCount = 0;
    const walletCount = (await ctx.db.query("agentWallets").take(1000)).length;
    for (const p of settled) {
      if (p.status === "settled") {
        totalCredits += p.creditsGranted;
        settledCount += 1;
      }
    }
    return {
      totalCreditsSold: totalCredits,
      settledCount,
      walletCount,
      metering: await readMetering(ctx),
      pricing: pricingSummary(),
      recent: settled.slice(0, 25).map((p) => ({
        scopeType: p.scopeType,
        scopeId: p.scopeId,
        creditsGranted: p.creditsGranted,
        amountAtomic: p.amountAtomic,
        asset: p.asset,
        status: p.status,
        createdAt: p.createdAt,
      })),
    };
  },
});

// Admin: turn metering on/off and set the per-action price. Superadmin only
// (same tier as security settings); writes an adminAuditLog row so every
// admin mutation stays auditable.
export const setMeteringConfig = mutation({
  args: {
    enabled: v.optional(v.boolean()),
    actionCredits: v.optional(v.number()),
  },
  handler: async (ctx, { enabled, actionCredits }) => {
    const admin = await requirePlatformAdmin(ctx, { minRole: "superadmin" });
    // Fail closed: refuse to enable metering unless a payment facilitator is
    // configured (or the mock is explicitly opted into). Otherwise metering
    // would be enforced while agents could self-mint credits through the mock.
    if (enabled === true && !facilitatorConfigured(x402Config())) {
      throw new Error(
        "Refusing to enable metering: no payment facilitator is configured. Set X402_FACILITATOR_URL first (or X402_ALLOW_MOCK=1 for development only).",
      );
    }
    async function put(key: string, value: unknown) {
      const row = await ctx.db
        .query("platformSettings")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (row) {
        await ctx.db.patch(row._id, {
          value,
          updatedByClerkId: admin.clerkId,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("platformSettings", {
          key,
          value,
          updatedByClerkId: admin.clerkId,
          updatedAt: Date.now(),
        });
      }
    }
    if (enabled !== undefined) await put("x402.metering", enabled ? "on" : "off");
    if (actionCredits !== undefined) {
      if (!Number.isInteger(actionCredits) || actionCredits < 0) {
        throw new Error("actionCredits must be a non-negative integer");
      }
      await put("x402.actionCredits", actionCredits);
    }
    const result = await readMetering(ctx);
    await logAdminAction(ctx, admin, "x402.metering_updated", {
      targetType: "setting",
      targetId: "x402.metering",
      summary: `enabled=${result.enabled} actionCredits=${result.actionCredits}`,
    });
    return result;
  },
});
