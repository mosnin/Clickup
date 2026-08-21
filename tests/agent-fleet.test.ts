import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  attenuate,
  clampFleetSize,
  withinEnvelope,
  MAX_FLEET_SIZE,
  type Envelope,
} from "../convex/_envelope";

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "fleet_owner" };
const MEMBER = { subject: "fleet_member" };

const HOLDER_KEY = "cua_orchestrator_key_0001";

// ── The security boundary ──────────────────────────────────────────────
//
// Everything else in the fleet feature rests on this function. If a request
// can ever come back WIDER than its envelope, one human approval becomes an
// unbounded grant and the whole design is a privilege-escalation hole.

const FULL: Envelope = {
  role: "member",
  dailyActionLimit: 2000,
  maxAgents: 10,
};

describe("attenuation", () => {
  it("never widens the role", () => {
    const readonlyGrant: Envelope = { ...FULL, role: "readonly" };
    // The whole point: a readonly grant cannot produce a writing agent, no
    // matter what the orchestrator asks for.
    expect(attenuate(readonlyGrant, { role: "member" }).role).toBe("readonly");
    expect(attenuate(readonlyGrant, {}).role).toBe("readonly");
    // Narrowing is always allowed.
    expect(attenuate(FULL, { role: "readonly" }).role).toBe("readonly");
    expect(attenuate(FULL, {}).role).toBe("member");
  });

  it("never raises the daily budget", () => {
    expect(attenuate(FULL, { dailyActionLimit: 99999 }).dailyActionLimit).toBe(
      2000,
    );
    expect(attenuate(FULL, { dailyActionLimit: 50 }).dailyActionLimit).toBe(50);
    expect(attenuate(FULL, {}).dailyActionLimit).toBe(2000);
  });

  it("coerces hostile numbers rather than trusting them", () => {
    // This arrives from an agent. Math.min(NaN, x) is NaN, which would land
    // an unusable limit on the row and effectively disable the budget.
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      const out = attenuate(FULL, { dailyActionLimit: bad as number });
      expect(Number.isFinite(out.dailyActionLimit)).toBe(true);
      expect(out.dailyActionLimit).toBeLessThanOrEqual(FULL.dailyActionLimit);
    }
    expect(attenuate(FULL, { dailyActionLimit: -5 }).dailyActionLimit).toBe(0);
  });

  it("intersects list fences and never unions them", () => {
    const fenced: Envelope = { ...FULL, allowedListIds: ["a", "b"] };
    // Asking for a list outside the fence does not get it.
    expect(attenuate(fenced, { allowedListIds: ["b", "c"] }).allowedListIds)
      .toEqual(["b"]);
    // Asking for nothing inherits the fence rather than escaping it.
    expect(attenuate(fenced, {}).allowedListIds).toEqual(["a", "b"]);
    // An unfenced grant may still be narrowed by the request.
    expect(attenuate(FULL, { allowedListIds: ["z"] }).allowedListIds).toEqual([
      "z",
    ]);
    // An unfenced grant with an unfenced request stays unfenced.
    expect(attenuate(FULL, {}).allowedListIds).toBeUndefined();
  });

  it("is idempotent and monotonic under chaining", () => {
    // Attenuating an already-attenuated result must never recover authority,
    // which is what makes a chain of provisioning safe.
    const once = attenuate(FULL, { role: "readonly", dailyActionLimit: 100 });
    const chained: Envelope = { ...FULL, ...once };
    const twice = attenuate(chained, { role: "member", dailyActionLimit: 5000 });
    expect(twice.role).toBe("readonly");
    expect(twice.dailyActionLimit).toBe(100);
  });

  it("treats an empty fence as a real fence, not as absent", () => {
    // "fenced to nothing" and "not fenced" are different authorizations and
    // conflating them would silently grant the whole scope.
    const none: Envelope = { ...FULL, allowedListIds: [] };
    expect(attenuate(none, { allowedListIds: ["a"] }).allowedListIds).toEqual([]);
  });
});

describe("fleet size", () => {
  it("clamps to a sane, finite ceiling", () => {
    expect(clampFleetSize(undefined)).toBeGreaterThan(0);
    expect(clampFleetSize(99999)).toBe(MAX_FLEET_SIZE);
    expect(clampFleetSize(0)).toBe(1);
    expect(clampFleetSize(-4)).toBe(1);
    expect(clampFleetSize(NaN)).toBeGreaterThan(0);
    expect(clampFleetSize(3.7)).toBe(3);
  });
});

describe("withinEnvelope", () => {
  it("refuses a sub-grant wider than its parent on any axis", () => {
    expect(withinEnvelope(FULL, FULL)).toBe(true);
    expect(withinEnvelope(FULL, { ...FULL, dailyActionLimit: 3000 })).toBe(false);
    expect(withinEnvelope(FULL, { ...FULL, maxAgents: 11 })).toBe(false);
    expect(
      withinEnvelope({ ...FULL, role: "readonly" }, { ...FULL, role: "member" }),
    ).toBe(false);
    // An unfenced inner inside a fenced outer is wider by definition.
    expect(
      withinEnvelope({ ...FULL, allowedListIds: ["a"] }, FULL),
    ).toBe(false);
    expect(
      withinEnvelope(
        { ...FULL, allowedListIds: ["a", "b"] },
        { ...FULL, allowedListIds: ["a"] },
      ),
    ).toBe(true);
  });
});

