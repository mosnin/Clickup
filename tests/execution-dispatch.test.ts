import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "dispatch_owner", email: "owner@example.com" };
const PLANNER_KEY = "cua_dispatch_planner";
const BACKEND_KEY = "cua_dispatch_backend";
const QA_KEY = "cua_dispatch_qa";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      name: "Owner",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Dispatch Co",
      slug: "dispatch-co",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    const plannerId = await ctx.db.insert("agents", {
      name: "Planner",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      capabilities: ["project-management"],
      maxConcurrentTasks: 2,
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    const backendId = await ctx.db.insert("agents", {
      name: "Backend",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      capabilities: ["typescript", "backend"],
      maxConcurrentTasks: 2,
      notifyUrl: "https://runtime.example.com/wake",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    const qaId = await ctx.db.insert("agents", {
      name: "QA",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      capabilities: ["quality-assurance"],
      maxConcurrentTasks: 1,
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const [agentId, key] of [
      [plannerId, PLANNER_KEY],
      [backendId, BACKEND_KEY],
      [qaId, QA_KEY],
    ] as const) {
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(key),
        keyPrefix: key.slice(0, 12),
        createdAt: Date.now(),
      });
    }
    return { workspaceId, spaceId, plannerId, backendId, qaId };
  });
  return { t, owner: t.withIdentity(OWNER), ...ids };
}

function planArgs(
  spaceId: Id<"spaces">,
  backendId: Id<"agents">,
  qaId: Id<"agents">,
) {
  return {
    apiKey: PLANNER_KEY,
    idempotencyKey: "dispatch-plan-v1",
    spaceId,
    name: "Capability dispatch",
    objective: "Release only dependency-ready work to compatible agents.",
    sourceContext:
      "Build the backend first, then run two independent QA checks. Documentation needs a specialist who has not joined yet.",
    successCriteria: ["No incompatible agent can claim specialized work."],
    assumptions: [],
    openQuestions: ["Which production region should the rollout use?"],
    phases: [
      { ref: "build", name: "Build" },
      { ref: "verify", name: "Verify" },
    ],
    projects: [
      {
        ref: "platform",
        name: "Platform",
        phaseRef: "build",
        tasks: [
          {
            ref: "schema",
            title: "Build schema",
            requiredCapabilities: ["typescript"],
            assigneeIds: [backendId],
          },
          {
            ref: "docs",
            title: "Write operator docs",
            requiredCapabilities: ["documentation"],
          },
        ],
      },
      {
        ref: "verification",
        name: "Verification",
        phaseRef: "verify",
        tasks: [
          {
            ref: "test",
            title: "Run acceptance tests",
            requiredCapabilities: ["quality-assurance"],
            dependsOn: ["platform.schema"],
            assigneeIds: [qaId],
          },
          {
            ref: "audit",
            title: "Audit release evidence",
            requiredCapabilities: ["quality-assurance"],
            dependsOn: ["platform.schema"],
            assigneeIds: [qaId],
          },
        ],
      },
    ],
  };
}

async function acknowledgePlanTask(
  t: ReturnType<typeof convexTest>,
  apiKey: string,
  taskId: Id<"tasks">,
) {
  const task = await t.query(api.agentApi.getTask, { apiKey, taskId });
  await t.mutation(api.agentApi.acknowledgeTaskContext, {
    apiKey,
    taskId,
    packets: task.contextPackets.map((packet) => ({
      packetId: packet.packetId,
      version: packet.version,
    })),
  });
}

async function approvePlan(
  t: ReturnType<typeof convexTest>,
  planId: Id<"executionPlans">,
) {
  await t.withIdentity(OWNER).mutation(api.executionPlans.review, {
    planId,
    decision: "approved",
    note: "Reviewed dependencies, assignments, risks, and dispatch scope.",
  });
}

