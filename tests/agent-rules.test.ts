import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Integration tests for the rules that make multi-agent collaboration
// safe: hierarchy authz, claims, blockers, approval gates, roles, and
// budgets — run against convex-test's in-memory backend.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

// Everything a test needs: Alice's personal space with one list + its
// statuses, and an agent with a usable API key.
async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);

  const ids = await t.run(async (ctx) => {
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Tasks",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const openStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const doneStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_scout";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { spaceId, listId, openStatus, doneStatus, agentId, apiKey };
  });

  return { t, alice, ...ids };
}

describe("read authorization", () => {
  it("does not leak tasks across users by ID", async () => {
    const { t, alice, listId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Secret plan",
    });

    const bob = t.withIdentity(BOB);
    expect(await bob.query(api.tasks.get, { taskId })).toBeNull();
    expect(await bob.query(api.tasks.listForList, { listId })).toEqual([]);
    expect(await bob.query(api.tasks.titles, { taskIds: [taskId] })).toEqual(
      {},
    );
    // The owner still sees it.
    expect(await alice.query(api.tasks.get, { taskId })).not.toBeNull();
  });
});

describe("claims", () => {
  it("refuses a second claim while the first is fresh", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Contested work",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });
    await expect(
      alice.mutation(api.tasks.claim, { taskId }),
    ).rejects.toThrow(/already claimed/);
    // Humans can force-release, after which claiming works.
    await alice.mutation(api.tasks.releaseClaim, { taskId });
    await alice.mutation(api.tasks.claim, { taskId });
  });
});

describe("blockers", () => {
  it("refuses completion while a blocker is open", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const blocker = await alice.mutation(api.tasks.create, {
      listId,
      title: "Foundation",
    });
    const blocked = await alice.mutation(api.tasks.create, {
      listId,
      title: "Roof",
    });
    await alice.mutation(api.tasks.update, {
      taskId: blocked,
      blockedByTaskIds: [blocker],
    });

    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey, taskId: blocked }),
    ).rejects.toThrow(/blocked/);

    await alice.mutation(api.tasks.update, {
      taskId: blocker,
      statusId: doneStatus,
    });
    await t.mutation(api.agentApi.completeTask, { apiKey, taskId: blocked });
  });
});

describe("approval gates", () => {
  it("blocks agents until a human approves; agents cannot lower the gate", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Risky deploy",
      requiresApproval: true,
    });

    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey, taskId }),
    ).rejects.toThrow(/approval/);
    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey,
        taskId,
        requiresApproval: false,
      }),
    ).rejects.toThrow(/Only a human/);

    await alice.mutation(api.tasks.approve, { taskId });
    await t.mutation(api.agentApi.completeTask, { apiKey, taskId });
  });
});

describe("agent governance", () => {
  it("rejects mutations from readonly agents but allows reads", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, { agentId, role: "readonly" });

    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId,
        title: "Nope",
      }),
    ).rejects.toThrow(/read-only/);
    // Reads and presence still work.
    expect(await t.query(api.agentApi.listTasks, { apiKey })).toEqual([]);
    await t.mutation(api.agentApi.heartbeat, {
      apiKey,
      statusText: "observing",
    });
  });

  it("enforces the daily action budget", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, { agentId, dailyActionLimit: 2 });

    await t.mutation(api.agentApi.createTask, { apiKey, listId, title: "1" });
    await t.mutation(api.agentApi.createTask, { apiKey, listId, title: "2" });
    await expect(
      t.mutation(api.agentApi.createTask, { apiKey, listId, title: "3" }),
    ).rejects.toThrow(/budget exhausted/);
  });

  it("confines list-restricted agents to their allowed lists", async () => {
    const { t, alice, spaceId, listId, agentId, apiKey } = await setup();
    const otherList = await t.run(async (ctx) => {
      const id = await ctx.db.insert("lists", {
        name: "Off limits",
        parentType: "space",
        parentId: spaceId,
        position: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("listStatuses", {
        listId: id,
        name: "To Do",
        color: "#aaa",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      return id;
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });

    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Allowed",
    });
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId: otherList as Id<"lists">,
        title: "Denied",
      }),
    ).rejects.toThrow(/not allowed/);
    // Structure-level ops are refused entirely for restricted agents.
    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "New space" }),
    ).rejects.toThrow(/restricted/);
  });

  it("normalizes an empty allowedListIds to unrestricted instead of bricking the agent", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    // Restrict, then remove the only restriction the way the UI does when
    // the last badge is cleared (filtering the array down to []).
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [],
    });
    const agent = await t.run((ctx) => ctx.db.get(agentId));
    // [] must never be stored verbatim — _agentAuth keys off `undefined`,
    // so a stored [] would refuse every list and every structure op.
    expect(agent?.allowedListIds).toBeUndefined();

    // The agent is unrestricted again: it can create a space (a
    // structure-level op restricted agents can never perform) and create a
    // task on a list that was never in the old allow-list.
    await t.mutation(api.agentApi.createSpace, { apiKey, name: "New space" });
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Still works",
    });

    // null (what the UI now sends) normalizes the same way.
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: null,
    });
    const agentAfterNull = await t.run((ctx) => ctx.db.get(agentId));
    expect(agentAfterNull?.allowedListIds).toBeUndefined();
  });

  it("invalid and revoked keys are rejected", async () => {
    const { t, apiKey } = await setup();
    await expect(
      t.query(api.agentApi.whoami, { apiKey: "cua_wrong" }),
    ).rejects.toThrow(/Invalid API key/);
    await t.run(async (ctx) => {
      const key = await ctx.db
        .query("agentKeys")
        .withIndex("by_hash", (q) => q.eq("keyHash", sha256Hex(apiKey)))
        .unique();
      await ctx.db.patch(key!._id, { revokedAt: Date.now() });
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey }),
    ).rejects.toThrow(/Invalid API key/);
  });
});
