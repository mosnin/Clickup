import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

// Agent-experience audit coverage: the whoami governance mirror,
// self-correcting refusal messages, roadmap access over the agent API,
// getTask enrichment (list name + attachments), and list-read payload
// discipline — run against convex-test's in-memory backend.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

// Alice's personal space with one list + statuses, and an agent with a
// usable API key (same scaffold as agent-rules.test.ts).
async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);

  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: "alice@example.com",
      name: "Alice",
    });
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

// A workspace-scoped agent with a list and a roadmap (for the roadmap
// round-trip).
async function setupWorkspace() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
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
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const roadmapId = await ctx.db.insert("roadmaps", {
      workspaceId,
      name: "2026",
      phases: [
        { id: "ph_now", name: "Now" },
        { id: "ph_next", name: "Next" },
      ],
      position: 0,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Planner",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_planner";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, listId, roadmapId, agentId, apiKey };
  });
  return { t, ...ids };
}

describe("whoami governance mirror", () => {
  it("returns role, limits, usage, billing, and first steps", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();

    // One write so the usage counter has something to mirror.
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Warm-up",
    });

    const me = await t.query(api.agentApi.whoami, { apiKey });
    expect(me.name).toBe("Scout");
    expect(me.role).toBe("member");
    expect(me.allowedLists).toBeNull(); // unrestricted
    expect(me.dailyActionLimit).toBe(2000);
    expect(me.actionsUsedToday).toBe(1);
    expect(me.actionsRemainingToday).toBe(1999);
    expect(me.burstLimitPerMinute).toBe(60);
    expect(me.billing.meteringEnabled).toBe(false);
    expect(me.billing.creditsBalance).toBeNull();
    expect(typeof me.billing.creditsPerAction).toBe("number");
    expect(me.firstSteps).toContain("collaboration-protocol");
    expect(me.firstSteps).toContain("next_task");

    // Restricting the agent surfaces the allow-list with names.
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });
    const restricted = await t.query(api.agentApi.whoami, { apiKey });
    expect(restricted.allowedLists).toEqual([{ listId, name: "Tasks" }]);
  });
});

describe("transport presence", () => {
  it("marks an authenticated MCP connection online and emits the first connection once", async () => {
    const { t, agentId, apiKey } = await setup();
    await t.mutation(api.agentApi.connect, { apiKey });
    const first = await t.run(async (ctx) => ({
      agent: await ctx.db.get(agentId),
      events: await ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "agent.connected"))
        .collect(),
    }));
    expect(first.agent?.lastSeenAt).toEqual(expect.any(Number));
    expect(first.events).toHaveLength(1);

    await t.mutation(api.agentApi.connect, { apiKey });
    const events = await t.run((ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "agent.connected"))
        .collect(),
    );
    expect(events).toHaveLength(1);
  });
});

describe("linked goals over the agent API", () => {
  it("refuses manual progress on a linked goal and mirrors the human overlay", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const goalId = await t.run(async (ctx) =>
      ctx.db.insert("goals", {
        parentType: "user",
        parentId: ALICE.subject,
        title: "Ship the project",
        targetType: "number",
        targetValue: 3,
        currentValue: 0,
        sourceListId: listId,
        status: "open",
        ownerClerkId: ALICE.subject,
        createdAt: Date.now(),
      }),
    );

    const a = await alice.mutation(api.tasks.create, { listId, title: "A" });
    await alice.mutation(api.tasks.create, { listId, title: "B" });
    await alice.mutation(api.tasks.create, { listId, title: "C" });
    await alice.mutation(api.tasks.update, { taskId: a, statusId: doneStatus });

    await expect(
      t.mutation(api.agentApi.setGoalProgress, {
        apiKey,
        goalId,
        currentValue: 2,
      }),
    ).rejects.toThrow(/tracks a project automatically/);

    const agentGoals = await t.query(api.agentApi.listGoals, { apiKey });
    const humanGoals = await alice.query(api.goals.listForParent, {
      parentType: "user",
      parentId: ALICE.subject,
    });
    const agentGoal = agentGoals.find((g) => g.goalId === goalId)!;
    const humanGoal = humanGoals.find((g) => g._id === goalId)!;
    expect(agentGoal.linked).toBe(true);
    expect(agentGoal.currentValue).toBe(1);
    expect(agentGoal.currentValue).toBe(humanGoal.currentValue);
    expect(agentGoal.status).toBe(humanGoal.status);
  });
});