describe("capability-aware execution dispatch", () => {
  it("limits immutable plan authorization to owners and admins", async () => {
    const { t, owner, workspaceId, spaceId, backendId, qaId } =
      await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    const memberIdentity = {
      subject: "dispatch_member",
      email: "member@example.com",
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: memberIdentity.subject,
        email: memberIdentity.email,
        name: "Member",
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: memberIdentity.subject,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    await expect(
      t.withIdentity(memberIdentity).mutation(api.executionPlans.review, {
        planId: plan.planId,
        decision: "approved",
        note: "I checked the proposed task graph and want to dispatch it.",
      }),
    ).rejects.toThrow(/owners and admins/i);

    await owner.mutation(api.executionPlans.review, {
      planId: plan.planId,
      decision: "approved",
      note: "Dependencies and agent assignments are safe to dispatch.",
    });
    await owner.mutation(api.executionPlans.review, {
      planId: plan.planId,
      decision: "rejected",
      note: "The production-region question must be resolved before continuing.",
    });
    const reviewed = await owner.query(api.executionPlans.get, {
      planId: plan.planId,
    });
    expect(reviewed).toMatchObject({
      reviewStatus: "rejected",
      canReview: true,
      reviews: [
        { decision: "rejected", reviewerName: "Owner" },
        { decision: "approved", reviewerName: "Owner" },
      ],
    });
    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "wave-rejected",
        planId: plan.planId,
        openQuestionDisposition:
          "The current decision explicitly bounds this to local work only.",
      }),
    ).rejects.toThrow(/rejected by a workspace reviewer/i);
  });

  it("gates uncertainty, dispatches one safe wave, and replays idempotently", async () => {
    const { t, owner, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    expect(plan.reviewStatus).toBe("pending");
    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "wave-pending",
        planId: plan.planId,
        openQuestionDisposition:
          "Region remains deferred; this wave is bounded to schema work.",
      }),
    ).rejects.toThrow(/awaiting owner or admin approval/i);
    await approvePlan(t, plan.planId);

    const readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations).toMatchObject([
      {
        taskRef: "platform.schema",
        recommendedAgentId: backendId,
        requiredCapabilities: ["typescript"],
        notifyConfigured: true,
      },
    ]);
    expect(readiness.skipped).toEqual(
      expect.arrayContaining([
        { taskRef: "platform.docs", reason: "capability_gap" },
        { taskRef: "verification.test", reason: "dependency_blocked" },
        { taskRef: "verification.audit", reason: "dependency_blocked" },
      ]),
    );
    expect(readiness.requiresOpenQuestionDisposition).toBe(true);

    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "wave-build-v1",
        planId: plan.planId,
      }),
    ).rejects.toThrow(/openQuestionDisposition/i);

    const args = {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-build-v1",
      planId: plan.planId,
      openQuestionDisposition:
        "Region remains deferred; this wave is bounded to schema work with no deployment.",
    };
    const wave = await t.mutation(
      api.agentApi.dispatchExecutionWave,
      args,
    );
    expect(wave).toMatchObject({
      replayed: false,
      assignments: [
        {
          taskRef: "platform.schema",
          agentId: backendId,
          delivery: "notify_url",
        },
      ],
    });
    const replay = await t.mutation(
      api.agentApi.dispatchExecutionWave,
      args,
    );
    expect(replay.waveId).toBe(wave.waveId);
    expect(replay.replayed).toBe(true);
    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        ...args,
        maxTasks: 2,
      }),
    ).rejects.toThrow(/different wave/i);

    const humanReadiness = await owner.query(
      api.executionDispatch.readiness,
      { planId: plan.planId },
    );
    expect(humanReadiness?.waves[0]).toMatchObject({
      waveId: wave.waveId,
      assignmentCount: 1,
    });
  });

  it("releases the next dependency wave while respecting concurrency", async () => {
    const { t, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    await approvePlan(t, plan.planId);
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-build",
      planId: plan.planId,
      openQuestionDisposition:
        "Deferred region does not affect local schema implementation.",
    });

    const schemaTask = plan.tasks.find(
      (task) => task.ref === "platform.schema",
    )!;
    await t.run(async (ctx) => {
      const task = await ctx.db.get(schemaTask.taskId);
      const statuses = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", task!.listId))
        .collect();
      const complete = statuses.find(
        (status) => status.category === "complete",
      )!;
      await ctx.db.patch(task!._id, {
        statusId: complete._id,
        completedAt: Date.now(),
      });
    });

    const readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations).toMatchObject([
      {
        taskRef: "verification.test",
        recommendedAgentId: qaId,
      },
    ]);
    expect(readiness.skipped).toEqual(
      expect.arrayContaining([
        { taskRef: "verification.audit", reason: "capacity_exhausted" },
        { taskRef: "platform.docs", reason: "capability_gap" },
      ]),
    );

    const wave = await t.mutation(
      api.agentApi.dispatchExecutionWave,
      {
        apiKey: PLANNER_KEY,
        idempotencyKey: "wave-verify",
        planId: plan.planId,
        maxTasks: 10,
        openQuestionDisposition:
          "Verification is local and cannot choose or change a production region.",
      },
    );
    expect(wave.assignments).toMatchObject([
      {
        taskRef: "verification.test",
        agentId: qaId,
        delivery: "poll_required",
      },
    ]);
  });

  it("refuses incompatible assignment and claim contracts", async () => {
    const { t, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    const schemaTask = plan.tasks.find(
      (task) => task.ref === "platform.schema",
    )!;
    await acknowledgePlanTask(t, BACKEND_KEY, schemaTask.taskId);

    await expect(
      t.mutation(api.agentApi.claimTask, {
        apiKey: QA_KEY,
        taskId: schemaTask.taskId,
      }),
    ).rejects.toThrow(/requires capabilities/i);

    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey: PLANNER_KEY,
        taskId: schemaTask.taskId,
        assigneeIds: [qaId],
      }),
    ).rejects.toThrow(/missing required capabilities/i);

    const backendQueue = await t.query(api.agentApi.nextTask, {
      apiKey: BACKEND_KEY,
      includeUnassigned: true,
      limit: 10,
    });
    expect(backendQueue.map((task) => task.taskId)).toContain(
      schemaTask.taskId,
    );
    const qaQueue = await t.query(api.agentApi.nextTask, {
      apiKey: QA_KEY,
      includeUnassigned: true,
      limit: 10,
    });
    expect(qaQueue.map((task) => task.taskId)).not.toContain(
      schemaTask.taskId,
    );
  });

  it("recovers expired dispatch leases and excludes paused workers", async () => {
    const { t, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    await approvePlan(t, plan.planId);
    const wave = await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-expiry",
      planId: plan.planId,
      openQuestionDisposition:
        "This implementation-only wave cannot affect the rollout region.",
    });

    let readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations).toHaveLength(0);
    expect(readiness.skipped).toContainEqual({
      taskRef: "platform.schema",
      reason: "assignment_dispatched",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(wave.waveId, {
        createdAt: Date.now() - 31 * 60 * 1000,
      });
      const assignments = await ctx.db
        .query("executionAssignments")
        .withIndex("by_wave", (q) => q.eq("waveId", wave.waveId))
        .collect();
      for (const assignment of assignments) {
        await ctx.db.patch(assignment._id, {
          dispatchedAt: Date.now() - 31 * 60 * 1000,
        });
      }
    });
    readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations[0]).toMatchObject({
      taskRef: "platform.schema",
      recommendedAgentId: backendId,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(backendId, { status: "paused" });
      await ctx.db.patch(qaId, { status: "paused" });
    });
    readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations).toHaveLength(0);
    expect(readiness.skipped).toEqual(
      expect.arrayContaining([
        { taskRef: "platform.schema", reason: "capability_gap" },
      ]),
    );
  });

  it("records dispatch through claim, run, evidence, and terminal replay", async () => {
    const { t, owner, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    await approvePlan(t, plan.planId);
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-ledger-success",
      planId: plan.planId,
      openQuestionDisposition:
        "This bounded schema implementation does not choose a deployment region.",
    });
    const schemaTask = plan.tasks.find(
      (task) => task.ref === "platform.schema",
    )!;
    await acknowledgePlanTask(t, BACKEND_KEY, schemaTask.taskId);

    await expect(
      t.mutation(api.agentApi.startRun, {
        apiKey: BACKEND_KEY,
        taskId: schemaTask.taskId,
        title: "Implement schema",
      }),
    ).rejects.toThrow(/claim this task/i);

    await t.mutation(api.agentApi.claimTask, {
      apiKey: BACKEND_KEY,
      taskId: schemaTask.taskId,
    });
    let control = await owner.query(api.executionDispatch.control, {
      planId: plan.planId,
    });
    expect(control?.counts.claimed).toBe(1);
    expect(control?.assignments[0]).toMatchObject({
      taskRef: "platform.schema",
      agentId: backendId,
      status: "claimed",
      attempt: 1,
    });

    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey: BACKEND_KEY,
      taskId: schemaTask.taskId,
      title: "Implement schema",
    });
    await expect(
      t.mutation(api.agentApi.startRun, {
        apiKey: BACKEND_KEY,
        taskId: schemaTask.taskId,
        title: "Duplicate session",
      }),
    ).rejects.toThrow(/already active/i);
    await t.mutation(api.agentApi.heartbeat, {
      apiKey: BACKEND_KEY,
      currentTaskId: schemaTask.taskId,
      statusText: "Writing migrations",
    });

    control = await owner.query(api.executionDispatch.control, {
      planId: plan.planId,
    });
    expect(control?.counts.running).toBe(1);
    expect(control?.assignments[0]).toMatchObject({
      status: "running",
      runId,
    });
    expect(control?.assignments[0].lastHeartbeatAt).toEqual(
      expect.any(Number),
    );

    const finishArgs = {
      apiKey: BACKEND_KEY,
      runId,
      status: "succeeded" as const,
      summary: "Schema migration and validation complete.",
      links: ["https://github.com/example/repo/pull/1"],
      tokensUsed: 1200,
      costUsd: 0.42,
    };
    await expect(
      t.mutation(api.agentApi.finishRun, finishArgs),
    ).resolves.toMatchObject({ status: "succeeded", replayed: false });
    await expect(
      t.mutation(api.agentApi.finishRun, finishArgs),
    ).resolves.toMatchObject({ status: "succeeded", replayed: true });
    await expect(
      t.mutation(api.agentApi.finishRun, {
        ...finishArgs,
        status: "failed",
      }),
    ).rejects.toThrow(/terminal outcomes cannot be changed/i);

    const agentControl = await t.query(
      api.agentApi.getExecutionControl,
      { apiKey: BACKEND_KEY, planId: plan.planId },
    );
    expect(agentControl.counts.succeeded).toBe(1);
    expect(agentControl.assignments[0]).toMatchObject({
      status: "succeeded",
      summary: "Schema migration and validation complete.",
      links: ["https://github.com/example/repo/pull/1"],
      retryable: false,
    });
  });

  it("makes failed work immediately retryable and validates run evidence", async () => {
    const { t, spaceId, backendId, qaId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    await approvePlan(t, plan.planId);
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-ledger-failure",
      planId: plan.planId,
      openQuestionDisposition:
        "This bounded schema implementation does not choose a deployment region.",
    });
    const schemaTask = plan.tasks.find(
      (task) => task.ref === "platform.schema",
    )!;
    await acknowledgePlanTask(t, BACKEND_KEY, schemaTask.taskId);
    await t.mutation(api.agentApi.claimTask, {
      apiKey: BACKEND_KEY,
      taskId: schemaTask.taskId,
    });
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey: BACKEND_KEY,
      taskId: schemaTask.taskId,
      title: "Attempt schema",
    });
    await expect(
      t.mutation(api.agentApi.finishRun, {
        apiKey: BACKEND_KEY,
        runId,
        status: "failed",
        links: ["file:///tmp/log.txt"],
      }),
    ).rejects.toThrow(/http or https/i);
    await expect(
      t.mutation(api.agentApi.finishRun, {
        apiKey: BACKEND_KEY,
        runId,
        status: "failed",
        costUsd: -1,
      }),
    ).rejects.toThrow(/non-negative/i);
    await t.mutation(api.agentApi.finishRun, {
      apiKey: BACKEND_KEY,
      runId,
      status: "failed",
      error: "Migration lock could not be acquired.",
      links: ["https://logs.example.com/run/1"],
    });

    const claim = await t.run(async (ctx) => {
      const task = await ctx.db.get(schemaTask.taskId);
      return task?.claimedByActorId;
    });
    expect(claim).toBeNull();
    const readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations[0]).toMatchObject({
      taskRef: "platform.schema",
      recommendedAgentId: backendId,
    });
    const control = await t.query(api.agentApi.getExecutionControl, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(control.assignments[0]).toMatchObject({
      status: "failed",
      retryable: true,
      error: "Migration lock could not be acquired.",
    });
  });

  it("keeps private execution control inaccessible to outsiders", async () => {
    const { t, spaceId, backendId, qaId, workspaceId } = await setup();
    const plan = await t.mutation(
      api.agentApi.createExecutionPlan,
      planArgs(spaceId, backendId, qaId),
    );
    const outsider = { subject: "dispatch_outsider", email: "other@example.com" };
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: outsider.subject,
        email: outsider.email,
        name: "Outsider",
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: outsider.subject,
        role: "member",
        joinedAt: Date.now(),
      });
      await ctx.db.patch(spaceId, {
        private: true,
        memberClerkIds: [],
      });
    });
    await expect(
      t.withIdentity(outsider).query(api.executionDispatch.control, {
        planId: plan.planId,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});
