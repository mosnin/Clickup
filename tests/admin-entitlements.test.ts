import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  ADMIN_BURST_LIMIT_PER_MINUTE,
  ADMIN_DAILY_ACTION_LIMIT,
} from "../convex/_adminEntitlements";

const modules = import.meta.glob("../convex/**/*.*s");

const ROOT = { subject: "user_root", email: "root@company.com" };
const NORMAL = { subject: "user_normal", email: "normal@company.com" };
const SUPPORT = { subject: "user_support", email: "support@company.com" };

async function seedUsers(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const u of [ROOT, NORMAL, SUPPORT]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
}

async function seedAgent(
  t: ReturnType<typeof convexTest>,
  parentId: string,
  key = "cua_admin_test_key",
) {
  await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", {
      name: "Staff bot",
      parentType: "user",
      parentId,
      status: "active",
      createdByClerkId: parentId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(key),
      keyPrefix: key.slice(0, 8),
      createdAt: Date.now(),
    });
  });
  return key;
}

async function enableMetering(t: ReturnType<typeof convexTest>, price = 2) {
  await t.run(async (ctx) => {
    await ctx.db.insert("platformSettings", {
      key: "x402.metering",
      value: "on",
      updatedByClerkId: "sys",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("platformSettings", {
      key: "x402.actionCredits",
      value: price,
      updatedByClerkId: "sys",
      updatedAt: Date.now(),
    });
  });
}

describe("admin complimentary entitlements", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = "root@company.com";
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("exposes the extreme safety ceilings", () => {
    expect(ADMIN_DAILY_ACTION_LIMIT).toBe(100_000);
    expect(ADMIN_BURST_LIMIT_PER_MINUTE).toBe(600);
  });

  it("does not meter writes on a staff-owned scope, even with a zero wallet", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await enableMetering(t, 2);
    const apiKey = await seedAgent(t, ROOT.subject);

    await t.mutation(api.agentApi.createSpace, { apiKey, name: "Staff HQ" });

    const wallet = await t.run(async (ctx) =>
      ctx.db
        .query("agentWallets")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "user").eq("scopeId", ROOT.subject),
        )
        .unique(),
    );
    expect(wallet).toBeNull();

    const who = await t.query(api.agentApi.whoami, { apiKey });
    expect(who.billing.complimentary).toBe(true);
    expect(who.billing.meteringEnabled).toBe(false);
    expect(who.dailyActionLimit).toBe(ADMIN_DAILY_ACTION_LIMIT);
    expect(who.burstLimitPerMinute).toBe(ADMIN_BURST_LIMIT_PER_MINUTE);
  });

  it("still meters an ordinary user when metering is on", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await enableMetering(t, 2);
    const apiKey = await seedAgent(t, NORMAL.subject, "cua_normal_key");

    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "Paid HQ" }),
    ).rejects.toThrow(/X402_PAYMENT_REQUIRED|insufficient credits/i);

    const who = await t.query(api.agentApi.whoami, { apiKey });
    expect(who.billing.complimentary).toBe(false);
    expect(who.billing.meteringEnabled).toBe(true);
  });

  it("refuses a complimentary agent that has already hit the safety daily ceiling", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const apiKey = await seedAgent(t, ROOT.subject);
    await t.run(async (ctx) => {
      const agent = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "user").eq("parentId", ROOT.subject),
        )
        .unique();
      await ctx.db.insert("agentUsage", {
        agentId: agent!._id,
        day: new Date().toISOString().slice(0, 10),
        count: ADMIN_DAILY_ACTION_LIMIT,
      });
    });
    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "Over" }),
    ).rejects.toThrow(/daily action budget/i);
  });

  it("lets a staff account create past the free-tier agent cap", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("platformSettings", {
        key: "max_agents_per_workspace",
        value: 1,
        updatedByClerkId: ROOT.subject,
        updatedAt: Date.now(),
      });
    });

    await t
      .withIdentity(NORMAL)
      .mutation(api.agents.create, {
        name: "First",
        parentType: "user",
        parentId: NORMAL.subject,
      });
    await expect(
      t.withIdentity(NORMAL).mutation(api.agents.create, {
        name: "Second",
        parentType: "user",
        parentId: NORMAL.subject,
      }),
    ).rejects.toThrow(/agent limit/i);

    await t
      .withIdentity(ROOT)
      .mutation(api.agents.create, {
        name: "Staff 1",
        parentType: "user",
        parentId: ROOT.subject,
      });
    const second = await t
      .withIdentity(ROOT)
      .mutation(api.agents.create, {
        name: "Staff 2",
        parentType: "user",
        parentId: ROOT.subject,
      });
    expect(second).toBeTruthy();
  });

  it("strips complimentary access from a suspended staff account", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.grantAdmin, {
        email: SUPPORT.email,
        role: "support",
      });
    await enableMetering(t, 2);
    const apiKey = await seedAgent(t, SUPPORT.subject, "cua_support_key");

    await t.mutation(api.agentApi.createSpace, {
      apiKey,
      name: "Before hold",
    });

    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendUser, {
        clerkId: SUPPORT.subject,
        reason: "compromised",
      });

    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "After hold" }),
    ).rejects.toThrow(/X402_PAYMENT_REQUIRED|insufficient credits/i);
  });
});

