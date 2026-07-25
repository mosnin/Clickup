import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice", email: "alice@example.com" };
const BOB = { subject: "user_bob", email: "bob@example.com" };
const API_KEY = "cua_test_execution_planner";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: ALICE.email,
      name: "Alice",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Autonomous Co",
      slug: "autonomous-co",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ALICE.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("users", {
      clerkId: BOB.subject,
      email: BOB.email,
      name: "Bob",
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: BOB.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "Company",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const plannerId = await ctx.db.insert("agents", {
      name: "Planner",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const workerId = await ctx.db.insert("agents", {
      name: "Builder",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId: plannerId,
      keyHash: sha256Hex(API_KEY),
      keyPrefix: API_KEY.slice(0, 12),
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, plannerId, workerId };
  });
  return {
    t,
    alice: t.withIdentity(ALICE),
    bob: t.withIdentity(BOB),
    ...ids,
  };
}

function planArgs(spaceId: Id<"spaces">, workerId: Id<"agents">) {
  return {
    apiKey: API_KEY,
    idempotencyKey: "conversation-42-revision-1",
    spaceId,
    name: "Agent company launch",
    objective: "Launch a reliable agent-operated product.",
    sourceContext:
      "The company needs an API foundation and a controlled beta launch.",
    successCriteria: [
      "Every critical path has an owner and acceptance criteria.",
      "The beta cannot start before the API contract is complete.",
    ],
    assumptions: ["The existing authentication provider remains in place."],
    openQuestions: ["Who has final launch approval?"],
    phases: [
      { ref: "foundation", name: "Foundation" },
      { ref: "launch", name: "Launch", targetDate: 1_900_000_000_000 },
    ],
    projects: [
      {
        ref: "platform",
        name: "Platform",
        description: "Build the dependable core.",
        phaseRef: "foundation",
        ownerActorId: workerId,
        tasks: [
          {
            ref: "epic",
            title: "Platform foundation",
            milestone: true,
            checklist: [
              { id: "scope", text: "Scope approved", done: false },
            ],
          },
          {
            ref: "schema",
            title: "Create the schema",
            parentRef: "epic",
            assigneeIds: [workerId],
          },
          {
            ref: "api",
            title: "Publish the API contract",
            parentRef: "epic",
            dependsOn: ["schema"],
            assigneeIds: [workerId],
          },
        ],
      },
      {
        ref: "beta",
        name: "Controlled beta",
        phaseRef: "launch",
        projectStatus: "on_track" as const,
        tasks: [
          {
            ref: "invite",
            title: "Invite beta companies",
            dependsOn: ["platform.api"],
            requiresApproval: true,
            assigneeIds: [workerId],
          },
        ],
      },
    ],
  };
}

describe("execution plan compiler", () => {
  it("atomically creates provenance, roadmap, projects, task graph, and context", async () => {
    const { t, alice, workspaceId, spaceId, workerId } = await setup();
    const result = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, workerId),
    );

    expect(result).toMatchObject({
      name: "Agent company launch",
      projectCount: 2,
      taskCount: 4,
      assumptionCount: 1,
      openQuestionCount: 1,
      replayed: false,
    });
    expect(result.projects.map((project) => project.ref)).toEqual([
      "platform",
      "beta",
    ]);
    expect(result.tasks.map((task) => task.ref)).toEqual([
      "platform.epic",
      "platform.schema",
      "platform.api",
      "beta.invite",
    ]);

    const roadmaps = await t.query(api.agentApi.getRoadmaps, {
      apiKey: API_KEY,
    });
    expect(roadmaps[0].phases.map((phase) => phase.name)).toEqual([
      "Foundation",
      "Launch",
    ]);
    expect(roadmaps[0].projects.map((project) => project.name)).toEqual([
      "Platform",
      "Controlled beta",
    ]);

    const byRef = new Map(result.tasks.map((task) => [task.ref, task]));
    const apiTask = await t.run((ctx) =>
      ctx.db.get(byRef.get("platform.api")!.taskId),
    );
    const schemaTask = byRef.get("platform.schema")!;
    expect(apiTask?.blockedByTaskIds).toEqual([schemaTask.taskId]);
    expect(apiTask?.parentTaskId).toBe(byRef.get("platform.epic")!.taskId);
    const inviteTask = await t.run((ctx) =>
      ctx.db.get(byRef.get("beta.invite")!.taskId),
    );
    expect(inviteTask?.blockedByTaskIds).toEqual([
      byRef.get("platform.api")!.taskId,
    ]);
    expect(inviteTask?.requiresApproval).toBe(true);

    const packets = await t.run((ctx) =>
      ctx.db.query("contextPackets").collect(),
    );
    expect(packets).toHaveLength(2);
    expect(packets[0].content).toContain("## Confirmed source context");
    expect(packets[0].content).toContain("Who has final launch approval?");
    const links = await t.run((ctx) =>
      ctx.db.query("taskContextPackets").collect(),
    );
    expect(links).toHaveLength(4);

    const readiness = await alice.query(
      api.contextPackets.readinessForTask,
      { taskId: byRef.get("beta.invite")!.taskId },
    );
    expect(readiness[0].agents).toMatchObject([
      { agentId: workerId, agentName: "Builder", state: "unread" },
    ]);

    const humanPlans = await alice.query(
      api.executionPlans.listForWorkspace,
      { workspaceId },
    );
    expect(humanPlans).toMatchObject([
      {
        planId: result.planId,
        objective: "Launch a reliable agent-operated product.",
        projectCount: 2,
        taskCount: 4,
      },
    ]);
    const humanPlan = await alice.query(api.executionPlans.get, {
      planId: result.planId,
    });
    expect(humanPlan?.sourceContext).toContain("controlled beta launch");
  });

  it("replays the same idempotency key without duplicating artifacts", async () => {
    const { t, spaceId, workerId } = await setup();
    const args = planArgs(spaceId, workerId);
    const first = await t.mutation(api.agentApi.createExecutionPlan, args);
    const replay = await t.mutation(api.agentApi.createExecutionPlan, args);
    expect(replay.planId).toBe(first.planId);
    expect(replay.replayed).toBe(true);
    expect(
      await t.run((ctx) => ctx.db.query("executionPlans").collect()),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("roadmaps").collect()),
    ).toHaveLength(1);

    await expect(
      t.mutation(api.agentApi.createExecutionPlan, {
        ...args,
        objective: "A changed objective needs a new revision.",
      }),
    ).rejects.toThrow(/different plan/i);
  });

  it("rejects cycles and invented assignees without partial creation", async () => {
    const { t, spaceId, workerId } = await setup();
    const cyclic = planArgs(spaceId, workerId);
    (
      cyclic.projects[0].tasks[0] as (typeof cyclic.projects)[number]["tasks"][number] & {
        dependsOn?: string[];
      }
    ).dependsOn = ["api"];
    cyclic.projects[0].tasks[2].dependsOn = ["epic"];
    await expect(
      t.mutation(api.agentApi.createExecutionPlan, cyclic),
    ).rejects.toThrow(/cycle/i);

    const invalidActor = planArgs(spaceId, workerId);
    invalidActor.idempotencyKey = "invented-actor";
    invalidActor.projects[1].tasks[0].assigneeIds = [
      "agent_that_does_not_exist" as Id<"agents">,
    ];
    await expect(
      t.mutation(api.agentApi.createExecutionPlan, invalidActor),
    ).rejects.toThrow(/not a workspace member or agent/i);

    expect(
      await t.run((ctx) => ctx.db.query("executionPlans").collect()),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("roadmaps").collect()),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("lists").collect()),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("tasks").collect()),
    ).toEqual([]);
  });

  it("keeps plans in private spaces hidden from non-members", async () => {
    const { t, alice, bob, workspaceId, spaceId, workerId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(spaceId, {
        private: true,
        createdByClerkId: ALICE.subject,
      });
    });

    const result = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, workerId),
    );

    expect(
      await alice.query(api.executionPlans.listForWorkspace, { workspaceId }),
    ).toHaveLength(1);
    expect(
      await bob.query(api.executionPlans.listForWorkspace, { workspaceId }),
    ).toEqual([]);
    expect(
      await bob.query(api.executionPlans.get, { planId: result.planId }),
    ).toBeNull();
    await expect(
      bob.query(api.executionDispatch.readiness, {
        planId: result.planId,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  it("includes source provenance in owner workspace exports", async () => {
    const { t, alice, workspaceId, spaceId, workerId } = await setup();
    await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, workerId),
    );

    const exported = await alice.query(api.dataExport.exportWorkspace, {
      workspaceId,
    });
    expect(exported.executionPlans).toMatchObject([
      {
        name: "Agent company launch",
        destinationSpace: "Company",
        createdByAgent: "Planner",
        sourceContext:
          "The company needs an API foundation and a controlled beta launch.",
        projects: [
          { ref: "platform", name: "Platform" },
          { ref: "beta", name: "Controlled beta" },
        ],
      },
    ]);
  });
});
