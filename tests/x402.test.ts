import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  atomicToCredits,
  buildPaymentRequired,
  creditsToAtomic,
  creditsToDisplayAmount,
  validatePaymentShape,
  x402Config,
  type PaymentPayload,
} from "../convex/_x402";

const modules = import.meta.glob("../convex/**/*.*s");

// ── Pure protocol helpers ──────────────────────────────────────────────────
describe("x402 pricing + protocol helpers", () => {
  const cfg = x402Config();

  it("prices credits in atomic asset units and back", () => {
    // Defaults: 1000 atomic units per credit, USDC 6 decimals.
    expect(creditsToAtomic(1000, cfg)).toBe("1000000");
    expect(atomicToCredits("1000000", cfg)).toBe(1000);
    expect(atomicToCredits("1500", cfg)).toBe(1); // floors partial credits
    expect(creditsToDisplayAmount(1000, cfg)).toBe("1 USDC");
  });

  it("builds a spec-shaped 402 challenge", () => {
    const challenge = buildPaymentRequired(500, "x402://credits/user/u1", cfg);
    expect(challenge.x402Version).toBe(1);
    const req = challenge.accepts[0];
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe(cfg.network);
    expect(req.maxAmountRequired).toBe("500000");
    expect(req.payTo).toBe(cfg.payTo);
    expect(req.extra.creditsGranted).toBe(500);
    expect(challenge.error).toMatch(/X-PAYMENT/);
  });

  it("validates payment shape and rejects shortfalls / mismatches", () => {
    const req = buildPaymentRequired(1000, "x402://credits/user/u1", cfg)
      .accepts[0];
    const good: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: cfg.network,
      payload: {
        authorization: {
          from: "0xPayer",
          to: cfg.payTo,
          value: "1000000",
          nonce: "0xnonce1",
        },
      },
    };
    const ok = validatePaymentShape(good, req, cfg);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.nonce).toBe("0xnonce1");

    // Underpaid.
    const low = {
      ...good,
      payload: {
        authorization: { ...good.payload.authorization, value: "1" },
      },
    };
    expect(validatePaymentShape(low, req, cfg).ok).toBe(false);

    // Wrong network.
    const wrongNet = { ...good, network: "ethereum" };
    expect(validatePaymentShape(wrongNet, req, cfg).ok).toBe(false);

    // Missing nonce.
    const noNonce: PaymentPayload = {
      ...good,
      payload: { authorization: { value: "1000000" } },
    };
    expect(validatePaymentShape(noNonce, req, cfg).ok).toBe(false);
  });
});

// ── Settlement + replay protection ──────────────────────────────────────────
describe("x402 settlement", () => {
  it("credits a wallet once and refuses to replay the same nonce", async () => {
    const t = convexTest(schema, modules);
    const args = {
      scopeType: "user" as const,
      scopeId: "user_a",
      asset: "USDC",
      network: "base-sepolia",
      amountAtomic: "1000000",
      creditsGranted: 1000,
      nonce: "0xdeadbeef",
      facilitator: "mock",
    };
    const first = await t.mutation(internal.x402.applySettlement, args);
    expect(first.balance).toBe(1000);

    // Same nonce again → replay refused, balance unchanged.
    await expect(
      t.mutation(internal.x402.applySettlement, args),
    ).rejects.toThrow(/already been settled/i);

    const wallet = await t.run(async (ctx) =>
      ctx.db
        .query("agentWallets")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "user").eq("scopeId", "user_a"),
        )
        .unique(),
    );
    expect(wallet?.balance).toBe(1000);
    expect(wallet?.lifetimeCredits).toBe(1000);
  });
});

// ── Metering enforcement ────────────────────────────────────────────────────
async function seedMeteredAgent(
  t: ReturnType<typeof convexTest>,
  balance: number,
  actionCredits = 2,
) {
  const plainKey = "cua_test_key_123";
  await t.run(async (ctx) => {
    await ctx.db.insert("platformSettings", {
      key: "x402.metering",
      value: "on",
      updatedByClerkId: "sys",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("platformSettings", {
      key: "x402.actionCredits",
      value: actionCredits,
      updatedByClerkId: "sys",
      updatedAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Payer",
      parentType: "user",
      parentId: "user_m",
      status: "active",
      createdByClerkId: "user_m",
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(plainKey),
      keyPrefix: plainKey.slice(0, 8),
      createdAt: Date.now(),
    });
    if (balance > 0) {
      await ctx.db.insert("agentWallets", {
        scopeType: "user",
        scopeId: "user_m",
        balance,
        lifetimeCredits: balance,
        lifetimeSpent: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  return plainKey;
}

describe("x402 metering", () => {
  it("charges credits per metered write action", async () => {
    const t = convexTest(schema, modules);
    const apiKey = await seedMeteredAgent(t, 5, 2);

    await t.mutation(api.agentApi.createSpace, { apiKey, name: "Alpha" });

    const wallet = await t.run(async (ctx) =>
      ctx.db
        .query("agentWallets")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "user").eq("scopeId", "user_m"),
        )
        .unique(),
    );
    expect(wallet?.balance).toBe(3); // 5 - 2
    expect(wallet?.lifetimeSpent).toBe(2);
  });

  it("refuses a metered action when credits can't cover it", async () => {
    const t = convexTest(schema, modules);
    const apiKey = await seedMeteredAgent(t, 0, 2);

    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "Beta" }),
    ).rejects.toThrow(/X402_PAYMENT_REQUIRED|insufficient credits/i);
  });
});