// ── End to end ─────────────────────────────────────────────────────────

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Fleet Co",
      slug: "fleet-co",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const [userClerkId, role] of [
      [OWNER.subject, "owner"],
      [MEMBER.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId,
        role,
        joinedAt: Date.now(),
      });
    }
    const holderId = await ctx.db.insert("agents", {
      name: "Orchestrator",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId: holderId,
      keyHash: sha256Hex(HOLDER_KEY),
      keyPrefix: HOLDER_KEY.slice(0, 12),
      createdAt: Date.now(),
    });
    return { workspaceId, holderId };
  });
  return { t, ...ids };
}

let keyCounter = 0;
function keyMaterial() {
  keyCounter += 1;
  const key = `cua_worker_${keyCounter}`;
  return { keyHash: sha256Hex(key), keyPrefix: key.slice(0, 12) };
}

describe("provisioning", () => {
  it("refuses an agent that holds no grant", async () => {
    const { t } = await setup();
    // The default. An agent cannot make more agents just because it exists.
    await expect(
      t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: "Worker",
        ...keyMaterial(),
      }),
    ).rejects.toThrow(/may not provision/i);
  });

  it("provisions under a grant, narrowed to the envelope", async () => {
    const { t, holderId } = await setup();
    await t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 3,
      role: "readonly",
      dailyActionLimit: 500,
    });

    const worker = await t.mutation(api.agentGrants.provisionAgent, {
      apiKey: HOLDER_KEY,
      name: "Worker One",
      // Asks for more than the grant allows on both axes.
      role: "member",
      dailyActionLimit: 100000,
      ...keyMaterial(),
    });
    expect(worker.role).toBe("readonly");
    expect(worker.dailyActionLimit).toBe(500);
    expect(worker.fleetRemaining).toBe(2);

    const agent = await t.run(async (ctx) => ctx.db.get(worker.agentId));
    expect(agent?.role).toBe("readonly");
    expect(agent?.dailyActionLimit).toBe(500);
    // Accountability lands on the human who granted the fleet, not the
    // machine that ran the provision.
    expect(agent?.createdByClerkId).toBe(OWNER.subject);
  });

  it("stops at the ceiling", async () => {
    const { t, holderId } = await setup();
    await t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 2,
      role: "member",
      dailyActionLimit: 1000,
    });
    for (let i = 0; i < 2; i += 1) {
      await t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: `Worker ${i}`,
        ...keyMaterial(),
      });
    }
    await expect(
      t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: "One too many",
        ...keyMaterial(),
      }),
    ).rejects.toThrow(/limit/i);
  });

  it("frees a slot when a worker is paused", async () => {
    const { t, holderId } = await setup();
    await t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 1,
      role: "member",
      dailyActionLimit: 1000,
    });
    const first = await t.mutation(api.agentGrants.provisionAgent, {
      apiKey: HOLDER_KEY,
      name: "Retiring",
      ...keyMaterial(),
    });
    await t.run(async (ctx) =>
      ctx.db.patch(first.agentId, { status: "paused" }),
    );
    // Counting live members rather than every member ever created is what
    // lets a long-running fleet churn workers without hitting a false wall.
    await expect(
      t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: "Replacement",
        ...keyMaterial(),
      }),
    ).resolves.toMatchObject({ name: "Replacement" });
  });
});

describe("revocation", () => {
  it("is one switch for the whole fleet, and takes the keys", async () => {
    const { t, holderId, workspaceId } = await setup();
    const { grantId } = await t
      .withIdentity(OWNER)
      .mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 5,
        role: "member",
        dailyActionLimit: 1000,
      });
    const workers = [];
    for (let i = 0; i < 3; i += 1) {
      workers.push(
        await t.mutation(api.agentGrants.provisionAgent, {
          apiKey: HOLDER_KEY,
          name: `Worker ${i}`,
          ...keyMaterial(),
        }),
      );
    }

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.agentGrants.revokeFleet, { grantId });
    expect(result.revoked).toBe(3);

    for (const worker of workers) {
      const agent = await t.run(async (ctx) => ctx.db.get(worker.agentId));
      expect(agent?.status).toBe("paused");
      // Pausing alone is not revocation — a paused agent still holds a
      // valid key. Deleting the key is what actually cuts it off.
      const keys = await t.run(async (ctx) =>
        ctx.db
          .query("agentKeys")
          .withIndex("by_agent", (q) => q.eq("agentId", worker.agentId))
          .collect(),
      );
      expect(keys).toHaveLength(0);
    }

    // And no further provisioning under a dead grant.
    await expect(
      t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: "After the end",
        ...keyMaterial(),
      }),
    ).rejects.toThrow(/may not provision/i);
    void workspaceId;
  });

  it("is idempotent", async () => {
    const { t, holderId } = await setup();
    const { grantId } = await t
      .withIdentity(OWNER)
      .mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 2,
        role: "member",
        dailyActionLimit: 1000,
      });
    await t.withIdentity(OWNER).mutation(api.agentGrants.revokeFleet, { grantId });
    await expect(
      t.withIdentity(OWNER).mutation(api.agentGrants.revokeFleet, { grantId }),
    ).resolves.toMatchObject({ alreadyRevoked: true });
  });
});

