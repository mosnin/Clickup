import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
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
  it("delivers a signed durable wake and records the receipt", async () => {
    const { t, spaceId, backendId, qaId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(backendId, {
        notifyUrl: "https://runtime.example.com/wake",
        notifySecret: "dispatch-secret",
      });
    });
    vi.useFakeTimers();
    let delivery: Doc<"agentPingDeliveries"> | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      // Plan compilation may have queued the ordinary task.assigned ping
      // before this test freezes timers. Only task.ready is the durable
      // execution delivery under test.
      if (!headers.get("X-Ping-Delivery")) {
        return new Response(null, { status: 204 });
      }
      expect(headers.get("X-Ping-Delivery")).toBe(delivery!._id);
      expect(headers.get("X-Ping-Signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        deliveryId: delivery!._id,
        type: "task.ready",
        attempt: 1,
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const plan = await t.mutation(
        api.agentApi.createExecutionPlan,
        planArgs(spaceId, backendId, qaId),
      );
      await approvePlan(t, plan.planId);
      await t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "wave-signed-delivery",
        planId: plan.planId,
        openQuestionDisposition:
          "Production region remains deferred; this wake covers local schema work only.",
      });
      delivery = await t.run(async (ctx) => {
        return await ctx.db
          .query("agentPingDeliveries")
          .withIndex("by_agent", (q) => q.eq("agentId", backendId))
          .unique();
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
    expect(
      fetchMock.mock.calls.filter(([, init]) =>
        new Headers(init?.headers).has("X-Ping-Delivery"),
      ),
    ).toHaveLength(1);
    expect(
      await t.run(async (ctx) =>
        await ctx.db.get(delivery!._id),
      ),
    ).toMatchObject({
      status: "delivered",
      attempts: 1,
      responseStatus: 204,
    });
    const failedDeliveryId = await t.run(async (ctx) => {
      return await ctx.db.insert("agentPingDeliveries", {
        workspaceId: delivery!.workspaceId,
        executionAssignmentId: delivery!.executionAssignmentId,
        agentId: delivery!.agentId,
        taskId: delivery!.taskId,
        type: "task.ready",
        payload: {},
        status: "pending",
        attempts: 3,
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.agentPingDeliveries._recordResult, {
      deliveryId: failedDeliveryId,
      ok: false,
      error: "HTTP 503",
      responseStatus: 503,
      final: true,
    });
    expect(
      await t.run(async (ctx) => await ctx.db.get(failedDeliveryId)),
    ).toMatchObject({
      status: "failed",
      attempts: 4,
      responseStatus: 503,
      lastError: "HTTP 503",
    });
  });

  it("runs clean plans autonomously inside versioned owner limits", async () => {
    const { t, owner, workspaceId, spaceId, backendId, qaId } =
      await setup();
    const policy = await owner.mutation(api.executionPolicy.update, {
      workspaceId,
      mode: "bounded_autonomous",
      maxPlanTasks: 4,
      maxTasksPerWave: 1,
      dailyTaskLimit: 2,
    });
    expect(policy).toMatchObject({
      mode: "bounded_autonomous",
      version: 1,
    });
    const adminIdentity = {
      subject: "policy_admin",
      email: "policy-admin@example.com",
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: adminIdentity.subject,
        email: adminIdentity.email,
        name: "Policy Admin",
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: adminIdentity.subject,
        role: "admin",
        joinedAt: Date.now(),
      });
    });
    await expect(
      t.withIdentity(adminIdentity).mutation(api.executionPolicy.update, {
        workspaceId,
        mode: "supervised",
        maxPlanTasks: 4,
        maxTasksPerWave: 1,
        dailyTaskLimit: 2,
      }),
    ).rejects.toThrow(/Only workspace owners/i);
    await expect(
      t.withIdentity({
        subject: "not_a_member",
        email: "nobody@example.com",
      }).mutation(api.executionPolicy.update, {
        workspaceId,
        mode: "supervised",
        maxPlanTasks: 4,
        maxTasksPerWave: 1,
        dailyTaskLimit: 2,
      }),
    ).rejects.toThrow(/Forbidden/i);

    const cleanArgs = {
      ...planArgs(spaceId, backendId, qaId),
      idempotencyKey: "autonomous-plan-v1",
      openQuestions: [],
    };
    const first = await t.mutation(
      api.agentApi.createExecutionPlan,
      cleanArgs,
    );
    expect(first).toMatchObject({
      reviewStatus: "approved",
      authorizationSource: "workspace_policy",
      authorizationPolicyVersion: 1,
    });
    const agentPolicy = await t.query(api.agentApi.getExecutionPolicy, {
      apiKey: PLANNER_KEY,
    });
    expect(agentPolicy).toMatchObject({
      mode: "bounded_autonomous",
      maxPlanTasks: 4,
      maxTasksPerWave: 1,
      dailyTaskLimit: 2,
    });
    let readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: first.planId,
    });
    expect(readiness).toMatchObject({
      dispatchAuthorized: true,
      policyCapacityRemaining: 2,
      authorization: { source: "workspace_policy" },
    });
    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "autonomous-too-wide",
        planId: first.planId,
        maxTasks: 2,
      }),
    ).rejects.toThrow(/at most 1 tasks per wave/i);
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "autonomous-wave-1",
      planId: first.planId,
      maxTasks: 1,
    });

    const unsafe = await t.mutation(
      api.agentApi.createExecutionPlan,
      {
        ...cleanArgs,
        idempotencyKey: "autonomous-open-question",
        openQuestions: ["Which production region is authorized?"],
      },
    );
    expect(unsafe).toMatchObject({
      reviewStatus: "pending",
      authorizationSource: "none",
    });
    expect(unsafe.authorizationReason).toMatch(/open questions/i);
    const approvalGated = await t.mutation(
      api.agentApi.createExecutionPlan,
      {
        ...cleanArgs,
        idempotencyKey: "autonomous-approval-gated",
        projects: cleanArgs.projects.map((project, projectIndex) => ({
          ...project,
          tasks: project.tasks.map((task, taskIndex) => ({
            ...task,
            requiresApproval:
              projectIndex === 0 && taskIndex === 0
                ? true
                : undefined,
          })),
        })),
      },
    );
    expect(approvalGated.reviewStatus).toBe("pending");
    expect(approvalGated.authorizationReason).toMatch(
      /approval-gated tasks/i,
    );

    const policyV2 = await owner.mutation(api.executionPolicy.update, {
      workspaceId,
      mode: "bounded_autonomous",
      maxPlanTasks: 4,
      maxTasksPerWave: 1,
      dailyTaskLimit: 2,
    });
    expect(policyV2.version).toBe(2);
    readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: first.planId,
    });
    expect(readiness.dispatchAuthorized).toBe(false);
    expect(readiness.authorization.reason).toMatch(/limits changed/i);
    await expect(
      t.mutation(api.agentApi.dispatchExecutionWave, {
        apiKey: PLANNER_KEY,
        idempotencyKey: "stale-policy-wave",
        planId: first.planId,
      }),
    ).rejects.toThrow(/limits changed/i);
    await approvePlan(t, first.planId);
    readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: first.planId,
    });
    expect(readiness).toMatchObject({
      dispatchAuthorized: true,
      authorization: { source: "human_review" },
      policyCapacityRemaining: 1,
    });

    const second = await t.mutation(
      api.agentApi.createExecutionPlan,
      {
        ...cleanArgs,
        idempotencyKey: "autonomous-plan-v2",
      },
    );
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "autonomous-wave-2",
      planId: second.planId,
    });
    const third = await t.mutation(
      api.agentApi.createExecutionPlan,
      {
        ...cleanArgs,
        idempotencyKey: "autonomous-plan-v2-capacity",
      },
    );
    const capped = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: third.planId,
    });
    expect(capped.policyCapacityRemaining).toBe(0);
    expect(capped.recommendations).toHaveLength(0);
    expect(capped.skipped).toEqual(
      expect.arrayContaining([
        { taskRef: "platform.schema", reason: "policy_limit" },
      ]),
    );
  });

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
        notifyConfigured: false,
        contextPacketCount: 1,
      },
    ]);
    expect(readiness.recommendations[0].estimatedContextTokens).toBeGreaterThan(
      0,
    );
    expect(
      readiness.recommendations[0].contextVersionFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(readiness.recommendations[0].contextPackets).toMatchObject([
      { version: 1 },
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
          delivery: "poll_required",
          contextPacketCount: 1,
        },
      ],
    });
    expect(wave.assignments[0].estimatedContextTokens).toBeGreaterThan(0);
    expect(wave.assignments[0].contextVersionFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
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

    await t.mutation(api.agentApi.reviseExecutionPlanContext, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
      idempotencyKey: "wave-build-context-v2",
      changeSummary: "Schema validation now requires deterministic fixtures.",
      sourceAddendum:
        "The owner confirmed that every schema validation run must use deterministic fixtures.",
    });
    const control = await t.query(api.agentApi.getExecutionControl, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(control.assignments[0]).toMatchObject({
      assignmentId: expect.any(String),
      contextPacketCount: 1,
      currentContextPacketCount: 1,
      contextDrifted: true,
      deliveryStatus: "poll_required",
      deliveryAttempts: 0,
    });
    expect(
      control.assignments[0].currentContextVersionFingerprint,
    ).not.toBe(control.assignments[0].contextVersionFingerprint);

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
          status: "claimed",
          dispatchedAt: Date.now() - 31 * 60 * 1000,
          claimedAt: Date.now() - 31 * 60 * 1000,
        });
        await ctx.db.patch(assignment.taskId, {
          claimedByActorId: assignment.agentId,
          claimedAt: Date.now() - 31 * 60 * 1000,
        });
      }
    });
    let control = await t.query(api.agentApi.getExecutionControl, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(control).toMatchObject({
      staleCount: 1,
      counts: { claimed: 0, abandoned: 0 },
    });
    expect(control.assignments[0]).toMatchObject({
      status: "stale",
      recordedStatus: "claimed",
      stale: true,
      retryable: true,
    });

    readiness = await t.query(api.agentApi.getExecutionReadiness, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(readiness.recommendations).toHaveLength(0);
    expect(readiness.skipped).toContainEqual({
      taskRef: "platform.schema",
      reason: "already_claimed",
    });

    const recovery = await t.mutation(
      api.agentApi.reconcileExecutionPlan,
      {
        apiKey: PLANNER_KEY,
        planId: plan.planId,
      },
    );
    expect(recovery).toMatchObject({
      recoveredAssignmentCount: 1,
      releasedClaimCount: 1,
      truncated: false,
    });
    await expect(
      t.mutation(api.agentApi.reconcileExecutionPlan, {
        apiKey: PLANNER_KEY,
        planId: plan.planId,
      }),
    ).resolves.toMatchObject({
      recoveredAssignmentCount: 0,
      releasedClaimCount: 0,
    });
    const releasedClaim = await t.run(async (ctx) => {
      const assignment = await ctx.db
        .query("executionAssignments")
        .withIndex("by_wave", (q) => q.eq("waveId", wave.waveId))
        .unique();
      const task = assignment
        ? await ctx.db.get(assignment.taskId)
        : null;
      return {
        assignmentStatus: assignment?.status,
        error: assignment?.error,
        claimedByActorId: task?.claimedByActorId,
      };
    });
    expect(releasedClaim).toMatchObject({
      assignmentStatus: "abandoned",
      error: expect.stringMatching(/without an execution heartbeat/i),
    });
    expect(releasedClaim.claimedByActorId).toBeUndefined();
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

    await t.run(async (ctx) => {
      await ctx.db.patch(backendId, { status: "active" });
    });
    await t.mutation(api.agentApi.dispatchExecutionWave, {
      apiKey: PLANNER_KEY,
      idempotencyKey: "wave-expiry-retry",
      planId: plan.planId,
      openQuestionDisposition:
        "This implementation-only retry still cannot affect the rollout region.",
    });
    control = await t.query(api.agentApi.getExecutionControl, {
      apiKey: PLANNER_KEY,
      planId: plan.planId,
    });
    expect(control).toMatchObject({
      staleCount: 0,
      counts: { dispatched: 1, abandoned: 1 },
    });
    expect(control.assignments[0]).toMatchObject({
      status: "dispatched",
      recordedStatus: "dispatched",
      attempt: 2,
      stale: false,
    });
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