describe("self-correcting refusals", () => {
  it("claim conflicts name the holder and when the claim expires", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Contested work",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });

    await expect(
      alice.mutation(api.tasks.claim, { taskId }),
    ).rejects.toThrow(/already claimed by Scout/);
    await expect(alice.mutation(api.tasks.claim, { taskId })).rejects.toThrow(
      /expires/,
    );
  });

  it("approval refusals tell agents to call request_approval", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Risky deploy",
      requiresApproval: true,
    });
    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey, taskId }),
    ).rejects.toThrow(/request_approval/);
  });
});

describe("roadmaps over the agent API", () => {
  it("assigns a project to a phase and reads it back", async () => {
    const { t, listId, roadmapId, apiKey } = await setupWorkspace();

    await t.mutation(api.agentApi.assignProjectToPhase, {
      apiKey,
      listId,
      roadmapId,
      phaseId: "ph_next",
    });

    const roadmaps = await t.query(api.agentApi.getRoadmaps, { apiKey });
    expect(roadmaps).toHaveLength(1);
    const rm = roadmaps[0];
    expect(rm.roadmapId).toBe(roadmapId);
    expect(rm.phases.map((p) => p.name)).toEqual(["Now", "Next"]);
    expect(rm.projects).toHaveLength(1);
    expect(rm.projects[0]).toMatchObject({
      listId,
      name: "Launch",
      phaseId: "ph_next",
      position: 0,
      total: 0,
      done: 0,
    });

    // A stale phase id is an error, not a silent drop into phase 1.
    await expect(
      t.mutation(api.agentApi.assignProjectToPhase, {
        apiKey,
        listId,
        roadmapId,
        phaseId: "ph_gone",
      }),
    ).rejects.toThrow(/Phase not found/);

    // Unassign with roadmapId: null.
    await t.mutation(api.agentApi.assignProjectToPhase, {
      apiKey,
      listId,
      roadmapId: null,
    });
    const after = await t.query(api.agentApi.getRoadmaps, { apiKey });
    expect(after[0].projects).toHaveLength(0);
  });

  it("refuses personal-scope agents", async () => {
    const { t, apiKey } = await setup();
    await expect(
      t.query(api.agentApi.getRoadmaps, { apiKey }),
    ).rejects.toThrow(/workspace-scoped/);
  });
});

describe("getTask enrichment", () => {
  it("includes the list name and attachments", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "With attachment",
    });
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["hello world"]));
      await ctx.db.insert("attachments", {
        taskId,
        storageId,
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11,
        uploadedByActorId: ALICE.subject,
        createdAt: Date.now(),
      });
    });

    const task = await t.query(api.agentApi.getTask, { apiKey, taskId });
    expect(task.listName).toBe("Tasks");
    expect(task.attachments).toHaveLength(1);
    const attachment = task.attachments[0];
    expect(attachment.attachmentId).toBeDefined();
    expect(attachment.name).toBe("spec.pdf");
    expect(attachment.size).toBe(11);
    expect(attachment.contentType).toBe("application/pdf");
    // url may be null in some environments — the field must exist either way.
    expect("url" in attachment).toBe(true);
  });
});

describe("list-read payload discipline", () => {
  it("truncates long descriptions in listTasks; getTask returns the full text", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const longDescription = "x".repeat(400);
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Long-winded",
      description: longDescription,
    });

    const rows = await t.query(api.agentApi.listTasks, { apiKey });
    const row = rows.find((r) => r.taskId === taskId)!;
    expect(row.description).toHaveLength(300);
    expect(row.descriptionTruncated).toBe(true);

    const full = await t.query(api.agentApi.getTask, { apiKey, taskId });
    expect(full.description).toBe(longDescription);
  });
});