describe("admin credit help", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = "root@company.com";
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("lets support grant credits and records the audit trail", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.grantAdmin, {
        email: SUPPORT.email,
        role: "support",
      });

    const result = await t
      .withIdentity(SUPPORT)
      .mutation(api.admin.grantCredits, {
        scopeType: "user",
        scopeId: NORMAL.subject,
        credits: 500,
        reason: "goodwill for failed top-up",
      });
    expect(result.applied).toBe(500);
    expect(result.balance).toBe(500);

    const account = await t
      .withIdentity(SUPPORT)
      .query(api.admin.getUserAccount, { clerkId: NORMAL.subject });
    expect(account.personal.creditBalance).toBe(500);
    expect(account.adjustments[0]?.kind).toBe("grant");
    expect(account.complimentary).toBe(false);

    const log = await t.withIdentity(ROOT).query(api.admin.auditLog, {});
    expect(log.some((r) => r.action === "credits.granted")).toBe(true);
  });

  it("refunds a settled payment once and refuses a replay", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const paymentId = await t.run(async (ctx) => {
      await ctx.db.insert("agentWallets", {
        scopeType: "user",
        scopeId: NORMAL.subject,
        balance: 0,
        lifetimeCredits: 0,
        lifetimeSpent: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("payments", {
        scopeType: "user",
        scopeId: NORMAL.subject,
        asset: "USDC",
        network: "base-sepolia",
        amountAtomic: "1000000",
        creditsGranted: 1000,
        nonce: "0xrefund-once",
        facilitator: "mock",
        status: "settled",
        createdAt: Date.now(),
      });
    });

    const first = await t
      .withIdentity(ROOT)
      .mutation(api.admin.refundCredits, {
        paymentId,
        reason: "duplicate charge",
      });
    expect(first.applied).toBe(1000);
    expect(first.balance).toBe(1000);

    await expect(
      t.withIdentity(ROOT).mutation(api.admin.refundCredits, {
        paymentId,
        reason: "duplicate charge again",
      }),
    ).rejects.toThrow(/already been refunded/i);
  });

  it("restricts debit to superadmins and never drops a wallet below zero", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.grantAdmin, {
        email: SUPPORT.email,
        role: "support",
      });
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.grantCredits, {
        scopeType: "user",
        scopeId: NORMAL.subject,
        credits: 40,
        reason: "seed",
      });

    await expect(
      t.withIdentity(SUPPORT).mutation(api.admin.debitCredits, {
        scopeType: "user",
        scopeId: NORMAL.subject,
        credits: 10,
        reason: "clawback",
      }),
    ).rejects.toThrow(/superadmin/i);

    const debited = await t
      .withIdentity(ROOT)
      .mutation(api.admin.debitCredits, {
        scopeType: "user",
        scopeId: NORMAL.subject,
        credits: 100,
        reason: "clawback overflow",
      });
    expect(debited.applied).toBe(40);
    expect(debited.balance).toBe(0);
  });

  it("denies credit mutations to ordinary users", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await expect(
      t.withIdentity(NORMAL).mutation(api.admin.grantCredits, {
        scopeType: "user",
        scopeId: NORMAL.subject,
        credits: 10,
        reason: "self serve",
      }),
    ).rejects.toThrow(/platform admin/i);
  });

  it("marks env-root users complimentary on the user list", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const rows = await t.withIdentity(ROOT).query(api.admin.listUsers, {});
    expect(rows.find((u) => u.clerkId === ROOT.subject)?.complimentary).toBe(
      true,
    );
    expect(rows.find((u) => u.clerkId === NORMAL.subject)?.complimentary).toBe(
      false,
    );
  });
});
