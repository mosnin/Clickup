import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice", email: "alice@example.com" };
const MALLORY = { subject: "user_mallory", email: "mallory@example.com" };
const API_KEY = "cua_test_context_agent";

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
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Autonomous company",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const otherListId = await ctx.db.insert("lists", {
      name: "Other project",
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
    const otherStatusId = await ctx.db.insert("listStatuses", {
      listId: otherListId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#22c55e",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    const taskId = await ctx.db.insert("tasks", {
      listId,
      title: "Build orchestration",
      statusId,
      assigneeClerkIds: [],
      createdByClerkId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const otherTaskId = await ctx.db.insert("tasks", {
      listId: otherListId,
      title: "Unrelated",
      statusId: otherStatusId,
      assigneeClerkIds: [],
      createdByClerkId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Planner",
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
    return { listId, otherListId, taskId, otherTaskId, agentId };
  });
  return {
    t,
    alice: t.withIdentity(ALICE),
    mallory: t.withIdentity(MALLORY),
    ...ids,
  };
}

describe("context packets", () => {
  it("creates once, attaches to a task, and travels with get_task", async () => {
    const { alice, taskId, listId } = await setup();
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Product source of truth",
      summary: "The operating brief every agent shares.",
      content: "## Objective\nBuild a coherent autonomous company.",
      taskIds: [taskId],
    });

    const task = await alice.query(api.contextPackets.listForTask, { taskId });
    expect(task).toMatchObject([
      {
        packetId,
        title: "Product source of truth",
        version: 1,
      },
    ]);

    const agentTask = await alice.query(api.agentApi.getTask, {
      apiKey: API_KEY,
      taskId,
    });
    expect(agentTask.contextPackets[0]).toMatchObject({
      packetId,
      content: "## Objective\nBuild a coherent autonomous company.",
      version: 1,
    });
  });

  it("increments versions and agents can detect changed context", async () => {
    const { t, listId, taskId } = await setup();
    const created = await t.mutation(api.agentApi.createContextPacket, {
      apiKey: API_KEY,
      listId,
      title: "Execution contract",
      content: "Decision: use one shared packet.",
      taskIds: [taskId],
    });
    const updated = await t.mutation(api.agentApi.updateContextPacket, {
      apiKey: API_KEY,
      packetId: created.packetId,
      content: "Decision: use one shared, versioned packet.",
    });
    expect(updated.version).toBe(2);

    const packet = await t.query(api.agentApi.getContextPacket, {
      apiKey: API_KEY,
      packetId: created.packetId,
    });
    expect(packet.version).toBe(2);
    expect(packet.content).toContain("versioned");
  });

  it("requires exact current context before claim, run, heartbeat, or completion", async () => {
    const { t, listId, taskId } = await setup();
    const created = await t.mutation(api.agentApi.createContextPacket, {
      apiKey: API_KEY,
      listId,
      title: "Execution contract",
      content: "Ship only after the contract tests pass.",
      taskIds: [taskId],
    });

    const initial = await t.query(api.agentApi.getTask, {
      apiKey: API_KEY,
      taskId,
    });
    expect(initial.contextReadiness).toMatchObject({
      ready: false,
      packets: [{ packetId: created.packetId, state: "unread" }],
    });
    await expect(
      t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId }),
    ).rejects.toThrow(/acknowledgement required/i);
    await expect(
      t.mutation(api.agentApi.startRun, {
        apiKey: API_KEY,
        taskId,
        title: "Premature run",
      }),
    ).rejects.toThrow(/acknowledgement required/i);
    await expect(
      t.mutation(api.agentApi.heartbeat, {
        apiKey: API_KEY,
        currentTaskId: taskId,
      }),
    ).rejects.toThrow(/acknowledgement required/i);

    const acknowledged = await t.mutation(
      api.agentApi.acknowledgeTaskContext,
      {
        apiKey: API_KEY,
        taskId,
        packets: [{ packetId: created.packetId, version: 1 }],
      },
    );
    expect(acknowledged.ready).toBe(true);
    await t.mutation(api.agentApi.claimTask, { apiKey: API_KEY, taskId });
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey: API_KEY,
      taskId,
      title: "Implement with current context",
    });

    await t.mutation(api.agentApi.updateContextPacket, {
      apiKey: API_KEY,
      packetId: created.packetId,
      content: "Ship only after contract and browser tests pass.",
    });
    const stale = await t.query(api.agentApi.getTask, {
      apiKey: API_KEY,
      taskId,
    });
    expect(stale.contextReadiness).toMatchObject({
      ready: false,
      packets: [
        {
          packetId: created.packetId,
          currentVersion: 2,
          acknowledgedVersion: 1,
          state: "stale",
        },
      ],
    });
    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey: API_KEY, taskId }),
    ).rejects.toThrow(/acknowledgement required/i);
    await expect(
      t.mutation(api.agentApi.requestApproval, {
        apiKey: API_KEY,
        taskId,
        note: "Review the implementation.",
      }),
    ).rejects.toThrow(/acknowledgement required/i);
    await expect(
      t.mutation(api.agentApi.finishRun, {
        apiKey: API_KEY,
        runId,
        status: "succeeded",
      }),
    ).rejects.toThrow(/acknowledgement required/i);
    await expect(
      t.mutation(api.agentApi.acknowledgeTaskContext, {
        apiKey: API_KEY,
        taskId,
        packets: [{ packetId: created.packetId, version: 1 }],
      }),
    ).rejects.toThrow(/now v2/i);

    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey: API_KEY,
      taskId,
      packets: [{ packetId: created.packetId, version: 2 }],
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey: API_KEY,
      runId,
      status: "succeeded",
    });
    await t.mutation(api.agentApi.completeTask, { apiKey: API_KEY, taskId });
  });

  it("shows humans which assigned agents are current or stale", async () => {
    const { t, alice, listId, taskId, agentId } = await setup();
    const created = await t.mutation(api.agentApi.createContextPacket, {
      apiKey: API_KEY,
      listId,
      title: "Shared decision log",
      content: "Decision: stage the rollout.",
      taskIds: [taskId],
    });

    const unread = await alice.query(api.contextPackets.readinessForTask, {
      taskId,
    });
    expect(unread[0]).toMatchObject({
      packetId: created.packetId,
      agents: [{ agentId, agentName: "Planner", state: "unread" }],
    });

    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey: API_KEY,
      taskId,
      packets: [{ packetId: created.packetId, version: 1 }],
    });
    expect(
      await alice.query(api.contextPackets.readinessForTask, { taskId }),
    ).toMatchObject([
      {
        agents: [
          {
            agentId,
            acknowledgedVersion: 1,
            state: "current",
          },
        ],
      },
    ]);

    await alice.mutation(api.contextPackets.update, {
      packetId: created.packetId,
      content: "Decision: use a canary rollout.",
    });
    expect(
      await alice.query(api.contextPackets.readinessForTask, { taskId }),
    ).toMatchObject([
      {
        currentVersion: 2,
        agents: [{ agentId, acknowledgedVersion: 1, state: "stale" }],
      },
    ]);
  });

  it("lets agents retire obsolete context and removes every attachment", async () => {
    const { t, listId, taskId } = await setup();
    const created = await t.mutation(api.agentApi.createContextPacket, {
      apiKey: API_KEY,
      listId,
      title: "Temporary launch decision",
      content: "Retire after launch.",
      taskIds: [taskId],
    });

    const result = await t.mutation(api.agentApi.deleteContextPacket, {
      apiKey: API_KEY,
      packetId: created.packetId,
    });
    expect(result).toEqual({ deleted: true, detachedTaskCount: 1 });
    expect(
      await t.query(api.contextPackets.listForTask, { taskId }),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.get(created.packetId)),
    ).toBeNull();
  });

  it("refuses cross-project attachments and foreign human reads", async () => {
    const { t, alice, mallory, listId, taskId, otherTaskId } = await setup();
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Scoped brief",
      content: "Only this project.",
      taskIds: [taskId],
    });

    await expect(
      t.mutation(api.agentApi.attachContextPacket, {
        apiKey: API_KEY,
        packetId,
        taskIds: [otherTaskId],
      }),
    ).rejects.toThrow(/same project/);

    expect(
      await mallory.query(api.contextPackets.listForTask, { taskId }),
    ).toEqual([]);
  });

  it("removes links with tasks and packets with projects", async () => {
    const { t, alice, listId, taskId } = await setup();
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Disposable brief",
      content: "Deleted with its project.",
      taskIds: [taskId],
    });
    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey: API_KEY,
      taskId,
      packets: [{ packetId, version: 1 }],
    });

    await alice.mutation(api.tasks.remove, { taskId });
    const linksAfterTaskDelete = await t.run((ctx) =>
      ctx.db.query("taskContextPackets").collect(),
    );
    expect(linksAfterTaskDelete).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("agentContextReceipts").collect()),
    ).toEqual([]);

    await alice.mutation(api.lists.remove, { listId });
    const packetAfterProjectDelete = await t.run((ctx) =>
      ctx.db.get(packetId),
    );
    expect(packetAfterProjectDelete).toBeNull();
  });
});
