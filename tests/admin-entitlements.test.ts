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
    ).rejects.toThrow(/account suspended/i);
    // Reads and presence used to keep working after a hold — that is how a
    // compromised staff fleet stayed live. whoami is the cheapest probe.
    await expect(t.query(api.agentApi.whoami, { apiKey })).rejects.toThrow(
      /account suspended/i,
    );
  });

  it("stops a funded tenant agent when the owner is held, not when credits run out", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await enableMetering(t, 2);
    const apiKey = await seedAgent(t, NORMAL.subject, "cua_normal_hold");
    await t.run(async (ctx) => {
      await ctx.db.insert("agentWallets", {
        scopeType: "user",
        scopeId: NORMAL.subject,
        balance: 10_000,
        lifetimeCredits: 10_000,
        lifetimeSpent: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendUser, {
        clerkId: NORMAL.subject,
        reason: "nonpayment",
      });
    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "Should not land" }),
    ).rejects.toThrow(/account suspended/i);
  });

  it("stops every agent in a suspended workspace, including fleet workers", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const { apiKey, workspaceId, holderKey } = await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        name: "Held Co",
        slug: "held-co",
        ownerClerkId: NORMAL.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: NORMAL.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      const holderId = await ctx.db.insert("agents", {
        name: "Orchestrator",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: NORMAL.subject,
        createdAt: Date.now(),
      });
      const holderKey = "cua_ws_holder";
      await ctx.db.insert("agentKeys", {
        agentId: holderId,
        keyHash: sha256Hex(holderKey),
        keyPrefix: holderKey.slice(0, 8),
        createdAt: Date.now(),
      });
      const workerId = await ctx.db.insert("agents", {
        name: "Worker",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: NORMAL.subject,
        createdAt: Date.now(),
      });
      const apiKey = "cua_ws_worker";
      await ctx.db.insert("agentKeys", {
        agentId: workerId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 8),
        createdAt: Date.now(),
      });
      return { apiKey, workspaceId, holderKey };
    });

    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendWorkspace, {
        workspaceId,
        reason: "abuse",
      });

    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "After ws hold" }),
    ).rejects.toThrow(/workspace suspended/i);
    await expect(t.query(api.agentApi.whoami, { apiKey: holderKey })).rejects.toThrow(
      /workspace suspended/i,
    );
  });

  it("stops workspace agents when the owner is held, but not when a member is", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const MEMBER = { subject: "user_member", email: "member@company.com" };
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: MEMBER.subject, email: MEMBER.email });
    });
    const { ownerKey, memberPersonalKey, workspaceId } = await t.run(
      async (ctx) => {
        const workspaceId = await ctx.db.insert("workspaces", {
          name: "Team Co",
          slug: "team-co",
          ownerClerkId: NORMAL.subject,
          createdAt: Date.now(),
        });
        for (const [userClerkId, role] of [
          [NORMAL.subject, "owner"],
          [MEMBER.subject, "member"],
        ] as const) {
          await ctx.db.insert("memberships", {
            workspaceId,
            userClerkId,
            role,
            joinedAt: Date.now(),
          });
        }
        const ownerAgent = await ctx.db.insert("agents", {
          name: "Team bot",
          parentType: "workspace",
          parentId: workspaceId,
          status: "active",
          createdByClerkId: NORMAL.subject,
          createdAt: Date.now(),
        });
        const ownerKey = "cua_team_owner";
        await ctx.db.insert("agentKeys", {
          agentId: ownerAgent,
          keyHash: sha256Hex(ownerKey),
          keyPrefix: ownerKey.slice(0, 8),
          createdAt: Date.now(),
        });
        const memberAgent = await ctx.db.insert("agents", {
          name: "Member personal",
          parentType: "user",
          parentId: MEMBER.subject,
          status: "active",
          createdByClerkId: MEMBER.subject,
          createdAt: Date.now(),
        });
        const memberPersonalKey = "cua_member_personal";
        await ctx.db.insert("agentKeys", {
          agentId: memberAgent,
          keyHash: sha256Hex(memberPersonalKey),
          keyPrefix: memberPersonalKey.slice(0, 8),
          createdAt: Date.now(),
        });
        return { ownerKey, memberPersonalKey, workspaceId };
      },
    );
    void workspaceId;

    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendUser, {
        clerkId: MEMBER.subject,
        reason: "member only",
      });
    // A member hold must not take the whole tenant's fleet down.
    await expect(
      t.query(api.agentApi.whoami, { apiKey: ownerKey }),
    ).resolves.toMatchObject({ name: "Team bot" });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: memberPersonalKey }),
    ).rejects.toThrow(/account suspended/i);

    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendUser, {
        clerkId: NORMAL.subject,
        reason: "owner hold",
      });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: ownerKey }),
    ).rejects.toThrow(/account suspended/i);
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