describe("who may grant a fleet", () => {
  it("takes owner or admin, never a plain member", async () => {
    const { t, holderId } = await setup();
    // Granting a fleet is strictly more consequential than creating one
    // agent, so it can never be the softer path.
    await expect(
      t.withIdentity(MEMBER).mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 5,
        role: "member",
        dailyActionLimit: 1000,
      }),
    ).rejects.toThrow(/owners and admins/i);
  });

  it("refuses a second live grant to the same holder", async () => {
    const { t, holderId } = await setup();
    const asOwner = t.withIdentity(OWNER);
    await asOwner.mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 2,
      role: "readonly",
      dailyActionLimit: 100,
    });
    // Otherwise an orchestrator accumulates authority by asking twice, and
    // "the envelope" stops having a single meaning.
    await expect(
      asOwner.mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 50,
        role: "member",
        dailyActionLimit: 100000,
      }),
    ).rejects.toThrow(/already runs a fleet/i);
  });

  it("clamps a hostile ceiling at grant time", async () => {
    const { t, holderId } = await setup();
    const { maxAgents } = await t
      .withIdentity(OWNER)
      .mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 100000,
        role: "member",
        dailyActionLimit: 1000,
      });
    expect(maxAgents).toBe(MAX_FLEET_SIZE);
  });

  it("refuses a non-positive daily budget at grant time", async () => {
    const { t, holderId } = await setup();
    await expect(
      t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 2,
        role: "member",
        dailyActionLimit: 0,
      }),
    ).rejects.toThrow(/positive integer/i);
    await expect(
      t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
        holderAgentId: holderId,
        maxAgents: 2,
        role: "member",
        dailyActionLimit: -5,
      }),
    ).rejects.toThrow(/positive integer/i);
  });

  it("stops provisioning and worker keys when the workspace owner is held", async () => {
    const { t, holderId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: OWNER.subject,
        email: "fleet-owner@example.com",
      });
    });
    await t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 3,
      role: "member",
      dailyActionLimit: 1000,
    });
    const worker = await t.mutation(api.agentGrants.provisionAgent, {
      apiKey: HOLDER_KEY,
      name: "Before hold",
      ...keyMaterial(),
    });
    expect(worker.name).toBe("Before hold");

    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", OWNER.subject))
        .unique();
      await ctx.db.patch(user!._id, { suspendedAt: Date.now() });
    });

    await expect(
      t.mutation(api.agentGrants.provisionAgent, {
        apiKey: HOLDER_KEY,
        name: "After hold",
        ...keyMaterial(),
      }),
    ).rejects.toThrow(/account suspended/i);
    await expect(
      t.query(api.agentGrants.myFleet, { apiKey: HOLDER_KEY }),
    ).rejects.toThrow(/account suspended/i);
  });
});

describe("the fleet is visible", () => {
  it("reports headroom and members to the human and the orchestrator alike", async () => {
    const { t, holderId, workspaceId } = await setup();
    await t.withIdentity(OWNER).mutation(api.agentGrants.grantFleet, {
      holderAgentId: holderId,
      maxAgents: 4,
      role: "member",
      dailyActionLimit: 1000,
    });
    await t.mutation(api.agentGrants.provisionAgent, {
      apiKey: HOLDER_KEY,
      name: "Visible",
      ...keyMaterial(),
    });

    const human = await t
      .withIdentity(OWNER)
      .query(api.agentGrants.listForScope, {
        parentType: "workspace",
        parentId: workspaceId,
      });
    expect(human).toHaveLength(1);
    expect(human[0].activeCount).toBe(1);
    expect(human[0].maxAgents).toBe(4);
    expect(human[0].members.map((m) => m.name)).toEqual(["Visible"]);

    // The orchestrator sees the same fleet, so it can plan against real
    // headroom instead of discovering the ceiling by hitting it.
    const agentView = await t.query(api.agentGrants.myFleet, {
      apiKey: HOLDER_KEY,
    });
    expect(agentView?.remaining).toBe(3);
    expect(agentView?.ceiling.dailyActionLimit).toBe(1000);
    void holderId;
  });

  it("tells an ungranted agent no, rather than erroring", async () => {
    const { t } = await setup();
    // "May I provision" is a reasonable question and a no is an answer.
    expect(await t.query(api.agentGrants.myFleet, { apiKey: HOLDER_KEY })).toBe(
      null,
    );
  });
});
