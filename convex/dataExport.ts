import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

// Workspace data export — portability + compliance. An owner/admin can
// export their workspace's structure and task data as a single JSON
// document (downloaded client-side). Secrets are never included: no API
// keys, webhook secrets, or embeddings. Bounded to the workspace's own
// spaces → folders → lists → tasks, plus sprints and agent metadata.

export const exportWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await requireIdentity(ctx);
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError("Workspace not found");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership || membership.role === "member") {
      throw new ConvexError("Only workspace owners and admins can export data");
    }

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    async function tasksForList(listId: Id<"lists">) {
      const statuses = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect();
      const statusName = new Map(statuses.map((s) => [s._id, s.name]));
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect();
      return tasks.map((t) => ({
        title: t.title,
        description: t.description,
        status: statusName.get(t.statusId) ?? "",
        priority: t.priority,
        startDate: t.startDate,
        dueDate: t.dueDate,
        assignees: t.assigneeClerkIds,
        requiredCapabilities: t.requiredCapabilities,
        checklist: t.checklist,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
      }));
    }

    const roadmaps = await ctx.db
      .query("roadmaps")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const roadmapName = new Map(roadmaps.map((r) => [r._id, r.name]));
    const phaseName = new Map(
      roadmaps.flatMap((r) => r.phases.map((p) => [p.id, p.name] as const)),
    );

    async function listNode(list: {
      _id: Id<"lists">;
      name: string;
      roadmapId?: Id<"roadmaps">;
      roadmapPhaseId?: string;
    }) {
      const decisions = await ctx.db
        .query("decisions")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      const decisionHistory = await Promise.all(
        decisions.map(async (decision) => {
          const impacts = await ctx.db
            .query("decisionImpacts")
            .withIndex("by_decision", (q) =>
              q.eq("decisionId", decision._id),
            )
            .collect();
          return {
            key: decision.key,
            version: decision.version,
            title: decision.title,
            statement: decision.statement,
            rationale: decision.rationale,
            status: decision.status,
            createdByActorType: decision.createdByActorType,
            createdByActorId: decision.createdByActorId,
            createdAt: decision.createdAt,
            impacts: await Promise.all(
              impacts.map(async (impact) => ({
                taskTitle:
                  (await ctx.db.get(impact.taskId))?.title ?? "Deleted task",
                status: impact.status,
                note: impact.note,
                assessedByActorType: impact.assessedByActorType,
                assessedByActorId: impact.assessedByActorId,
                assessedAt: impact.assessedAt,
              })),
            ),
          };
        }),
      );
      return {
        name: list.name,
        roadmap: list.roadmapId ? roadmapName.get(list.roadmapId) : undefined,
        roadmapPhase: list.roadmapPhaseId
          ? phaseName.get(list.roadmapPhaseId)
          : undefined,
        decisions: decisionHistory.sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
        tasks: await tasksForList(list._id),
      };
    }

    const spaceNodes = [];
    for (const space of spaces) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      const folderNodes = [];
      for (const folder of folders) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        folderNodes.push({
          name: folder.name,
          lists: await Promise.all(lists.map(listNode)),
        });
      }
      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      spaceNodes.push({
        name: space.name,
        folders: folderNodes,
        lists: await Promise.all(directLists.map(listNode)),
      });
    }

    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();

    const executionPlans = await ctx.db
      .query("executionPlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const executionWaves = (
      await Promise.all(
        executionPlans.map((plan) =>
          ctx.db
            .query("executionWaves")
            .withIndex("by_plan", (q) => q.eq("planId", plan._id))
            .collect(),
        ),
      )
    ).flat();
    const executionPlanReviews = (
      await Promise.all(
        executionPlans.map((plan) =>
          ctx.db
            .query("executionPlanReviews")
            .withIndex("by_plan", (q) => q.eq("planId", plan._id))
            .collect(),
        ),
      )
    ).flat();
    const executionPlanRevisions = (
      await Promise.all(
        executionPlans.map((plan) =>
          ctx.db
            .query("executionPlanRevisions")
            .withIndex("by_plan", (q) => q.eq("planId", plan._id))
            .collect(),
        ),
      )
    ).flat();
    const executionAssignments = (
      await Promise.all(
        executionPlans.map((plan) =>
          ctx.db
            .query("executionAssignments")
            .withIndex("by_plan", (q) => q.eq("planId", plan._id))
            .collect(),
        ),
      )
    ).flat();
    const agentPingDeliveries = (
      await Promise.all(
        executionAssignments.map((assignment) =>
          ctx.db
            .query("agentPingDeliveries")
            .withIndex("by_execution_assignment", (q) =>
              q.eq("executionAssignmentId", assignment._id),
            )
            .unique(),
        ),
      )
    ).filter((delivery) => delivery !== null);
    const outcomeChecks = (
      await Promise.all(
        executionPlans.map((plan) =>
          ctx.db
            .query("outcomeChecks")
            .withIndex("by_plan", (q) => q.eq("planId", plan._id))
            .collect(),
        ),
      )
    ).flat();
    const spaceName = new Map(spaces.map((space) => [space._id, space.name]));
    const agentName = new Map(agents.map((agent) => [agent._id, agent.name]));
    const pingDeliveryByAssignment = new Map(
      agentPingDeliveries.map((delivery) => [
        delivery.executionAssignmentId,
        delivery,
      ]),
    );

    return {
      exportedAt: Date.now(),
      apiVersion: 1,
      workspace: { name: workspace.name, slug: workspace.slug },
      executionPolicy: workspace.executionPolicy ?? {
        mode: "supervised",
        version: 0,
        maxPlanTasks: 25,
        maxTasksPerWave: 10,
        dailyTaskLimit: 100,
      },
      spaces: spaceNodes,
      roadmaps: roadmaps.map((r) => ({
        name: r.name,
        description: r.description,
        phases: r.phases.map((p) => ({
          name: p.name,
          targetDate: p.targetDate,
        })),
      })),
      executionPlans: executionPlans.map((plan) => ({
        name: plan.name,
        objective: plan.objective,
        destinationSpace: spaceName.get(plan.spaceId),
        createdByAgent: agentName.get(plan.createdByAgentId),
        sourceContext: plan.sourceContext,
        successCriteria: plan.successCriteria,
        assumptions: plan.assumptions,
        openQuestions: plan.openQuestions,
        reviewStatus: plan.reviewStatus ?? "legacy_approved",
        authorizationSource:
          plan.reviewStatus === undefined
            ? "legacy"
            : plan.authorizationSource ??
              (plan.reviewStatus === "approved" ? "human_review" : "none"),
        authorizationPolicyVersion: plan.authorizationPolicyVersion,
        authorizationReason: plan.authorizationReason,
        authorizationHistory: executionPlanReviews
          .filter((review) => review.planId === plan._id)
          .sort((a, b) => a.reviewedAt - b.reviewedAt)
          .map((review) => ({
            decision: review.decision,
            note: review.note,
            reviewedByClerkId: review.reviewedByClerkId,
            reviewedAt: review.reviewedAt,
          })),
        contextRevisions: executionPlanRevisions
          .filter((revision) => revision.planId === plan._id)
          .sort((a, b) => a.revision - b.revision)
          .map((revision) => ({
            revision: revision.revision,
            changeSummary: revision.changeSummary,
            sourceAddendum: revision.sourceAddendum,
            createdByAgent: agentName.get(revision.createdByAgentId),
            affectedPacketCount: revision.affectedPacketCount,
            affectedTaskCount: revision.affectedTaskCount,
            createdAt: revision.createdAt,
          })),
        projects: plan.projects.map((project) => ({
          ref: project.ref,
          name: project.name,
        })),
        tasks: plan.tasks.map((task) => ({
          ref: task.ref,
          title: task.title,
        })),
        outcomeAssurance: plan.successCriteria.map((criterion, criterionIndex) => {
          const check = outcomeChecks.find(
            (row) =>
              row.planId === plan._id &&
              row.criterionIndex === criterionIndex,
          );
          return {
            criterion,
            status: check?.status ?? "pending",
            evidenceSummary: check?.evidenceSummary,
            evidenceLinks: check?.evidenceLinks,
            submittedByAgent: check?.submittedByAgentId
              ? agentName.get(check.submittedByAgentId)
              : undefined,
            submittedAt: check?.submittedAt,
            reviewedByActorType: check?.reviewedByActorType,
            reviewedByActorId: check?.reviewedByActorId,
            reviewNote: check?.reviewNote,
            reviewedAt: check?.reviewedAt,
          };
        }),
        createdAt: plan.createdAt,
      })),
      executionWaves: executionWaves.map((wave) => ({
        executionPlan:
          executionPlans.find((plan) => plan._id === wave.planId)?.name,
        openQuestionDisposition: wave.openQuestionDisposition,
        authorizationSource: wave.authorizationSource,
        authorizationPolicyVersion: wave.authorizationPolicyVersion,
        assignments: wave.assignments.map((assignment) => ({
          taskRef: assignment.taskRef,
          agent: agentName.get(assignment.agentId),
          delivery: assignment.delivery,
          contextPacketCount: assignment.contextPacketCount,
          estimatedContextTokens: assignment.estimatedContextTokens,
          contextVersionFingerprint:
            assignment.contextVersionFingerprint,
        })),
        skipped: wave.skipped,
        createdAt: wave.createdAt,
      })),
      executionAssignments: executionAssignments.map((assignment) => ({
        executionPlan:
          executionPlans.find((plan) => plan._id === assignment.planId)?.name,
        taskRef: assignment.taskRef,
        agent: agentName.get(assignment.agentId),
        delivery: assignment.delivery,
        wakeDelivery: (() => {
          const delivery = pingDeliveryByAssignment.get(assignment._id);
          return delivery
            ? {
                status: delivery.status,
                attempts: delivery.attempts,
                responseStatus: delivery.responseStatus,
                lastError: delivery.lastError,
                lastAttemptAt: delivery.lastAttemptAt,
                completedAt: delivery.completedAt,
              }
            : undefined;
        })(),
        contextPacketCount: assignment.contextPacketCount,
        estimatedContextTokens: assignment.estimatedContextTokens,
        contextVersionFingerprint: assignment.contextVersionFingerprint,
        status: assignment.status,
        attempt: assignment.attempt,
        dispatchedAt: assignment.dispatchedAt,
        claimedAt: assignment.claimedAt,
        startedAt: assignment.startedAt,
        lastHeartbeatAt: assignment.lastHeartbeatAt,
        finishedAt: assignment.finishedAt,
        summary: assignment.summary,
        error: assignment.error,
        links: assignment.links,
      })),
      sprints: sprints.map((s) => ({
        name: s.name,
        goal: s.goal,
        startDate: s.startDate,
        endDate: s.endDate,
        status: s.status,
      })),
      agents: agents.map((a) => ({
        name: a.name,
        role: a.role ?? "member",
        status: a.status,
        dailyActionLimit: a.dailyActionLimit,
        capabilities: a.capabilities,
        maxConcurrentTasks: a.maxConcurrentTasks,
      })),
    };
  },
});
