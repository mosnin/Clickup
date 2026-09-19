import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  STARTER_MAX_AGENTS,
  STARTER_MAX_WORKSPACES,
} from "../convex/_adminEntitlements";
import { DEFAULT_DAILY_ACTION_LIMIT } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@operate.to" };
const TENANT = { subject: "user_tenant", email: "tenant@example.com" };
const GRANTED = { subject: "user_granted", email: "granted@operate.to" };

async function seedUsers(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const u of [OWNER, TENANT, GRANTED]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
}

async function seedAgent(
  t: ReturnType<typeof convexTest>,
  parentId: string,
  key: string,
) {
  await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", {
      name: "Bot",
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
}

describe("owner-admin bypasses plan caps", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = OWNER.email;
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("lets the application owner create past the Starter agent cap", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);

    for (let i = 0; i < STARTER_MAX_AGENTS; i += 1) {
      await t.withIdentity(TENANT).mutation(api.agents.create, {
        name: `Tenant ${i + 1}`,
        parentType: "user",
        parentId: TENANT.subject,
      });
    }
    await expect(
      t.withIdentity(TENANT).mutation(api.agents.create, {
        name: "Tenant overflow",
        parentType: "user",
        parentId: TENANT.subject,
      }),
    ).rejects.toThrow(/agent limit/i);

    for (let i = 0; i < STARTER_MAX_AGENTS + 2; i += 1) {
      const id = await t.withIdentity(OWNER).mutation(api.agents.create, {
        name: `Owner ${i + 1}`,
        parentType: "user",
        parentId: OWNER.subject,
      });
      expect(id).toBeTruthy();
    }
  });

  it("lets an explicitly granted owner-admin bypass the same cap", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t.withIdentity(OWNER).mutation(api.admin.grantAdmin, {
      email: GRANTED.email,
      role: "support",
    });

    for (let i = 0; i < STARTER_MAX_AGENTS + 1; i += 1) {
      await t.withIdentity(GRANTED).mutation(api.agents.create, {
        name: `Granted ${i + 1}`,
        parentType: "user",
        parentId: GRANTED.subject,
      });
    }
    const agents = await t.run(async (ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "user").eq("parentId", GRANTED.subject),
        )
        .collect(),
    );
    expect(agents.length).toBeGreaterThan(STARTER_MAX_AGENTS);
  });

  it("lets the owner create past the Starter workspace cap", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);

    await t.withIdentity(TENANT).mutation(api.workspaces.create, {
      name: "Tenant HQ",
    });
    await expect(
      t.withIdentity(TENANT).mutation(api.workspaces.create, {
        name: "Tenant second",
      }),
    ).rejects.toThrow(/workspace limit/i);

    const first = await t.withIdentity(OWNER).mutation(api.workspaces.create, {
      name: "Owner HQ",
    });
    const second = await t.withIdentity(OWNER).mutation(api.workspaces.create, {
      name: "Owner Lab",
    });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(STARTER_MAX_WORKSPACES).toBe(1);
  });

  it("does not cap owner-admin agents at the Starter action budget", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await seedAgent(t, OWNER.subject, "cua_owner_budget");
    await t.run(async (ctx) => {
      const agent = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "user").eq("parentId", OWNER.subject),
        )
        .unique();
      await ctx.db.insert("agentUsage", {
        agentId: agent!._id,
        day: new Date().toISOString().slice(0, 10),
        count: DEFAULT_DAILY_ACTION_LIMIT,
      });
    });
    await expect(
      t.mutation(api.agentApi.createSpace, {
        apiKey: "cua_owner_budget",
        name: "Past starter budget",
      }),
    ).resolves.toBeTruthy();
  });

  it("still stops a normal tenant at the Starter action budget", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await seedAgent(t, TENANT.subject, "cua_tenant_budget");
    await t.run(async (ctx) => {
      const agent = await ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "user").eq("parentId", TENANT.subject),
        )
        .unique();
      await ctx.db.insert("agentUsage", {
        agentId: agent!._id,
        day: new Date().toISOString().slice(0, 10),
        count: DEFAULT_DAILY_ACTION_LIMIT,
      });
    });
    await expect(
      t.mutation(api.agentApi.createSpace, {
        apiKey: "cua_tenant_budget",
        name: "Over",
      }),
    ).rejects.toThrow(/daily action budget/i);
  });
});

describe("tenant isolation still holds", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = OWNER.email;
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("does not lift a tenant workspace's caps when an owner-admin joins it", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const workspaceId = await t
      .withIdentity(TENANT)
      .mutation(api.workspaces.create, { name: "Customer" });

    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: OWNER.subject,
        role: "admin",
        joinedAt: Date.now(),
      });
    });

    for (let i = 0; i < STARTER_MAX_AGENTS; i += 1) {
      await t.withIdentity(OWNER).mutation(api.agents.create, {
        name: `Customer agent ${i + 1}`,
        parentType: "workspace",
        parentId: workspaceId,
      });
    }
    await expect(
      t.withIdentity(OWNER).mutation(api.agents.create, {
        name: "Customer overflow",
        parentType: "workspace",
        parentId: workspaceId,
      }),
    ).rejects.toThrow(/agent limit/i);

    // The owner's own personal space stays uncapped.
    const own = await t.withIdentity(OWNER).mutation(api.agents.create, {
      name: "Owner personal",
      parentType: "user",
      parentId: OWNER.subject,
    });
    expect(own).toBeTruthy();
  });

  it("refuses the owner creating an agent in a tenant's personal space", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.agents.create, {
        name: "Cross-tenant",
        parentType: "user",
        parentId: TENANT.subject,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});

describe("fleet grant is human-only", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = OWNER.email;
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("refuses grantFleet without a Clerk identity", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const holderAgentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", {
        name: "Orchestrator",
        parentType: "user",
        parentId: OWNER.subject,
        status: "active",
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      }),
    );
    await expect(
      t.mutation(api.agentGrants.grantFleet, {
        holderAgentId,
        role: "member",
        dailyActionLimit: 2000,
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  it("never exposes grantFleet on the agent MCP surface", () => {
    const route = readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const names = readFileSync("src/lib/mcp-tool-names.ts", "utf8");
    expect(route).not.toMatch(/grantFleet|grant_fleet/);
    expect(names).not.toMatch(/grant_fleet/);
    expect(route).toMatch(/provision_agent/);
  });

  it("wires a human-only grant control on the existing-agent page", () => {
    const source = readFileSync(
      "src/app/dashboard/agents/[agentId]/agent-detail.tsx",
      "utf8",
    );
    expect(source).toMatch(/api\.agentGrants\.grantFleet/);
    expect(source).toMatch(/api\.agentGrants\.revokeFleet/);
    expect(source).toMatch(/canManage \?/);
    expect(source).toMatch(/cannot grant itself a fleet/);
    const backend = readFileSync("convex/agentGrants.ts", "utf8");
    const grantFleet = backend.match(
      /export const grantFleet = mutation\(\{[\s\S]*?\n\}\);/,
    )?.[0];
    expect(grantFleet).toBeTruthy();
    expect(grantFleet).toMatch(/requireIdentity\(ctx\)/);
    expect(grantFleet).not.toMatch(/apiKey/);
  });
});
