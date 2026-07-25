import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice", email: "alice@example.com" };
const MALLORY = { subject: "user_mallory", email: "mallory@example.com" };
const API_KEY = "cua_test_decision_agent";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const user of [ALICE, MALLORY]) {
      await ctx.db.insert("users", {
        clerkId: user.subject,
        email: user.email,
        name: user.subject === ALICE.subject ? "Alice" : "Mallory",
      });
    }
    const spaceId = await ctx.db.insert("spaces", {
      name: "Company",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Launch",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const otherListId = await ctx.db.insert("lists", {
      name: "Other",
      parentType: "space",
      parentId: spaceId,
      position: 1,
      createdAt: Date.now(),
    });
    const statusId = await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const doneStatusId = await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#22c55e",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    const otherStatusId = await ctx.db.insert("listStatuses", {
      listId: otherListId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const taskId = await ctx.db.insert("tasks", {
      listId,
      title: "Prepare launch",
      statusId,
      assigneeClerkIds: [],
      createdByClerkId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const otherTaskId = await ctx.db.insert("tasks", {
      listId: otherListId,
      title: "Other task",
      statusId: otherStatusId,
      assigneeClerkIds: [],
      createdByClerkId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Operator",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.patch(taskId, { assigneeClerkIds: [agentId] });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(API_KEY),
      keyPrefix: API_KEY.slice(0, 12),
      createdAt: Date.now(),
    });
    return { listId, otherListId, taskId, otherTaskId, doneStatusId };
  });
  return {
    t,
    alice: t.withIdentity(ALICE),
    mallory: t.withIdentity(MALLORY),
    ...ids,
  };
}

describe("versioned operating decisions", () => {
  it("invalidates linked context and blocks execution until impact review", async () => {
    const { t, alice, listId, taskId, doneStatusId } = await setup();
    const packet = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Launch brief",
      content: "Initial launch assumptions.",
      taskIds: [taskId],
    });
    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey: API_KEY,
      taskId,
      packets: [{ packetId: packet.packetId, version: 1 }],
    });

    const created = await alice.mutation(api.decisions.create, {
      listId,
      key: "launch.region",
      title: "Launch region",
      statement: "Launch in the United States first.",
      rationale: "Support coverage is strongest there.",
      contextPacketId: packet.packetId,
      taskIds: [taskId],
    });
    expect(created.version).toBe(1);

    const task = await t.query(api.agentApi.getTask, {
      apiKey: API_KEY,
      taskId,
    });
    expect(task.contextReadiness).toMatchObject({
      ready: false,
      packets: [{ currentVersion: 2, acknowledgedVersion: 1, state: "stale" }],
    });
    expect(task.decisions).toMatchObject([
      {
        decisionId: created.decisionId,
        key: "launch.region",
        version: 1,
        impactStatus: "pending",
      },
    ]);

    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey: API_KEY,
      taskId,
      packets: [{ packetId: packet.packetId, version: 2 }],
    });
    await expect(
      t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId }),
    ).rejects.toThrow(/decision impact review required/i);
    await expect(
      alice.mutation(api.tasks.update, {
        taskId,
        statusId: doneStatusId,
      }),
    ).rejects.toThrow(/decision impact review required/i);

    const [impact] = await t.query(api.agentApi.listDecisionsForTask, {
      apiKey: API_KEY,
      taskId,
    });
    await t.mutation(api.agentApi.assessDecisionImpact, {
      apiKey: API_KEY,
      impactId: impact.impactId,
      status: "no_change",
      note: "Task already targets the US launch.",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId });
  });

  it("preserves superseded versions and reopens every prior task impact", async () => {
    const { t, alice, listId, taskId } = await setup();
    const first = await alice.mutation(api.decisions.create, {
      listId,
      key: "launch.region",
      title: "Launch region",
      statement: "Launch in the United States first.",
      rationale: "Initial support coverage.",
      taskIds: [taskId],
    });
    const [firstImpact] = await alice.query(api.decisions.listForTask, {
      taskId,
    });
    await alice.mutation(api.decisions.assessImpact, {
      impactId: firstImpact.impactId,
      status: "no_change",
    });

    const second = await t.mutation(api.agentApi.supersedeDecision, {
      apiKey: API_KEY,
      decisionId: first.decisionId,
      statement: "Launch in the United States and Canada together.",
      rationale: "Canadian support and compliance are now ready.",
    });
    expect(second.version).toBe(2);

    const history = await alice.query(api.decisions.listForTask, { taskId });
    expect(history).toHaveLength(2);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decisionId: first.decisionId,
          decisionStatus: "superseded",
          statement: "Launch in the United States first.",
          impactStatus: "no_change",
        }),
        expect.objectContaining({
          decisionId: second.decisionId,
          decisionStatus: "active",
          version: 2,
          impactStatus: "pending",
        }),
      ]),
    );

    const current = history.find((row) => row.decisionId === second.decisionId)!;
    await alice.mutation(api.decisions.assessImpact, {
      impactId: current.impactId,
      status: "rework_required",
      note: "Add Canadian compliance and support work.",
    });
    await expect(
      t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId }),
    ).rejects.toThrow(/launch.region v2/i);
    await alice.mutation(api.decisions.assessImpact, {
      impactId: current.impactId,
      status: "resolved",
      note: "Canadian requirements added.",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId });
  });

  it("refuses cross-list impacts and hides decisions from outsiders", async () => {
    const { alice, mallory, listId, taskId, otherTaskId } = await setup();
    await expect(
      alice.mutation(api.decisions.create, {
        listId,
        key: "security.boundary",
        title: "Security boundary",
        statement: "Keep launch data isolated.",
        rationale: "Least privilege.",
        taskIds: [taskId, otherTaskId],
      }),
    ).rejects.toThrow(/same list/i);

    await alice.mutation(api.decisions.create, {
      listId,
      key: "security.boundary",
      title: "Security boundary",
      statement: "Keep launch data isolated.",
      rationale: "Least privilege.",
      taskIds: [taskId],
    });
    expect(
      await mallory.query(api.decisions.listForTask, { taskId }),
    ).toEqual([]);
  });

  it("cleans impacts with tasks and decisions with lists", async () => {
    const { t, alice, listId, taskId } = await setup();
    await alice.mutation(api.decisions.create, {
      listId,
      key: "cleanup.policy",
      title: "Cleanup policy",
      statement: "Delete policy artifacts with their scope.",
      rationale: "Avoid orphaned control-plane records.",
      taskIds: [taskId],
    });
    await alice.mutation(api.tasks.remove, { taskId });
    expect(
      await t.run((ctx) => ctx.db.query("decisionImpacts").collect()),
    ).toEqual([]);
    await alice.mutation(api.lists.remove, { listId });
    expect(await t.run((ctx) => ctx.db.query("decisions").collect())).toEqual(
      [],
    );
  });
});
