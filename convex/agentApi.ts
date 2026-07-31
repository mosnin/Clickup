import { ConvexError, v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { notify } from "./notificationCenter";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  agentActor,
  agentCanTouchList,
  requireAgentByKey,
  requireProjectAccessForAgent,
  requireListAccessForAgent,
  requireSpaceAccessForAgent,
  requireTaskAccessForAgent,
  requireUnrestricted,
  requireWorkspaceAccessForAgent,
  sha256Hex,
  canAgentAccessSpace,
  BURST_LIMIT_PER_MINUTE,
  DEFAULT_DAILY_ACTION_LIMIT,
} from "./_agentAuth";
import { getSpaceForList } from "./_authz";
import { addNodeCore, decideCore } from "./plans";
import {
  SURFACE_TYPE as PRESENCE_SURFACE,
  clearActorPresence,
  markPresence,
  type SurfaceType,
} from "./presence";
import {
  assertValueReferences,
  computeDerivedValues,
  fieldConfigValidator,
  fieldOptionValidator,
  fieldTypeValidator,
  fieldValueArgs,
  fieldValueSummary,
  isComputedType,
  normalizeFieldDefinition,
  normalizeFieldValue,
} from "./_customFields";
import { x402Config } from "./_x402";
import {
  CLAIM_TTL_MS,
  claimTaskCore,
  createTaskCore,
  handoffTaskCore,
  releaseTaskCore,
  removeTaskCore,
  reorderTasksCore,
  updateTaskCore,
} from "./tasks";
import {
  moveListCore,
  renameListCore,
  removeListCore,
  reorderListsCore,
  updateListMetaCore,
} from "./lists";
import {
  createProjectCore,
  updateProjectMetaCore,
  removeProjectCore,
  renameProjectCore,
  reorderProjectsCore,
} from "./projects";
import {
  createMilestoneCore,
  milestonesWithProgress,
  removeMilestoneCore,
  updateMilestoneCore,
} from "./milestones";
import {
  addPhaseCore,
  createRoadmapCore,
  removePhaseCore,
  updatePhaseCore,
} from "./roadmaps";
import { createMessageCore, scopeForMessageParent } from "./messages";
import {
  applySprintTemplateCore,
  createSprintCore,
  sprintSummaryCore,
  updateSprintCore,
} from "./sprints";
import { sprintTemplateCatalog } from "./sprintTemplates";
import { createScheduledTaskCore, computeNextRunAt } from "./scheduledTasks";
import { createSubscription } from "./webhooks";
import { skillsForScope } from "./skills";
import { withDerivedProgress } from "./goals";
import {
  blueprintTaskFields,
  createTaskBlueprintCore,
} from "./taskBlueprints";
import { createChannelCore } from "./channels";
import { markChannelReadCore } from "./messages";
import {
  applyCatalogDocTemplateCore,
  applyCatalogListTemplateCore,
  applyCatalogTaskTemplateCore,
  applyCatalogViewTemplateCore,
  applyCatalogWhiteboardTemplateCore,
  applyListTemplateCore,
  templateCatalog,
} from "./templates";
import {
  findTemplate,
  summarizeTemplate,
  templateCenterCatalog,
} from "./templateCatalog";
import { seedDefaultStatuses } from "./listStatuses";
import { emitEvent, scopeForList } from "./events";
import { getRollup } from "./rollups";
import { executionPlanSummary, executionPlanView } from "./executionPlans";
import {
  hasCapabilities,
  missingCapabilities,
} from "./capabilities";
import {
  executionControlCore,
  executionReadinessCore,
} from "./executionDispatch";
import {
  executionPolicyFor,
  executionPolicyValidator,
  planAuthorization,
} from "./executionPolicy";
import {
  abandonExecutionAssignmentForTask,
  finishExecutionAssignment,
  latestExecutionAssignmentForTask,
  markExecutionAssignmentClaimed,
  markExecutionAssignmentRunning,
  reconcileStaleExecutionAssignments,
  touchExecutionAssignment,
} from "./executionLifecycle";
import {
  outcomeAssuranceView,
  reviewOutcomeCriterionCore,
  submitOutcomeEvidenceCore,
} from "./outcomeAssurance";
import {
  acknowledgeTaskContextCore,
  attachContextPacketCore,
  contextReadinessForAgent,
  createContextPacketCore,
  deleteContextPacketCore,
  detachContextPacketCore,
  listPacketsForTask,
  requireCurrentContext,
  updateContextPacketCore,
} from "./contextPackets";
import {
  assessDecisionImpactCore,
  createDecisionCore,
  decisionRowsForTask,
  requireDecisionImpactsResolved,
  supersedeDecisionCore,
} from "./decisions";
import { enqueueAgentPingDelivery } from "./agentPingDeliveries";
import {
  addressRevisionCore,
  createRevisionCore,
  openOnly,
  revisionsForParent,
} from "./revisions";
import { clipText, tiptapToText } from "./_docText";
import { markdownExcerpt } from "./_markdown";
import {
  attachPageCore,
  createPageCore,
  updatePageCore,
} from "./pages";

// The agent-facing API: every function here authenticates with an agent
// API key instead of Clerk, resolves the agent's scope (personal space or
// workspace), and reuses the same *Core write paths as the human app so
// automations, notifications, and events behave identically no matter who
// acted. The MCP server (src/app/api/mcp) is a thin adapter over these.

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

const checklistValidator = v.array(
  v.object({ id: v.string(), text: v.string(), done: v.boolean() }),
);

async function requireTaskExecutionReady(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
) {
  await requireCurrentContext(ctx, taskId, agentId);
  await requireDecisionImpactsResolved(ctx, taskId);
}

// ── Shared helpers ─────────────────────────────────────────────────────

function scopeOf(agent: Doc<"agents">): {
  scopeType: "user" | "workspace";
  scopeId: string;
} {
  return { scopeType: agent.parentType, scopeId: agent.parentId };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function workspaceIdForMessageParent(
  ctx: QueryCtx | MutationCtx,
  parentType: "task" | "space" | "workspace" | "channel",
  parentId: string,
): Promise<Id<"workspaces"> | null> {
  const scope = await scopeForMessageParent(ctx, parentType, parentId);
  return scope?.scopeType === "workspace"
    ? (scope.scopeId as Id<"workspaces">)
    : null;
}

// Agents may touch a message parent when it resolves into their scope.
async function requireMessageParentAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  parentType: "task" | "space" | "workspace" | "channel" | "page",
  parentId: string,
  agent: Doc<"agents">,
): Promise<void> {
  const scope = await scopeForMessageParent(ctx, parentType, parentId);
  if (
    !scope ||
    scope.scopeType !== agent.parentType ||
    scope.scopeId !== agent.parentId
  ) {
    throw new ConvexError(
      "You can't access this thread — its parent is outside your agent's scope. Call whoami to see your scope, get_tree for what's visible.",
    );
  }
}

async function requireDocAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  docId: Id<"docs">,
  agent: Doc<"agents">,
): Promise<Doc<"docs">> {
  const doc = await ctx.db.get(docId);
  if (!doc) throw new ConvexError("Doc not found");
  const docAccessRefusal =
    "You can't access this doc — it's outside your agent's scope. Call whoami to see your scope, list_docs for docs you can read.";
  if (doc.parentType === "space") {
    const space = await ctx.db.get(doc.parentId as Id<"spaces">);
    if (!space || !canAgentAccessSpace(space, agent)) {
      throw new ConvexError(docAccessRefusal);
    }
  } else if (
    doc.parentType !== agent.parentType ||
    doc.parentId !== agent.parentId
  ) {
    throw new ConvexError(docAccessRefusal);
  }
  return doc;
}

// Walk every list in the agent's scope (spaces → projects → lists),
// respecting allowedListIds the same way listTasks/nextTask/searchTasks do.
// Shared by the sprint-planning backlog scan and the portfolio tool so
// there's exactly one "walk my whole scope" implementation to keep in sync
// with list-restriction rules.
async function listsInScope(
  ctx: QueryCtx | MutationCtx,
  agent: Doc<"agents">,
  opts?: { skipArchived?: boolean },
): Promise<{ list: Doc<"lists">; spaceName: string }[]> {
  const out: { list: Doc<"lists">; spaceName: string }[] = [];
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
    )
    .collect();
  for (const space of spaces) {
    if (opts?.skipArchived && space.archivedAt !== undefined) continue;
    const parents: { type: "space" | "project"; id: string }[] = [
      { type: "space", id: space._id },
    ];
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    for (const f of projects) parents.push({ type: "project", id: f._id });
    for (const p of parents) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", p.type).eq("parentId", p.id),
        )
        .collect();
      for (const l of lists) {
        if (!agentCanTouchList(agent, l._id)) continue;
        out.push({ list: l, spaceName: space.name });
      }
    }
  }
  return out;
}

// Open (non-complete, non-closed) blockers for a task, with just enough
// detail for planning/network tools.
async function openBlockerCount(
  ctx: QueryCtx | MutationCtx,
  task: Doc<"tasks">,
): Promise<number> {
  let count = 0;
  for (const id of task.blockedByTaskIds ?? []) {
    const blocker = await ctx.db.get(id);
    if (!blocker) continue;
    const bs = await ctx.db.get(blocker.statusId);
    if (bs?.category !== "complete" && bs?.category !== "closed") count++;
  }
  return count;
}

async function taskView(ctx: QueryCtx | MutationCtx, task: Doc<"tasks">) {
  const status = await ctx.db.get(task.statusId);
  const blockers = [];
  for (const id of task.blockedByTaskIds ?? []) {
    const b = await ctx.db.get(id);
    if (!b) continue;
    const bs = await ctx.db.get(b.statusId);
    blockers.push({
      taskId: b._id,
      title: b.title,
      statusCategory: bs?.category ?? "open",
    });
  }
  return {
    taskId: task._id,
    listId: task.listId,
    title: task.title,
    description: task.description,
    status: status
      ? { statusId: status._id, name: status.name, category: status.category }
      : null,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    assigneeIds: task.assigneeClerkIds,
    requiredCapabilities: task.requiredCapabilities ?? [],
    parentTaskId: task.parentTaskId,
    sprintId: task.sprintId,
    recurrence: task.recurrence,
    checklist: task.checklist ?? [],
    blockedBy: blockers,
    requiresApproval: task.requiresApproval ?? false,
    approvedAt: task.approvedAt,
    claimedBy: task.claimedByActorId,
    claimedAt: task.claimedAt,
    // Round-trip everything create_task accepts: a second agent reading
    // the plan must see the same estimates/milestones/order the first
    // agent wrote (write-only fields are a data trap).
    estimatePoints: task.estimatePoints,
    milestone: task.milestone ?? false,
    // Which of the project's dated checkpoints this task belongs to (null
    // when it belongs to none) — see list_milestones / set_task_milestone.
    milestoneId: task.milestoneId ?? null,
    position: task.position,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

// Sidebar-tree list node: id + name plus the ops config an agent should
// see before creating work there (routing = auto-assignment, sopSlug =
// the procedure attached to every task read).
function treeListNode(l: Doc<"lists">) {
  return {
    listId: l._id,
    name: l.name,
    routing: l.routing
      ? { mode: l.routing.mode, assignees: l.routing.assigneeIds.length }
      : null,
    sopSlug: l.sopSlug ?? null,
    // What this board is for. Health, owner and target date describe the
    // Project that owns the list and ride the project node instead.
    description: l.description ?? null,
  };
}

// Project-level intent, so the tree alone answers "what is this project for,
// how is it going and when is it due" without a per-project read.
function treeProjectNode(p: Doc<"projects">) {
  return {
    projectId: p._id,
    name: p.name,
    description: p.description ?? null,
    projectStatus: p.projectStatus ?? null,
    ownerActorId: p.ownerActorId ?? null,
    targetDate: p.targetDate ?? null,
    roadmap: p.roadmapId
      ? { roadmapId: p.roadmapId, phaseId: p.roadmapPhaseId ?? null }
      : null,
  };
}

// Curated sprint shape (no raw Convex doc fields).
function sprintView(s: Doc<"sprints">) {
  return {
    sprintId: s._id,
    name: s.name,
    goal: s.goal,
    startDate: s.startDate,
    endDate: s.endDate,
    status: s.status,
    capacityPoints: s.capacityPoints,
    retrospective: s.retrospective,
    createdByActorId: s.createdByActorId,
    createdAt: s.createdAt,
  };
}

// tiptapToText is imported from _docText.ts. It used to be duplicated here
// because the original lived in ai.ts, a Node-runtime action this module can't
// import; _docText.ts is pure and importable from both, so there is one copy.

function textToTiptap(text: string): unknown {
  return {
    type: "doc",
    content: text.split(/\n{2,}/).map((para) => ({
      type: "paragraph",
      content: para.trim()
        ? [{ type: "text", text: para.replace(/\n/g, " ").trim() }]
        : [],
    })),
  };
}

// ── Identity & presence ────────────────────────────────────────────────

export const whoami = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent, key } = await requireAgentByKey(ctx, apiKey);
    let scopeName = "Personal space";
    if (agent.parentType === "workspace") {
      const ws = await ctx.db.get(agent.parentId as Id<"workspaces">);
      scopeName = ws?.name ?? "Workspace";
    }

    // Governance mirror: everything that can make a mutation refuse,
    // surfaced up front so agents plan around limits instead of
    // discovering them as errors.
    const role = agent.role ?? "member";
    let allowedLists: { listId: Id<"lists">; name: string }[] | null = null;
    if (agent.allowedListIds !== undefined) {
      allowedLists = [];
      for (const listId of agent.allowedListIds) {
        const list = await ctx.db.get(listId);
        if (list) allowedLists.push({ listId: list._id, name: list.name });
      }
    }
    const dailyActionLimit =
      agent.dailyActionLimit ?? DEFAULT_DAILY_ACTION_LIMIT;
    const day = new Date().toISOString().slice(0, 10);
    const usage = await ctx.db
      .query("agentUsage")
      .withIndex("by_agent_day", (q) =>
        q.eq("agentId", agent._id).eq("day", day),
      )
      .unique();
    const actionsUsedToday = usage?.count ?? 0;

    // Billing: same reads as the metering check in requireAgentByKey.
    const meteringRow = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", "x402.metering"))
      .unique();
    const meteringEnabled =
      meteringRow?.value === "on" || meteringRow?.value === true;
    const priceRow = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", "x402.actionCredits"))
      .unique();
    const creditsPerAction =
      typeof priceRow?.value === "number" && priceRow.value >= 0
        ? priceRow.value
        : x402Config().actionCredits;
    const wallet = await ctx.db
      .query("agentWallets")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .unique();

    return {
      agentId: agent._id,
      name: agent.name,
      description: agent.description,
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      scopeName,
      statusText: agent.statusText,
      currentTaskId: agent.currentTaskId,
      lastSeenAt: agent.lastSeenAt,
      lastConnectedAt: agent.lastConnectedAt,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      role,
      // Declared specialties used to match work to agents. This is NOT a
      // permission list — an empty array means "no declared specialty", not
      // "no authority". Effective authority is `permissions` below, which
      // exists because reading an empty `capabilities` next to broad
      // workspace mutation rights is genuinely misleading.
      capabilities: agent.capabilities ?? [],
      maxConcurrentTasks: agent.maxConcurrentTasks ?? 1,
      allowedLists,
      // What this credential can actually do, stated rather than inferred.
      // Every field mirrors a check that would otherwise only surface as a
      // refusal at call time.
      permissions: {
        read: true,
        // readonly agents may call every read tool and no mutation.
        write: role !== "readonly",
        // Structure = spaces, projects, lists, roadmaps, sprints. A
        // list-restricted agent is refused these outright, because creating
        // structure is not scopeable to a list.
        manageStructure: role !== "readonly" && allowedLists === null,
        // Writing tasks/comments/pages, within allowedLists when set.
        writeTasks: role !== "readonly",
        restrictedToLists: allowedLists !== null,
        // Approval is deliberately one-directional: an agent may raise a
        // gate and report work as ready, never approve it.
        canRequestApproval: role !== "readonly",
        canApprove: false,
        // Revisions mirror the same asymmetry.
        canAddressRevisions: role !== "readonly",
        canAcceptRevisions: false,
      },
      dailyActionLimit,
      actionsUsedToday,
      actionsRemainingToday: Math.max(0, dailyActionLimit - actionsUsedToday),
      burstLimitPerMinute: BURST_LIMIT_PER_MINUTE,
      billing: {
        meteringEnabled,
        creditsBalance: wallet ? wallet.balance : null,
        creditsPerAction,
      },
      // Provenance: which credential is talking and what it will change.
      // A key is bound to exactly one scope and cannot be pointed at
      // another, so "which workspace am I about to modify" has a single
      // answer — but the caller has to be able to see it before acting,
      // not discover it from the results.
      connection: {
        // A credential is either a minted API key or an OAuth access token.
        // Which one is in play changes how it was obtained and how it is
        // revoked, so the caller should not have to guess.
        authMethod: "keyPrefix" in key ? ("api_key" as const) : ("oauth" as const),
        keyPrefix: "keyPrefix" in key ? key.keyPrefix : null,
        // The one sentence a human needs when a connector is bound to the
        // wrong place: this is what you are editing.
        boundTo: `${agent.name} in ${scopeName}`,
        scopeIsSwitchable: false,
        note: "This API key is permanently bound to the scope above. To act in a different workspace, use that workspace's own key — there is no scope selector.",
      },
      firstSteps:
        "New here? Confirm `connection.boundTo` is the workspace you mean before writing anything. Then fetch the collaboration-protocol skill, find work with next_task, read get_task, acknowledge its context versions, and claim and heartbeat while working.",
    };
  },
});

// MCP clients call this during transport authentication. A successful
// connection is presence even before the client starts a task or schedules
// explicit heartbeats, so Mission Control should reflect it immediately.
export const connect = mutation({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const firstConnection = agent.lastSeenAt === undefined;
    const now = Date.now();
    // Authentication runs for every MCP request. Keep presence responsive
    // without turning a busy tool session into a write per tool call.
    if (
      firstConnection ||
      agent.lastConnectedAt === undefined ||
      now - agent.lastConnectedAt >= 30_000
    ) {
      await ctx.db.patch(agent._id, {
        lastSeenAt: now,
        lastConnectedAt: now,
      });
    }
    if (firstConnection) {
      await emitEvent(ctx, {
        scopeType: agent.parentType,
        scopeId: agent.parentId,
        type: "agent.connected",
        actor: agentActor(agent),
        entityType: "agent",
        entityId: agent._id,
        entityTitle: agent.name,
      });
    }
    return { agentId: agent._id, name: agent.name };
  },
});

// Presence ping. Call every few minutes while working: bumps lastSeenAt,
// optionally sets the "now working on" line shown in Mission Control.
export const heartbeat = mutation({
  args: {
    apiKey: v.string(),
    statusText: v.optional(v.string()),
    currentTaskId: v.optional(v.union(v.id("tasks"), v.null())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const firstConnection = agent.lastSeenAt === undefined;
    const now = Date.now();
    const patch: Record<string, unknown> = {
      lastSeenAt: now,
      lastHeartbeatAt: now,
    };
    if (args.statusText !== undefined) {
      patch.statusText = args.statusText.slice(0, 200) || undefined;
    }
    if (args.currentTaskId !== undefined) {
      if (args.currentTaskId === null) {
        patch.currentTaskId = undefined;
      } else {
        const { task } = await requireTaskAccessForAgent(
          ctx,
          args.currentTaskId,
          agent,
        );
        await requireTaskExecutionReady(ctx, args.currentTaskId, agent._id);
        if (
          task.claimedByActorId !== agent._id ||
          task.claimedAt === undefined ||
          Date.now() - task.claimedAt > CLAIM_TTL_MS
        ) {
          throw new ConvexError(
            "Claim this task before setting it as your current work",
          );
        }
        patch.currentTaskId = args.currentTaskId;
        await touchExecutionAssignment(ctx, args.currentTaskId, agent._id);
      }
    }
    await ctx.db.patch(agent._id, patch);
    // The very first heartbeat is a moment: the human just wired up their
    // runtime. Emit it so the UI (and webhooks) can celebrate/react.
    if (firstConnection) {
      await emitEvent(ctx, {
        scopeType: agent.parentType,
        scopeId: agent.parentId,
        type: "agent.connected",
        actor: agentActor(agent),
        entityType: "agent",
        entityId: agent._id,
        entityTitle: agent.name,
      });
    }
  },
});

/**
 * Can this agent be on this surface?
 *
 * Routed through the agent-side checks rather than the human ones, so an agent
 * restricted to certain lists cannot appear on a surface it has no business
 * touching — presence is visible to the whole team, and a machine showing up
 * somewhere it was fenced out of is a governance leak even if it changes nothing.
 */
async function requireSurfaceAccessForAgent(
  ctx: MutationCtx,
  surfaceType: SurfaceType,
  surfaceId: string,
  agent: Doc<"agents">,
): Promise<void> {
  if (surfaceType === "task") {
    const id = ctx.db.normalizeId("tasks", surfaceId);
    if (!id) throw new ConvexError("Task not found");
    await requireTaskAccessForAgent(ctx, id, agent);
    return;
  }
  if (surfaceType === "list") {
    const id = ctx.db.normalizeId("lists", surfaceId);
    if (!id) throw new ConvexError("List not found");
    await requireListAccessForAgent(ctx, id, agent);
    return;
  }
  if (surfaceType === "project") {
    const id = ctx.db.normalizeId("projects", surfaceId);
    if (!id) throw new ConvexError("Project not found");
    await requireProjectAccessForAgent(ctx, id, agent);
    return;
  }
  if (surfaceType === "space") {
    const id = ctx.db.normalizeId("spaces", surfaceId);
    if (!id) throw new ConvexError("Space not found");
    await requireSpaceAccessForAgent(ctx, id, agent);
    return;
  }
  // A page is scoped rather than nested, so scope equality is the whole check —
  // the same rule `writePage` applies.
  const id = ctx.db.normalizeId("pages", surfaceId);
  if (!id) throw new ConvexError("Page not found");
  const page = await ctx.db.get(id);
  if (
    !page ||
    page.scopeType !== agent.parentType ||
    page.scopeId !== agent.parentId
  ) {
    throw new ConvexError("Forbidden");
  }
}

/**
 * "I am on this surface, and here is what I am doing."
 *
 * An explicit tool rather than something inferred from reads, because a Convex
 * query cannot write and most of what an agent does while thinking is reading.
 * Writes announce themselves automatically (claiming a task, editing a page);
 * this is how an agent says it is *studying* something, which is exactly the
 * moment a person wondering "is anything happening?" needs to see a dot.
 *
 * Cheap on purpose — classified as a presence call, so it neither consumes an
 * action budget nor bills against the wallet. Presence you have to pay for is
 * presence an agent will skip.
 */
/**
 * Suggest an arrangement for a project's screen.
 *
 * Never a write to anyone's layout. The naive version of "the UI adapts to
 * the work" is an agent silently rearranging a person's screen, which breaks
 * the stability that makes an interface learnable. So the agent authors a
 * proposal with a reason, and a person previews, accepts, or dismisses it —
 * the approval-gate consent shape, pointed at the interface.
 *
 * One pending proposal per agent per screen: a newer suggestion replaces the
 * older one rather than queueing, because "here are four layouts I've thought
 * of" is noise where "here is my current best suggestion" is signal.
 */
export const proposeScreen = mutation({
  args: {
    apiKey: v.string(),
    projectId: v.id("projects"),
    /** { widgets: [{ id, span }] } — the same shape layouts are stored in. */
    layout: v.object({
      widgets: v.array(
        v.object({
          id: v.string(),
          span: v.union(v.literal(1), v.literal(2), v.literal(3)),
        }),
      ),
    }),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    // Shaping how a whole project is read is a structure-level act, and a
    // list-restricted agent is fenced out of those entirely — same rule as
    // creating lists or moving projects.
    requireUnrestricted(agent);
    await requireProjectAccessForAgent(ctx, args.projectId, agent);

    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError(
        "A proposal needs a reason — without one it is an instruction",
      );
    }
    if (args.layout.widgets.length > 20) {
      throw new ConvexError("A screen holds at most 20 panels");
    }
    // Unknown widget ids are fine (the client drops what it can't render) but
    // duplicates would make the layout ill-formed on every client.
    const ids = new Set<string>();
    for (const w of args.layout.widgets) {
      if (ids.has(w.id)) {
        throw new ConvexError(`Panel "${w.id}" appears twice`);
      }
      ids.add(w.id);
    }

    const screenKey = `project:${args.projectId}`;
    // Replace this agent's previous pending suggestion for the same screen.
    const pending = await ctx.db
      .query("screenProposals")
      .withIndex("by_screen_and_status", (q) =>
        q.eq("screenKey", screenKey).eq("status", "pending"),
      )
      .collect();
    for (const prior of pending) {
      if (prior.agentId === agent._id) await ctx.db.delete(prior._id);
    }

    const proposalId = await ctx.db.insert("screenProposals", {
      screenKey,
      agentId: agent._id,
      agentName: agent.name,
      layout: args.layout,
      reason: reason.slice(0, 500),
      status: "pending",
      createdAt: Date.now(),
    });
    return { proposalId };
  },
});

/**
 * Suggest a panel this screen does not have.
 *
 * The step past `proposeScreen`. That one rearranges what already exists;
 * this one adds a question nobody asked. An agent that has been doing the work
 * knows which question is missing — "nothing here shows what is blocked on
 * you" — and a panel is a definition rather than code, so it can write one.
 *
 * The definition is taken as an opaque object on purpose. Validating the
 * vocabulary here would be a second copy of `normalizePanel`, and a second
 * copy is how the two drift; instead the renderer normalizes on every read, so
 * a definition using a value this build has never heard of degrades to one it
 * can draw rather than breaking a screen. Executing it is separately safe:
 * `dataStream.resolve` has exactly one branch per enumerated value and gathers
 * records through the caller's own access checks, so the worst a hostile
 * definition can do is show its author a differently-grouped view of records
 * they could already read.
 *
 * One pending proposal per agent per screen. "Here are four panels I thought
 * of" is noise where "here is the one I think you are missing" is signal, and
 * every pending proposal is a banner on somebody's screen.
 */
export const proposePanel = mutation({
  args: {
    apiKey: v.string(),
    projectId: v.id("projects"),
    /** A PanelDef: { title, query, shape, fields, style, caption }. */
    definition: v.any(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    // Adding to how a whole project is read is structure-level, same as
    // proposing an arrangement: a list-restricted agent is fenced out.
    requireUnrestricted(agent);
    await requireProjectAccessForAgent(ctx, args.projectId, agent);

    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError(
        "A proposal needs a reason — without one it is an instruction",
      );
    }
    if (args.definition === null || typeof args.definition !== "object") {
      throw new ConvexError("A panel proposal needs a definition object");
    }

    const screenKey = `project:${args.projectId}`;
    const pending = await ctx.db
      .query("panelProposals")
      .withIndex("by_screen_and_status", (q) =>
        q.eq("screenKey", screenKey).eq("status", "pending"),
      )
      .collect();
    for (const prior of pending) {
      if (prior.agentId === agent._id) await ctx.db.delete(prior._id);
    }

    const proposalId = await ctx.db.insert("panelProposals", {
      screenKey,
      agentId: agent._id,
      agentName: agent.name,
      definition: args.definition,
      // The scope the agent lives in, which is the scope it can read. The
      // panel is minted there on accept, and access is checked again then.
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      reason: reason.slice(0, 500),
      status: "pending",
      createdAt: Date.now(),
    });
    return { proposalId };
  },
});

// ── The plan ────────────────────────────────────────────────────────────
//
// Where an agent thinks *out loud in a structure* rather than into a channel.
// The difference is not tone, it is retrievability: a question with two
// options and evidence under each is a thing the next agent can read in
// seconds, where four hundred messages is a thing it will read wrong.
//
// All four route through the same cores the human mutations use, so consent,
// shape checks and events cannot drift between the two. The only place the
// actor changes the outcome is closing a question — see `decideCore`.

/** Raise a question this project has not answered. */
export const planAsk = mutation({
  args: {
    apiKey: v.string(),
    projectId: v.id("projects"),
    body: v.string(),
    /** Ask for a person to be the one who settles it. */
    needsHuman: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireProjectAccessForAgent(ctx, args.projectId, agent);
    const nodeId = await addNodeCore(ctx, {
      projectId: args.projectId,
      kind: "question",
      body: args.body,
      needsHuman: args.needsHuman,
      actor: agentActor(agent),
    });
    return { nodeId };
  },
});

/** Offer a candidate answer to a question. */
export const planOption = mutation({
  args: {
    apiKey: v.string(),
    questionId: v.id("planNodes"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const question = await ctx.db.get(args.questionId);
    if (!question) throw new ConvexError("Question not found");
    await requireProjectAccessForAgent(ctx, question.projectId, agent);
    const nodeId = await addNodeCore(ctx, {
      projectId: question.projectId,
      kind: "option",
      parentId: args.questionId,
      body: args.body,
      actor: agentActor(agent),
    });
    return { nodeId };
  },
});

/** File something you actually learned, under the option it bears on. */
export const planEvidence = mutation({
  args: {
    apiKey: v.string(),
    optionId: v.id("planNodes"),
    body: v.string(),
    stance: v.union(
      v.literal("supports"),
      v.literal("refutes"),
      v.literal("neutral"),
    ),
    ref: v.optional(v.object({ kind: v.string(), id: v.string() })),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const option = await ctx.db.get(args.optionId);
    if (!option) throw new ConvexError("Option not found");
    await requireProjectAccessForAgent(ctx, option.projectId, agent);
    const nodeId = await addNodeCore(ctx, {
      projectId: option.projectId,
      kind: "evidence",
      parentId: args.optionId,
      body: args.body,
      stance: args.stance,
      ref: args.ref,
      actor: agentActor(agent),
    });
    return { nodeId };
  },
});

/**
 * Settle a question, or ask to.
 *
 * Which of the two this is depends on the question, not on the caller's
 * intention: one marked `needsHuman` cannot be closed by a machine, and the
 * decision lands unaccepted, reading as "waiting on you" until a person signs
 * off. The reply says which happened so the agent knows whether to proceed.
 */
export const planDecide = mutation({
  args: {
    apiKey: v.string(),
    questionId: v.id("planNodes"),
    chosenOptionId: v.optional(v.id("planNodes")),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const question = await ctx.db.get(args.questionId);
    if (!question) throw new ConvexError("Question not found");
    await requireProjectAccessForAgent(ctx, question.projectId, agent);
    return await decideCore(ctx, {
      questionId: args.questionId,
      chosenOptionId: args.chosenOptionId,
      body: args.body,
      actor: agentActor(agent),
    });
  },
});

/** Take back something you wrote, without erasing that you wrote it. */
export const planRetract = mutation({
  args: { apiKey: v.string(), nodeId: v.id("planNodes") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const node = await ctx.db.get(args.nodeId);
    if (!node) throw new ConvexError("Not found");
    await requireProjectAccessForAgent(ctx, node.projectId, agent);
    // An agent retracts its own reasoning, never a person's. Otherwise a plan
    // is a place your conclusions can be quietly removed from.
    if (node.authorType !== "agent" || node.authorId !== agent._id) {
      throw new ConvexError("You can only retract what you wrote");
    }
    if (node.retractedAt !== undefined) return { ok: true };
    await ctx.db.patch(args.nodeId, {
      retractedAt: Date.now(),
      retractedByName: agent.name,
    });
    return { ok: true };
  },
});

/**
 * Read the plan.
 *
 * Flat rows, exactly as the UI gets them — `planView` in the shared lib
 * derives the state, and an agent runs the same function the screen does, so
 * the two can never disagree about what is settled.
 */
export const planRead = query({
  args: { apiKey: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "read");
    await requireProjectAccessForAgent(ctx, args.projectId, agent);
    const rows = await ctx.db
      .query("planNodes")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.map((r) => ({
      id: r._id as string,
      kind: r.kind,
      parentId: (r.parentId as string | undefined) ?? null,
      body: r.body,
      authorType: r.authorType,
      authorId: r.authorId,
      authorName: r.authorName,
      createdAt: r.createdAt,
      needsHuman: r.needsHuman === true,
      stance: r.stance ?? "neutral",
      chosenOptionId: (r.chosenOptionId as string | undefined) ?? null,
      acceptedAt: r.acceptedAt ?? null,
      acceptedByName: r.acceptedByName ?? null,
      ref: r.ref ?? null,
      retractedAt: r.retractedAt ?? null,
    }));
  },
});

export const setFocus = mutation({
  args: {
    apiKey: v.string(),
    surfaceType: PRESENCE_SURFACE,
    surfaceId: v.string(),
    /** Writing rather than reading — a caret instead of a dot. */
    editing: v.optional(v.boolean()),
    /** In the agent's own words: "reading the migration runbook". */
    detail: v.optional(v.string()),
    /** Put it down: leave the surface without waiting out the window. */
    leaving: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    // The agent's own scope check, not the human one: an agent restricted to
    // certain lists must not be able to appear on a surface it can't touch.
    await requireSurfaceAccessForAgent(ctx, args.surfaceType, args.surfaceId, agent);
    if (args.leaving) {
      await clearActorPresence(ctx, args.surfaceType, args.surfaceId, agent._id);
      return { present: false };
    }
    await markPresence(ctx, args.surfaceType, args.surfaceId, agentActor(agent), {
      editing: args.editing ?? false,
      detail: args.detail ?? agent.statusText ?? undefined,
    });
    return { present: true };
  },
});

// End-to-end wake receipt. The outbound HTTP response proves only that a
// runtime endpoint accepted a notification; this authenticated callback proves
// the intended agent consumed it and resumed the collaboration protocol.
export const acknowledgeWakeDelivery = mutation({
  args: {
    apiKey: v.string(),
    deliveryId: v.id("agentPingDeliveries"),
  },
  handler: async (ctx, { apiKey, deliveryId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "presence");
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery || delivery.agentId !== agent._id) {
      throw new ConvexError("Wake delivery not found");
    }
    const acknowledgedAt = delivery.acknowledgedAt ?? Date.now();
    if (delivery.acknowledgedAt === undefined) {
      await ctx.db.patch(deliveryId, { acknowledgedAt });
    }
    await ctx.db.patch(agent._id, {
      lastSeenAt: acknowledgedAt,
      lastConnectedAt: acknowledgedAt,
    });
    return {
      deliveryId,
      type: delivery.type,
      taskId: delivery.taskId,
      messageId: delivery.messageId,
      deliveryStatus: delivery.status,
      acknowledgedAt,
    };
  },
});

// Pull fallback for runtimes that were offline, restarted between HTTP accept
// and processing, or intentionally operate without a notify URL. Unconsumed
// wakes remain available until the target agent acknowledges each receipt.
export const listWakeInbox = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const deliveries = await ctx.db
      .query("agentPingDeliveries")
      .withIndex("by_agent_acknowledged", (q) =>
        q.eq("agentId", agent._id).eq("acknowledgedAt", undefined),
      )
      .order("desc")
      .take(50);
    return deliveries.map((delivery) => ({
      deliveryId: delivery._id,
      type: delivery.type,
      payload: delivery.payload,
      taskId: delivery.taskId,
      messageId: delivery.messageId,
      pushStatus: delivery.status,
      pushAttempts: delivery.attempts,
      pushError: delivery.lastError,
      createdAt: delivery.createdAt,
    }));
  },
});

// ── Structure: tree, spaces, projects, lists ────────────────────────────

export const getTree = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    const out = [];
    for (const space of spaces.sort((a, b) => a.position - b.position)) {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      const projectNodes = [];
      for (const project of projects.sort((a, b) => a.position - b.position)) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        projectNodes.push({
          ...treeProjectNode(project),
          lists: lists
            .filter((l) => agentCanTouchList(agent, l._id))
            .map(treeListNode),
        });
      }
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      out.push({
        spaceId: space._id,
        name: space.name,
        projects: projectNodes,
        lists: lists
          .filter((l) => agentCanTouchList(agent, l._id))
          .map(treeListNode),
      });
    }
    return { scopeType: agent.parentType, scopeId: agent.parentId, spaces: out };
  },
});

export const createSpace = mutation({
  args: { apiKey: v.string(), name: v.string() },
  handler: async (ctx, { apiKey, name }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    if (!name.trim()) throw new ConvexError("Name is required");
    const siblings = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    return await ctx.db.insert("spaces", {
      name: name.trim(),
      parentType: agent.parentType,
      parentId: agent.parentId,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

// Routed through createProjectCore, so an agent-created project lands in the
// activity feed as `project.created` exactly like a human-created one — and
// picks up the core's append-after-max positioning instead of a row count
// that collides once a project has been deleted.
export const createProject = mutation({
  args: {
    apiKey: v.string(),
    spaceId: v.id("spaces"),
    name: v.string(),
    description: v.optional(v.string()),
    targetDate: v.optional(v.number()),
    // Roadmap placement at creation time. A workstream that has to be
    // created, then described, then assigned to a phase in three separate
    // calls is a workstream that ends up on no roadmap at all — which is
    // exactly how five AI Tutor workstreams existed beside a roadmap that
    // never referenced them.
    roadmapId: v.optional(v.id("roadmaps")),
    phaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { space } = await requireSpaceAccessForAgent(
      ctx,
      args.spaceId,
      agent,
    );
    const actor = agentActor(agent);
    const projectId = await createProjectCore(ctx, space, args.name, actor, {
      description: args.description,
    });

    if (args.targetDate !== undefined) {
      const project = (await ctx.db.get(projectId))!;
      await updateProjectMetaCore(
        ctx,
        project,
        space,
        { targetDate: args.targetDate },
        actor,
      );
    }

    if (args.roadmapId !== undefined) {
      if (space.parentType !== "workspace") {
        throw new ConvexError("Only workspace projects can join a roadmap");
      }
      const roadmap = await ctx.db.get(args.roadmapId);
      if (!roadmap || roadmap.workspaceId !== space.parentId) {
        throw new ConvexError("Roadmap belongs to a different workspace");
      }
      const phase =
        args.phaseId !== undefined
          ? roadmap.phases.find((p) => p.id === args.phaseId)
          : roadmap.phases[0];
      if (!phase) {
        throw new ConvexError(
          args.phaseId !== undefined
            ? "Phase not found"
            : "Roadmap has no phases",
        );
      }
      const siblings = await ctx.db
        .query("projects")
        .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
        .collect();
      const maxPosition = siblings
        .filter((p) => p.roadmapPhaseId === phase.id)
        .reduce((m, p) => Math.max(m, p.roadmapPosition ?? 0), -1);
      await ctx.db.patch(projectId, {
        roadmapId: roadmap._id,
        roadmapPhaseId: phase.id,
        roadmapPosition: maxPosition + 1,
      });
    }

    return projectId;
  },
});

export const createList = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    parentType: v.union(v.literal("space"), v.literal("project")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (!args.name.trim()) throw new ConvexError("Name is required");
    if (args.parentType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.parentId as Id<"spaces">,
        agent,
      );
    } else {
      const project = await ctx.db.get(args.parentId as Id<"projects">);
      if (!project) throw new ConvexError("Project not found");
      await requireSpaceAccessForAgent(ctx, project.spaceId, agent);
    }
    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();
    const listId = await ctx.db.insert("lists", {
      name: args.name.trim(),
      parentType: args.parentType,
      parentId: args.parentId,
      position: siblings.length,
      createdAt: Date.now(),
    });
    // Same default statuses as lists.create.
    await seedDefaultStatuses(ctx, listId);
    return listId;
  },
});

export const listStatusesForList = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return statuses
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        statusId: s._id,
        name: s.name,
        category: s.category,
      }));
  },
});

// ── Tasks ──────────────────────────────────────────────────────────────

export const listTasks = query({
  args: {
    apiKey: v.string(),
    listId: v.optional(v.id("lists")),
    sprintId: v.optional(v.id("sprints")),
    assignedToMe: v.optional(v.boolean()),
    includeCompleted: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    let tasks: Doc<"tasks">[] = [];
    if (args.listId) {
      await requireListAccessForAgent(ctx, args.listId, agent);
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", args.listId!))
        .collect();
    } else if (args.sprintId) {
      const sprint = await ctx.db.get(args.sprintId);
      if (!sprint) throw new ConvexError("Sprint not found");
      requireWorkspaceAccessForAgent(sprint.workspaceId, agent);
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_sprint", (q) => q.eq("sprintId", args.sprintId))
        .collect();
    } else {
      // Walk every list in the agent's scope.
      const spaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
        )
        .collect();
      for (const space of spaces) {
        const listParents: { type: "space" | "project"; id: string }[] = [
          { type: "space", id: space._id },
        ];
        const projects = await ctx.db
          .query("projects")
          .withIndex("by_space", (q) => q.eq("spaceId", space._id))
          .collect();
        for (const f of projects) listParents.push({ type: "project", id: f._id });
        for (const p of listParents) {
          const lists = await ctx.db
            .query("lists")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", p.type).eq("parentId", p.id),
            )
            .collect();
          for (const l of lists) {
            if (!agentCanTouchList(agent, l._id)) continue;
            const ts = await ctx.db
              .query("tasks")
              .withIndex("by_list", (q) => q.eq("listId", l._id))
              .collect();
            tasks.push(...ts);
          }
        }
      }
    }

    tasks = tasks.filter((t) => agentCanTouchList(agent, t.listId));
    if (args.assignedToMe) {
      tasks = tasks.filter((t) => t.assigneeClerkIds.includes(agent._id));
    }
    // Same order humans see: the list's manual ordering (position), stable
    // across lists when the scope-wide walk mixes several.
    tasks.sort(
      (a, b) =>
        a.listId.localeCompare(b.listId) ||
        a.position - b.position ||
        a.createdAt - b.createdAt,
    );
    const max = Math.min(args.limit ?? 100, 500);
    const views: (Awaited<ReturnType<typeof taskView>> & {
      descriptionTruncated?: boolean;
    })[] = [];
    for (const t of tasks) {
      if (views.length >= max) break;
      const view = await taskView(ctx, t);
      if (
        !args.includeCompleted &&
        (view.status?.category === "complete" ||
          view.status?.category === "closed")
      ) {
        continue;
      }
      // Payload discipline: long descriptions are truncated in list reads;
      // get_task returns the full text.
      if (view.description !== undefined && view.description.length > 300) {
        views.push({
          ...view,
          description: view.description.slice(0, 300),
          descriptionTruncated: true,
        });
      } else {
        views.push(view);
      }
    }
    return views;
  },
});

export const getTask = query({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const view = await taskView(ctx, task);
    // Attached SOP (Phase L): when the task's list carries a sopSlug, the
    // procedure travels with the task read — the agent gets "how we do
    // this here" without a second lookup.
    let sop: { slug: string; name: string; content: string } | undefined;
    const taskList = await ctx.db.get(task.listId);
    if (taskList?.sopSlug) {
      const skills = await skillsForScope(
        ctx,
        agent.parentType,
        agent.parentId,
      );
      const match = skills.find(
        (s) => s.slug === taskList.sopSlug && s.enabled,
      );
      if (match) {
        sop = { slug: match.slug, name: match.name, content: match.content };
      }
    }
    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", taskId))
      .collect();
    const comments = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "task").eq("parentId", taskId),
      )
      .collect();
    const fieldValues = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    // Custom fields travel with the deep read, resolved (option labels,
    // money currency, vote counts) and including the computed types that
    // have no stored row. get_task_fields returns the same shape alone.
    const customFieldDefs = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    const fieldRowsById = new Map(
      fieldValues.map((r) => [r.fieldId as string, r]),
    );
    const derived = new Map(
      (
        await computeDerivedValues(ctx, task, customFieldDefs, fieldValues)
      ).map((c) => [c.fieldId as string, c.value]),
    );
    const customFields = customFieldDefs
      .sort((a, b) => a.position - b.position)
      .map((f) =>
        fieldValueSummary(f, fieldRowsById.get(f._id), derived.get(f._id)),
      );
    const attachmentRows = await ctx.db
      .query("attachments")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    const attachments = await Promise.all(
      attachmentRows
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (a) => ({
          attachmentId: a._id,
          name: a.name,
          size: a.sizeBytes,
          contentType: a.mimeType,
          url: await ctx.storage.getUrl(a.storageId),
        })),
    );
    const contextPackets = await listPacketsForTask(ctx, taskId);
    const contextReadiness = await contextReadinessForAgent(
      ctx,
      taskId,
      agent._id,
    );
    const decisions = await decisionRowsForTask(ctx, taskId);
    return {
      ...view,
      listName: taskList?.name ?? null,
      attachments,
      contextPackets,
      contextReadiness,
      decisions,
      sop,
      customFields,
      // Raw rows kept for backwards compatibility with existing agents.
      fieldValues: fieldValues.map((fv) => ({
        fieldId: fv.fieldId,
        textValue: fv.textValue,
        numberValue: fv.numberValue,
        booleanValue: fv.booleanValue,
        dateValue: fv.dateValue,
        currency: fv.currency,
        optionIds: fv.optionIds,
        actorIds: fv.actorIds,
        taskIds: fv.taskIds,
        location: fv.location,
        files: fv.files,
      })),
      subtasks: await Promise.all(subtasks.map((s) => taskView(ctx, s))),
      comments: comments
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-50)
        .map((m) => ({
          messageId: m._id,
          authorId: m.authorClerkId,
          body: m.body,
          createdAt: m.createdAt,
          parentMessageId: m.parentMessageId,
          resolvedAt: m.resolvedAt,
        })),
      // Corrections still outstanding on this task. They ride the read an
      // agent already makes, so there is no version of "I didn't know a change
      // was requested" that involves the agent forgetting to check.
      openRevisions: openOnly(
        await revisionsForParent(ctx, "task", taskId),
      ).map((r) => ({
        revisionId: r._id,
        body: r.body,
        requestedBy: r.requestedByName,
        requestedAt: r.createdAt,
      })),
      // The project's pinned pages, as markdown. Same reasoning as the rest
      // of this payload: "read the brief first" should not depend on the
      // agent choosing to. Pinning is what a person does to say "this is the
      // canonical context", and this is where that promise is kept.
      context: await pinnedContextForList(ctx, task.listId),
    };
  },
});

/**
 * The pages pinned to a project, as markdown, oldest first.
 *
 * Clipped per page: an agent's context window is finite, and silently
 * truncating the whole payload would drop the last page entirely rather than
 * trimming each one.
 */
async function pinnedContextForList(
  ctx: QueryCtx,
  listId: Id<"lists">,
): Promise<{ pageId: Id<"pages">; title: string; text: string }[]> {
  const attachments = await ctx.db
    .query("pageAttachments")
    .withIndex("by_target", (q) =>
      q.eq("targetType", "list").eq("targetId", listId),
    )
    .collect();
  const out: {
    pageId: Id<"pages">;
    title: string;
    text: string;
    createdAt: number;
  }[] = [];
  for (const att of attachments) {
    if (att.pinned !== true) continue;
    const page = await ctx.db.get(att.pageId);
    if (!page || page.archivedAt !== undefined) continue;
    out.push({
      pageId: page._id,
      title: page.title,
      text: clipText(page.markdown, 8000),
      createdAt: att.createdAt,
    });
  }
  return out
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ pageId, title, text }) => ({ pageId, title, text }));
}

// ── Shared project context ─────────────────────────────────────────────

export const listContextPackets = query({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
  },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const packets = await ctx.db
      .query("contextPackets")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return packets
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((packet) => ({
        packetId: packet._id,
        listId: packet.listId,
        title: packet.title,
        summary: packet.summary,
        version: packet.version,
        updatedAt: packet.updatedAt,
      }));
  },
});

export const getContextPacket = query({
  args: { apiKey: v.string(), packetId: v.id("contextPackets") },
  handler: async (ctx, { apiKey, packetId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const packet = await ctx.db.get(packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    await requireListAccessForAgent(ctx, packet.listId, agent);
    return {
      packetId: packet._id,
      listId: packet.listId,
      title: packet.title,
      summary: packet.summary,
      content: packet.content,
      version: packet.version,
      createdByActorId: packet.createdByActorId,
      createdAt: packet.createdAt,
      updatedByActorId: packet.updatedByActorId,
      updatedAt: packet.updatedAt,
    };
  },
});

export const createContextPacket = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    title: v.string(),
    summary: v.optional(v.string()),
    content: v.string(),
    taskIds: v.optional(v.array(v.id("tasks"))),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    const actor = agentActor(agent);
    const packetId = await createContextPacketCore(ctx, list, args, actor);
    const packet = (await ctx.db.get(packetId))!;
    for (const taskId of args.taskIds ?? []) {
      const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
      await attachContextPacketCore(ctx, packet, task, actor);
    }
    return { packetId, version: 1 };
  },
});

export const updateContextPacket = mutation({
  args: {
    apiKey: v.string(),
    packetId: v.id("contextPackets"),
    title: v.optional(v.string()),
    summary: v.optional(v.union(v.string(), v.null())),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const packet = await ctx.db.get(args.packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    const { list } = await requireListAccessForAgent(ctx, packet.listId, agent);
    const version = await updateContextPacketCore(
      ctx,
      packet,
      list,
      args,
      agentActor(agent),
    );
    return { version };
  },
});

export const acknowledgeTaskContext = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    packets: v.array(
      v.object({
        packetId: v.id("contextPackets"),
        version: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const { task } = await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const readiness = await acknowledgeTaskContextCore(
      ctx,
      task._id,
      agent._id,
      args.packets,
    );
    const list = await ctx.db.get(task.listId);
    const scope = list ? await scopeForList(ctx, list) : null;
    if (scope) {
      await emitEvent(ctx, {
        ...scope,
        type: "context.acknowledged",
        actor: agentActor(agent),
        entityType: "task",
        entityId: task._id,
        entityTitle: task.title,
        listId: task.listId,
        payload: {
          packetVersions: args.packets.map((packet) => ({
            packetId: packet.packetId,
            version: packet.version,
          })),
        },
      });
    }
    return readiness;
  },
});

export const deleteContextPacket = mutation({
  args: {
    apiKey: v.string(),
    packetId: v.id("contextPackets"),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const packet = await ctx.db.get(args.packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    const { list } = await requireListAccessForAgent(ctx, packet.listId, agent);
    const detachedTaskCount = await deleteContextPacketCore(
      ctx,
      packet,
      list,
      agentActor(agent),
    );
    return { deleted: true, detachedTaskCount };
  },
});

export const attachContextPacket = mutation({
  args: {
    apiKey: v.string(),
    packetId: v.id("contextPackets"),
    taskIds: v.array(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (args.taskIds.length > 100) {
      throw new ConvexError("Attach context to at most 100 tasks per call");
    }
    const packet = await ctx.db.get(args.packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    await requireListAccessForAgent(ctx, packet.listId, agent);
    let attached = 0;
    for (const taskId of args.taskIds) {
      const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
      if (
        await attachContextPacketCore(ctx, packet, task, agentActor(agent))
      ) {
        attached += 1;
      }
    }
    return { attached };
  },
});

export const detachContextPacket = mutation({
  args: {
    apiKey: v.string(),
    packetId: v.id("contextPackets"),
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const packet = await ctx.db.get(args.packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    const { task } = await requireTaskAccessForAgent(ctx, args.taskId, agent);
    if (task.listId !== packet.listId) {
      throw new ConvexError("Context packet and task belong to different projects");
    }
    return {
      detached: await detachContextPacketCore(
        ctx,
        packet._id,
        task._id,
      ),
    };
  },
});

// ── Versioned operating decisions ─────────────────────────────────────

export const listDecisionsForTask = query({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    return await decisionRowsForTask(ctx, args.taskId);
  },
});

export const createDecision = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    key: v.string(),
    title: v.string(),
    statement: v.string(),
    rationale: v.string(),
    contextPacketId: v.optional(v.id("contextPackets")),
    taskIds: v.array(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    const decision = await createDecisionCore(
      ctx,
      list,
      args,
      agentActor(agent),
    );
    return { decisionId: decision._id, version: decision.version };
  },
});

export const supersedeDecision = mutation({
  args: {
    apiKey: v.string(),
    decisionId: v.id("decisions"),
    title: v.optional(v.string()),
    statement: v.string(),
    rationale: v.string(),
    taskIds: v.optional(v.array(v.id("tasks"))),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const current = await ctx.db.get(args.decisionId);
    if (!current) throw new ConvexError("Decision not found");
    const { list } = await requireListAccessForAgent(
      ctx,
      current.listId,
      agent,
    );
    const decision = await supersedeDecisionCore(
      ctx,
      current,
      list,
      args,
      agentActor(agent),
    );
    return { decisionId: decision._id, version: decision.version };
  },
});

export const assessDecisionImpact = mutation({
  args: {
    apiKey: v.string(),
    impactId: v.id("decisionImpacts"),
    status: v.union(
      v.literal("no_change"),
      v.literal("rework_required"),
      v.literal("resolved"),
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const impact = await ctx.db.get(args.impactId);
    if (!impact) throw new ConvexError("Decision impact not found");
    await requireTaskAccessForAgent(ctx, impact.taskId, agent);
    await assessDecisionImpactCore(
      ctx,
      impact,
      args.status,
      args.note,
      agentActor(agent),
    );
    return { status: args.status };
  },
});

export const createTask = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(priorityValidator),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assigneeIds: v.optional(v.array(v.string())),
    requiredCapabilities: v.optional(v.array(v.string())),
    parentTaskId: v.optional(v.id("tasks")),
    recurrence: v.optional(
      v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly")),
    ),
    sprintId: v.optional(v.id("sprints")),
    checklist: v.optional(checklistValidator),
    requiresApproval: v.optional(v.boolean()),
    estimatePoints: v.optional(v.number()),
    milestone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    const { apiKey: _apiKey, ...rest } = args;
    return await createTaskCore(ctx, rest, agentActor(agent));
  },
});

export const updateTask = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(priorityValidator),
    startDate: v.optional(v.union(v.number(), v.null())),
    dueDate: v.optional(v.union(v.number(), v.null())),
    assigneeIds: v.optional(v.array(v.string())),
    requiredCapabilities: v.optional(v.array(v.string())),
    recurrence: v.optional(
      v.union(
        v.literal("daily"),
        v.literal("weekly"),
        v.literal("monthly"),
        v.null(),
      ),
    ),
    sprintId: v.optional(v.union(v.id("sprints"), v.null())),
    blockedByTaskIds: v.optional(v.array(v.id("tasks"))),
    checklist: v.optional(checklistValidator),
    requiresApproval: v.optional(v.boolean()),
    estimatePoints: v.optional(v.union(v.number(), v.null())),
    milestone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    await markPresence(ctx, "task", args.taskId, agentActor(agent), {
      editing: true,
      detail: agent.statusText ?? undefined,
    });
    if (args.statusId) {
      const status = await ctx.db.get(args.statusId);
      if (
        status?.category === "complete" ||
        status?.category === "closed"
      ) {
        await requireTaskExecutionReady(ctx, args.taskId, agent._id);
      }
    }
    const { apiKey: _apiKey, ...rest } = args;
    await updateTaskCore(ctx, rest, agentActor(agent));
  },
});

// Thin wrapper for the common "just set the estimate" case, so agents don't
// need to round-trip the full updateTask shape for one field.
export const setEstimate = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    points: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { apiKey, taskId, points }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await updateTaskCore(
      ctx,
      { taskId, estimatePoints: points },
      agentActor(agent),
    );
  },
});

// Move the task to its list's first complete-category status.
export const completeTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    await requireTaskExecutionReady(ctx, taskId, agent._id);
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    const complete = statuses
      .sort((a, b) => a.position - b.position)
      .find((s) => s.category === "complete");
    if (!complete) {
      throw new ConvexError(
        "List has no complete status. Ask a human to add a Complete-category status in the list's settings.",
      );
    }
    await updateTaskCore(
      ctx,
      { taskId, statusId: complete._id },
      agentActor(agent),
    );
    if (agent.currentTaskId === taskId) {
      await ctx.db.patch(agent._id, {
        currentTaskId: undefined,
        statusText: undefined,
        lastSeenAt: Date.now(),
      });
    }
  },
});

export const deleteTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await removeTaskCore(ctx, taskId, agentActor(agent));
  },
});

export const claimTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const missing = missingCapabilities(
      agent.capabilities,
      task.requiredCapabilities,
    );
    if (missing.length > 0) {
      throw new ConvexError(
        `This task requires capabilities this agent does not advertise: ${missing.join(", ")}`,
      );
    }
    await requireTaskExecutionReady(ctx, taskId, agent._id);
    await claimTaskCore(ctx, taskId, agentActor(agent));
    await markExecutionAssignmentClaimed(ctx, taskId, agent._id);
    // Claiming is the clearest "I am working on this" there is, so it puts the
    // agent in the task's rail without waiting for a heartbeat.
    await markPresence(ctx, "task", taskId, agentActor(agent), {
      editing: true,
      detail: agent.statusText ?? undefined,
    });
  },
});

export const releaseTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await abandonExecutionAssignmentForTask(
      ctx,
      taskId,
      agent._id,
      "Released by assigned agent",
    );
    await releaseTaskCore(ctx, taskId, agentActor(agent));
    await clearActorPresence(ctx, "task", taskId, agent._id);
  },
});

export const setChecklist = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    items: checklistValidator,
  },
  handler: async (ctx, { apiKey, taskId, items }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await updateTaskCore(ctx, { taskId, checklist: items }, agentActor(agent));
  },
});

export const addDependency = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    blockedByTaskId: v.id("tasks"),
  },
  handler: async (ctx, { apiKey, taskId, blockedByTaskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    await requireTaskAccessForAgent(ctx, blockedByTaskId, agent);
    const current = task.blockedByTaskIds ?? [];
    if (current.includes(blockedByTaskId)) return;
    await updateTaskCore(
      ctx,
      { taskId, blockedByTaskIds: [...current, blockedByTaskId] },
      agentActor(agent),
    );
  },
});

export const removeDependency = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    blockedByTaskId: v.id("tasks"),
  },
  handler: async (ctx, { apiKey, taskId, blockedByTaskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const current = task.blockedByTaskIds ?? [];
    await updateTaskCore(
      ctx,
      {
        taskId,
        blockedByTaskIds: current.filter((id) => id !== blockedByTaskId),
      },
      agentActor(agent),
    );
  },
});

// ── Comments & mentions ────────────────────────────────────────────────

export const listComments = query({
  args: {
    apiKey: v.string(),
    parentType: v.union(
      v.literal("task"),
      v.literal("space"),
      v.literal("workspace"),
      v.literal("channel"),
    ),
    parentId: v.string(),
  },
  handler: async (ctx, { apiKey, parentType, parentId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireMessageParentAccessForAgent(ctx, parentType, parentId, agent);
    const all = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    // Newest 100, still in chronological order.
    return all
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-100)
      .map((m) => ({
        messageId: m._id,
        authorId: m.authorClerkId,
        body: m.body,
        parentMessageId: m.parentMessageId,
        assigneeId: m.assigneeClerkId,
        resolvedAt: m.resolvedAt,
        createdAt: m.createdAt,
      }));
  },
});

export const addComment = mutation({
  args: {
    apiKey: v.string(),
    parentType: v.union(
      v.literal("task"),
      v.literal("space"),
      v.literal("workspace"),
      v.literal("channel"),
    ),
    parentId: v.string(),
    body: v.string(),
    parentMessageId: v.optional(v.id("messages")),
    mentionIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireMessageParentAccessForAgent(
      ctx,
      args.parentType,
      args.parentId,
      agent,
    );
    const workspaceId = await workspaceIdForMessageParent(
      ctx,
      args.parentType,
      args.parentId,
    );
    return await createMessageCore(
      ctx,
      {
        parentType: args.parentType,
        parentId: args.parentId,
        body: args.body,
        parentMessageId: args.parentMessageId,
        mentionIds: args.mentionIds,
      },
      agentActor(agent),
      workspaceId,
    );
  },
});

// The agent's inbox: everywhere it has been @mentioned.
export const listMyMentions = query({
  args: { apiKey: v.string(), unreadOnly: v.optional(v.boolean()) },
  handler: async (ctx, { apiKey, unreadOnly }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_user", (q) => q.eq("mentionedClerkId", agent._id))
      .collect();
    const out = [];
    for (const m of mentions.sort((a, b) => b.createdAt - a.createdAt)) {
      if (unreadOnly && m.readAt !== undefined) continue;
      // A page mention has no message behind it — the tag lives in the
      // page's markdown and the snippet was captured when it was written.
      const message = m.messageId ? await ctx.db.get(m.messageId) : null;
      out.push({
        mentionId: m._id,
        parentType: m.parentType,
        parentId: m.parentId,
        body: message?.body ?? m.snippet ?? "",
        authorId: message?.authorClerkId,
        authorName: message ? undefined : m.byName,
        readAt: m.readAt,
        createdAt: m.createdAt,
      });
    }
    return out.slice(0, 100);
  },
});

export const markMentionRead = mutation({
  args: { apiKey: v.string(), mentionId: v.id("mentions") },
  handler: async (ctx, { apiKey, mentionId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "presence");
    const mention = await ctx.db.get(mentionId);
    if (!mention || mention.mentionedClerkId !== agent._id) {
      throw new ConvexError("Mention not found or it doesn't belong to you");
    }
    await ctx.db.patch(mentionId, { readAt: Date.now() });
  },
});

// ── Members & agents in scope ──────────────────────────────────────────

export const listMembers = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const members: {
      id: string;
      name: string;
      kind: "user" | "agent";
      statusText?: string;
      lastSeenAt?: number;
      lastConnectedAt?: number;
      lastHeartbeatAt?: number;
      capabilities?: string[];
      maxConcurrentTasks?: number;
      role?: "member" | "readonly";
      status?: "active" | "paused";
      currentTaskId?: Id<"tasks">;
    }[] = [];
    if (agent.parentType === "user") {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", agent.parentId))
        .unique();
      if (user) {
        members.push({
          id: user.clerkId,
          name: user.name ?? user.email,
          kind: "user",
        });
      }
    } else {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", agent.parentId as Id<"workspaces">),
        )
        .collect();
      for (const m of memberships) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        if (user) {
          members.push({
            id: user.clerkId,
            name: user.name ?? user.email,
            kind: "user",
          });
        }
      }
    }
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const a of agents) {
      members.push({
        id: a._id,
        name: a.name,
        kind: "agent",
        statusText: a.statusText,
        lastSeenAt: a.lastSeenAt,
        lastConnectedAt: a.lastConnectedAt,
        lastHeartbeatAt: a.lastHeartbeatAt,
        capabilities: a.capabilities ?? [],
        maxConcurrentTasks: a.maxConcurrentTasks ?? 1,
        role: a.role ?? "member",
        status: a.status,
        currentTaskId: a.currentTaskId,
      });
    }
    return members;
  },
});

// ── Sprints ────────────────────────────────────────────────────────────

function requireWorkspaceAgent(agent: Doc<"agents">): Id<"workspaces"> {
  if (agent.parentType !== "workspace") {
    throw new ConvexError("Sprints require a workspace-scoped agent");
  }
  return agent.parentId as Id<"workspaces">;
}

export const createSprint = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    goal: v.optional(v.string()),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const workspaceId = requireWorkspaceAgent(agent);
    return await createSprintCore(
      ctx,
      {
        workspaceId,
        name: args.name,
        goal: args.goal,
        startDate: args.startDate,
        endDate: args.endDate,
      },
      agentActor(agent),
    );
  },
});

export const listSprints = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const workspaceId = requireWorkspaceAgent(agent);
    const sprints = await ctx.db
      .query("sprints")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return sprints.sort((a, b) => b.startDate - a.startDate).map(sprintView);
  },
});

export const updateSprint = mutation({
  args: {
    apiKey: v.string(),
    sprintId: v.id("sprints"),
    name: v.optional(v.string()),
    goal: v.optional(v.string()),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("planned"),
        v.literal("active"),
        v.literal("complete"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(args.sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }
    const { apiKey: _apiKey, ...rest } = args;
    await updateSprintCore(ctx, rest, agentActor(agent));
  },
});

export const sprintSummary = query({
  args: { apiKey: v.string(), sprintId: v.id("sprints") },
  handler: async (ctx, { apiKey, sprintId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }
    return await sprintSummaryCore(ctx, sprintId);
  },
});

export const setSprintCapacity = mutation({
  args: {
    apiKey: v.string(),
    sprintId: v.id("sprints"),
    points: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { apiKey, sprintId, points }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }
    await updateSprintCore(
      ctx,
      { sprintId, capacityPoints: points },
      agentActor(agent),
    );
  },
});

export const setSprintRetrospective = mutation({
  args: { apiKey: v.string(), sprintId: v.id("sprints"), text: v.string() },
  handler: async (ctx, { apiKey, sprintId, text }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }
    await updateSprintCore(
      ctx,
      { sprintId, retrospective: text },
      agentActor(agent),
    );
  },
});

// Board data for one sprint: every task in it (respecting list
// restrictions) with enough detail to render/reason about a Kanban board —
// status, assignees, estimate, milestone flag, and how many open blockers
// stand in the way.
export const getSprintBoard = query({
  args: { apiKey: v.string(), sprintId: v.id("sprints") },
  handler: async (ctx, { apiKey, sprintId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
      .collect();
    const listNames = new Map<Id<"lists">, string>();
    const out = [];
    for (const t of tasks) {
      if (!agentCanTouchList(agent, t.listId)) continue;
      if (!listNames.has(t.listId)) {
        const list = await ctx.db.get(t.listId);
        listNames.set(t.listId, list?.name ?? "?");
      }
      const status = await ctx.db.get(t.statusId);
      out.push({
        taskId: t._id,
        title: t.title,
        listId: t.listId,
        listName: listNames.get(t.listId)!,
        status: status
          ? { statusId: status._id, name: status.name, category: status.category }
          : null,
        assigneeIds: t.assigneeClerkIds,
        estimatePoints: t.estimatePoints,
        milestone: t.milestone ?? false,
        openBlockerCount: await openBlockerCount(ctx, t),
      });
    }
    return { sprint: sprintView(sprint), tasks: out };
  },
});

// Planning view for one sprint: what's already committed (with a points
// total and how many committed tasks still need an estimate), plus a
// sample of open backlog work not yet pulled in, so an agent can propose
// what to add without walking the whole scope itself.
export const getSprintPlanning = query({
  args: { apiKey: v.string(), sprintId: v.id("sprints") },
  handler: async (ctx, { apiKey, sprintId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const workspaceId = requireWorkspaceAgent(agent);
    const sprint = await ctx.db.get(sprintId);
    if (!sprint || sprint.workspaceId !== workspaceId) {
      throw new ConvexError("Sprint not found");
    }

    const sprintTasks = await ctx.db
      .query("tasks")
      .withIndex("by_sprint", (q) => q.eq("sprintId", sprintId))
      .collect();
    let committedPoints = 0;
    let committedUnestimated = 0;
    const committed = [];
    for (const t of sprintTasks) {
      if (!agentCanTouchList(agent, t.listId)) continue;
      if (t.estimatePoints !== undefined) committedPoints += t.estimatePoints;
      else committedUnestimated++;
      const status = await ctx.db.get(t.statusId);
      committed.push({
        taskId: t._id,
        title: t.title,
        listId: t.listId,
        estimatePoints: t.estimatePoints,
        milestone: t.milestone ?? false,
        status: status
          ? { statusId: status._id, name: status.name, category: status.category }
          : null,
      });
    }

    const backlogSample: {
      taskId: Id<"tasks">;
      title: string;
      listId: Id<"lists">;
      estimatePoints: number | undefined;
      priority: "urgent" | "high" | "normal" | "low" | undefined;
    }[] = [];
    const lists = await listsInScope(ctx, agent);
    outer: for (const { list } of lists) {
      const listTasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      for (const t of listTasks) {
        if (t.sprintId === sprintId) continue;
        const status = await ctx.db.get(t.statusId);
        if (status?.category === "complete" || status?.category === "closed") {
          continue;
        }
        backlogSample.push({
          taskId: t._id,
          title: t.title,
          listId: t.listId,
          estimatePoints: t.estimatePoints,
          priority: t.priority,
        });
        if (backlogSample.length >= 100) break outer;
      }
    }

    return {
      sprint: {
        sprintId: sprint._id,
        name: sprint.name,
        goal: sprint.goal,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        status: sprint.status,
        capacityPoints: sprint.capacityPoints,
        retrospective: sprint.retrospective,
      },
      committedPoints,
      committedUnestimated,
      committed,
      backlogSample,
    };
  },
});

// ── Scheduled (time-based recurring) tasks ─────────────────────────────

export const createScheduledTask = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    assigneeIds: v.optional(v.array(v.string())),
    cadence: v.union(
      v.literal("hourly"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    dayOfWeek: v.optional(v.number()),
    dayOfMonth: v.optional(v.number()),
    hourUtc: v.optional(v.number()),
    dueInDays: v.optional(v.number()),
    blueprintId: v.optional(v.id("taskBlueprints")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    if (args.blueprintId) {
      const blueprint = await ctx.db.get(args.blueprintId);
      if (
        !blueprint ||
        blueprint.scopeType !== agent.parentType ||
        blueprint.scopeId !== agent.parentId
      ) {
        throw new ConvexError("Blueprint not found in your scope");
      }
    }
    const { apiKey: _apiKey, ...rest } = args;
    return await createScheduledTaskCore(ctx, rest, agentActor(agent));
  },
});

export const listScheduledTasks = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const rows = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return rows.map((st) => ({
      scheduledTaskId: st._id,
      listId: st.listId,
      title: st.title,
      description: st.description,
      priority: st.priority,
      assigneeIds: st.assigneeIds,
      cadence: st.cadence,
      dayOfWeek: st.dayOfWeek,
      dayOfMonth: st.dayOfMonth,
      hourUtc: st.hourUtc,
      dueInDays: st.dueInDays,
      nextRunAt: st.nextRunAt,
      lastRunAt: st.lastRunAt,
      lastError: st.lastError,
      lastErrorAt: st.lastErrorAt,
      consecutiveFailures: st.consecutiveFailures ?? 0,
      enabled: st.enabled,
      blueprintId: st.blueprintId,
      createdByActorId: st.createdByActorId,
      createdAt: st.createdAt,
    }));
  },
});

export const updateScheduledTask = mutation({
  args: {
    apiKey: v.string(),
    scheduledTaskId: v.id("scheduledTasks"),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, { apiKey, scheduledTaskId, enabled }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const st = await ctx.db.get(scheduledTaskId);
    if (!st) throw new ConvexError("Scheduled task not found");
    await requireListAccessForAgent(ctx, st.listId, agent);
    if (enabled !== undefined) {
      await ctx.db.patch(scheduledTaskId, {
        enabled,
        ...(enabled
          ? {
              lastError: undefined,
              lastErrorAt: undefined,
              consecutiveFailures: 0,
              nextRunAt: computeNextRunAt(
                Date.now(),
                st.cadence,
                st.hourUtc,
                st.dayOfWeek,
                st.dayOfMonth,
              ),
            }
          : {}),
      });
    }
  },
});

export const deleteScheduledTask = mutation({
  args: { apiKey: v.string(), scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, { apiKey, scheduledTaskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const st = await ctx.db.get(scheduledTaskId);
    if (!st) return;
    await requireListAccessForAgent(ctx, st.listId, agent);
    await ctx.db.delete(scheduledTaskId);
  },
});

// ── Webhooks (agent-registered hooks) ──────────────────────────────────

export const registerWebhook = mutation({
  args: {
    apiKey: v.string(),
    url: v.string(),
    eventTypes: v.optional(v.array(v.string())),
    listId: v.optional(v.id("lists")),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (args.listId) await requireListAccessForAgent(ctx, args.listId, agent);
    return await createSubscription(ctx, {
      ...scopeOf(agent),
      url: args.url,
      eventTypes: args.eventTypes ?? [],
      listId: args.listId,
      secret: args.secret,
      ownerType: "agent",
      ownerId: agent._id,
    });
  },
});

export const listWebhooks = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const subs = await ctx.db
      .query("webhookSubscriptions")
      .withIndex("by_owner", (q) =>
        q.eq("ownerType", "agent").eq("ownerId", agent._id),
      )
      .collect();
    return subs.map((s) => ({
      subscriptionId: s._id,
      url: s.url,
      eventTypes: s.eventTypes,
      listId: s.listId,
      scopeType: s.scopeType,
      scopeId: s.scopeId,
      enabled: s.enabled,
      failureCount: s.failureCount,
      disabledAt: s.disabledAt,
      createdAt: s.createdAt,
    }));
  },
});

export const deleteWebhook = mutation({
  args: { apiKey: v.string(), subscriptionId: v.id("webhookSubscriptions") },
  handler: async (ctx, { apiKey, subscriptionId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const sub = await ctx.db.get(subscriptionId);
    if (!sub) return;
    if (sub.ownerType !== "agent" || sub.ownerId !== agent._id) {
      throw new ConvexError(
        "You can only delete webhooks this agent registered itself. Call list_webhooks to see yours.",
      );
    }
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_subscription", (q) =>
        q.eq("subscriptionId", subscriptionId),
      )
      .collect();
    for (const d of deliveries) await ctx.db.delete(d._id);
    await ctx.db.delete(subscriptionId);
  },
});

// ── Events (cursor polling) ────────────────────────────────────────────

export const listEvents = query({
  args: {
    apiKey: v.string(),
    sinceCreatedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    const limit = Math.min(args.limit ?? 100, 200);
    const since = args.sinceCreatedAt ?? 0;
    const events = await ctx.db
      .query("events")
      .withIndex("by_scope", (q) =>
        q
          .eq("scopeType", agent.parentType)
          .eq("scopeId", agent.parentId)
          .gt("createdAt", since),
      )
      .take(limit);
    return events.map((e) => ({
      eventId: e._id,
      type: e.type,
      actorType: e.actorType,
      actorId: e.actorId,
      actorName: e.actorName,
      entityType: e.entityType,
      entityId: e.entityId,
      entityTitle: e.entityTitle,
      listId: e.listId,
      payload: e.payload,
      createdAt: e.createdAt,
    }));
  },
});

// ── Skills ─────────────────────────────────────────────────────────────

export const listSkills = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const skills = await skillsForScope(
      ctx,
      agent.parentType,
      agent.parentId,
    );
    return skills
      .filter((s) => s.enabled)
      .map(({ content: _content, _id: _rowId, ...rest }) => rest);
  },
});

export const getSkill = query({
  args: { apiKey: v.string(), slug: v.string() },
  handler: async (ctx, { apiKey, slug }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const skills = await skillsForScope(
      ctx,
      agent.parentType,
      agent.parentId,
    );
    const skill = skills.find((s) => s.slug === slug && s.enabled);
    if (!skill) return null;
    const { _id: _rowId, ...rest } = skill;
    return rest;
  },
});

export const createSkill = mutation({
  args: {
    apiKey: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const slug = args.slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) throw new ConvexError("Slug is required");
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    if (existing.some((s) => s.slug === slug)) {
      throw new ConvexError("A skill with this slug already exists");
    }
    return await ctx.db.insert("skills", {
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      slug,
      name: args.name,
      description: args.description,
      content: args.content,
      enabled: true,
      createdByActorId: agent._id,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

// ── Docs ───────────────────────────────────────────────────────────────

// ── Legacy doc adapters ────────────────────────────────────────────────
//
// Docs were folded into pages: one writing primitive, because two tools that
// both mean "write long-form context" gave an agent no rule for choosing and
// its output scattered across both. These four keep their names and their
// argument shapes so an existing agent prompt keeps working, and read/write
// pages underneath. New prompts should use list_pages / read_page /
// write_page, which speak markdown directly.

/** A page id, from either a page id or the id of a doc that became one. */
async function resolveLegacyPageId(
  ctx: QueryCtx | MutationCtx,
  id: string,
): Promise<Id<"pages"> | null> {
  const asPage = ctx.db.normalizeId("pages", id);
  if (asPage) return asPage;
  const asDoc = ctx.db.normalizeId("docs", id);
  if (!asDoc) return null;
  const doc = await ctx.db.get(asDoc);
  return doc?.migratedToPageId ?? null;
}

export const listDocs = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    return pages
      .filter((p) => p.archivedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        // Both keys, so a prompt written against either name still works.
        docId: p._id,
        pageId: p._id,
        title: p.title,
        updatedAt: p.updatedAt,
      }));
  },
});

export const getDoc = query({
  args: { apiKey: v.string(), docId: v.string() },
  handler: async (ctx, { apiKey, docId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const pageId = await resolveLegacyPageId(ctx, docId);
    if (!pageId) throw new ConvexError("Document not found");
    const page = await ctx.db.get(pageId);
    if (
      !page ||
      page.scopeType !== agent.parentType ||
      page.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Document not found in your scope");
    }
    return {
      docId: page._id,
      pageId: page._id,
      title: page.title,
      // Markdown is the stored form now, so this is the document, not a
      // flattening of it.
      text: page.markdown,
      updatedAt: page.updatedAt,
    };
  },
});

export const createDoc = mutation({
  args: { apiKey: v.string(), title: v.string(), text: v.optional(v.string()) },
  handler: async (ctx, { apiKey, title, text }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    const scope = scopeOf(agent);
    return await createPageCore(
      ctx,
      { scopeType: scope.scopeType, scopeId: scope.scopeId },
      { title, markdown: text ?? "" },
      agentActor(agent),
    );
  },
});

export const updateDoc = mutation({
  args: {
    apiKey: v.string(),
    docId: v.string(),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, docId, title, text }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const pageId = await resolveLegacyPageId(ctx, docId);
    if (!pageId) throw new ConvexError("Document not found");
    const page = await ctx.db.get(pageId);
    if (
      !page ||
      page.scopeType !== agent.parentType ||
      page.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Document not found in your scope");
    }
    await updatePageCore(
      ctx,
      page,
      { title, markdown: text },
      agentActor(agent),
    );
  },
});

// ── Keyword search (no AI required; semantic search is agentAi.search) ─

export const searchTasks = query({
  args: { apiKey: v.string(), query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    const needle = args.query.trim().toLowerCase();
    if (!needle) return [];
    const limit = Math.min(args.limit ?? 20, 50);
    // Reuse the scope walk from listTasks via the embeddings-free path:
    // walk lists and substring-match. Fine at target scale.
    const results: {
      taskId: Id<"tasks">;
      listId: Id<"lists">;
      title: string;
      statusId: Id<"listStatuses">;
      statusCategory: "open" | "in_progress" | "complete" | "closed";
      priority: "urgent" | "high" | "normal" | "low" | undefined;
      assigneeIds: string[];
      dueDate: number | undefined;
    }[] = [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    outer: for (const space of spaces) {
      const parents: { type: "space" | "project"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of projects) parents.push({ type: "project", id: f._id });
      for (const p of parents) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", p.type).eq("parentId", p.id),
          )
          .collect();
        for (const l of lists) {
          if (!agentCanTouchList(agent, l._id)) continue;
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", l._id))
            .collect();
          for (const t of tasks) {
            const hay = `${t.title}\n${t.description ?? ""}`.toLowerCase();
            if (hay.includes(needle)) {
              const status = await ctx.db.get(t.statusId);
              results.push({
                taskId: t._id,
                listId: l._id,
                title: t.title,
                statusId: t.statusId,
                statusCategory: status?.category ?? "open",
                priority: t.priority,
                assigneeIds: t.assigneeClerkIds,
                dueDate: t.dueDate,
              });
              if (results.length >= limit) break outer;
            }
          }
        }
      }
    }
    return results;
  },
});

// ── Internal: key validation for Node actions (semantic search) ────────

export const _validateKey = internalQuery({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    return {
      agentId: agent._id,
      scopeType: agent.parentType,
      scopeId: agent.parentId,
    };
  },
});

// Post-filter for semantic search (agentAi.search): the vector index only
// scopes by user/workspace, so list-restricted agents need their task hits
// narrowed to allowedListIds here. Doc hits pass through — restricted
// agents can read every doc in scope (mirrors listDocs/getDoc, which don't
// consult the allow-list).
export const _filterSearchHits = internalQuery({
  args: {
    apiKey: v.string(),
    hits: v.array(
      v.object({
        parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("page"),
    ),
        parentId: v.string(),
        textPreview: v.string(),
      }),
    ),
  },
  handler: async (ctx, { apiKey, hits }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    if (agent.allowedListIds === undefined) return hits;
    const out = [];
    for (const hit of hits) {
      if (hit.parentType === "doc") {
        out.push(hit);
        continue;
      }
      const taskId = ctx.db.normalizeId("tasks", hit.parentId);
      if (!taskId) continue;
      const task = await ctx.db.get(taskId);
      if (!task) continue;
      if (agentCanTouchList(agent, task.listId)) out.push(hit);
    }
    return out;
  },
});

// ── Dispatch: what should I work on next? ──────────────────────────────

// Priority-aware, dependency-aware picker: open tasks in scope that are
// unclaimed (or expired-claim) and unblocked, preferring the agent's own
// assignments, then unassigned work. Sorted urgent→low, then due date,
// then age.
export const nextTask = query({
  args: {
    apiKey: v.string(),
    includeUnassigned: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    const now = Date.now();
    const prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };

    // Tasks in an active sprint outrank backlog work of the same priority.
    const activeSprintIds = new Set<string>();
    if (agent.parentType === "workspace") {
      const sprints = await ctx.db
        .query("sprints")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", agent.parentId as Id<"workspaces">),
        )
        .collect();
      for (const sp of sprints) {
        if (sp.status === "active") activeSprintIds.add(sp._id);
      }
    }

    const candidates: {
      task: Doc<"tasks">;
      mine: boolean;
      inActiveSprint: boolean;
    }[] = [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const space of spaces) {
      const parents: { type: "space" | "project"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of projects) parents.push({ type: "project", id: f._id });
      for (const p of parents) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", p.type).eq("parentId", p.id),
          )
          .collect();
        for (const l of lists) {
          if (!agentCanTouchList(agent, l._id)) continue;
          const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_list", (q) => q.eq("listId", l._id))
            .collect();
          for (const t of tasks) {
            const status = await ctx.db.get(t.statusId);
            if (
              status?.category === "complete" ||
              status?.category === "closed"
            ) {
              continue;
            }
            // Claimed and fresh → someone else's work.
            if (
              t.claimedByActorId !== undefined &&
              t.claimedByActorId !== agent._id &&
              t.claimedAt !== undefined &&
              now - t.claimedAt < CLAIM_TTL_MS
            ) {
              continue;
            }
            const mine = t.assigneeClerkIds.includes(agent._id);
            if (!mine) {
              if (args.includeUnassigned === false) continue;
              if (t.assigneeClerkIds.length > 0) continue; // someone else's
            }
            // Blocked?
            let blocked = false;
            for (const bid of t.blockedByTaskIds ?? []) {
              const blocker = await ctx.db.get(bid);
              if (!blocker) continue;
              const bs = await ctx.db.get(blocker.statusId);
              if (bs?.category !== "complete" && bs?.category !== "closed") {
                blocked = true;
                break;
              }
            }
            if (blocked) continue;
            if (!hasCapabilities(agent.capabilities, t.requiredCapabilities)) {
              continue;
            }
            candidates.push({
              task: t,
              mine,
              inActiveSprint:
                t.sprintId !== undefined && activeSprintIds.has(t.sprintId),
            });
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      if (a.inActiveSprint !== b.inActiveSprint) {
        return a.inActiveSprint ? -1 : 1;
      }
      const pa = prioRank[a.task.priority ?? "normal"];
      const pb = prioRank[b.task.priority ?? "normal"];
      if (pa !== pb) return pa - pb;
      const da = a.task.dueDate ?? Infinity;
      const db = b.task.dueDate ?? Infinity;
      if (da !== db) return da - db;
      return a.task.createdAt - b.task.createdAt;
    });

    const limit = Math.min(args.limit ?? 1, 10);
    const out = [];
    for (const c of candidates.slice(0, limit)) {
      out.push(await taskView(ctx, c.task));
    }
    return out;
  },
});

// Hand a task to another member or agent with a context note. Reassigns,
// releases my claim, posts the note as a comment mentioning the
// recipient, and emits task.handoff.
export const handoffTask = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    toId: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    // Recipient must be a member or agent in this scope.
    const targetAgentId = ctx.db.normalizeId("agents", args.toId);
    if (targetAgentId) {
      const target = await ctx.db.get(targetAgentId);
      if (
        !target ||
        target.parentType !== agent.parentType ||
        target.parentId !== agent.parentId
      ) {
        throw new ConvexError("Recipient is not in this scope");
      }
    } else if (agent.parentType === "workspace") {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", args.toId)
            .eq("workspaceId", agent.parentId as Id<"workspaces">),
        )
        .unique();
      if (!member) throw new ConvexError("Recipient is not in this scope");
    } else if (args.toId !== agent.parentId) {
      throw new ConvexError("Recipient is not in this scope");
    }
    await abandonExecutionAssignmentForTask(
      ctx,
      args.taskId,
      agent._id,
      `Handed off to ${args.toId}`,
    );
    await handoffTaskCore(
      ctx,
      args.taskId,
      args.toId,
      args.note,
      agentActor(agent),
    );
  },
});

// Signal "my work is done, a human needs to sign off": raises the gate if
// it isn't up, emits task.approval_requested, and emails a responsible
// human (a human assignee if any, else the task creator if human, else
// the workspace owner / personal-space owner).
export const requestApproval = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, args.taskId, agent);
    await requireTaskExecutionReady(ctx, args.taskId, agent._id);
    if (!task.requiresApproval) {
      await updateTaskCore(
        ctx,
        { taskId: args.taskId, requiresApproval: true },
        agentActor(agent),
      );
    }
    const updated = (await ctx.db.get(args.taskId))!;
    const list = await ctx.db.get(updated.listId);
    const scope = list ? await scopeForList(ctx, list) : null;
    if (scope) {
      await emitEvent(ctx, {
        ...scope,
        type: "task.approval_requested",
        actor: agentActor(agent),
        entityType: "task",
        entityId: updated._id,
        entityTitle: updated.title,
        listId: updated.listId,
        payload: { note: args.note?.slice(0, 500) },
      });
    }

    // Pick the human to email.
    const candidateIds: string[] = [
      ...updated.assigneeClerkIds,
      updated.createdByClerkId,
    ];
    if (agent.parentType === "workspace") {
      const ws = await ctx.db.get(agent.parentId as Id<"workspaces">);
      if (ws) candidateIds.push(ws.ownerClerkId);
    } else {
      candidateIds.push(agent.parentId);
    }
    for (const cid of candidateIds) {
      if (ctx.db.normalizeId("agents", cid)) continue; // skip agents
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", cid))
        .unique();
      if (user?.email) {
        await notify(ctx, {
          userClerkId: cid,
          type: "approval",
          title: `${agent.name} needs your approval`,
          body: updated.title,
          href: `/dashboard/l/${updated.listId}/t/${updated._id}`,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.notifications.sendApprovalEmail,
          {
            toEmail: user.email,
            toName: user.name,
            agentName: agent.name,
            taskTitle: updated.title,
            note: args.note?.slice(0, 500),
          },
        );
        break;
      }
    }
  },
});

// ── Runs & error reporting ─────────────────────────────────────────────

// Start a structured work session. Humans see it on the agent's detail
// page; finish it with finishRun when done.
export const startRun = mutation({
  args: {
    apiKey: v.string(),
    title: v.string(),
    taskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const title = args.title.trim();
    if (!title) throw new ConvexError("Run title is required");
    if (title.length > 200) {
      throw new ConvexError("Run title must be 200 characters or fewer");
    }
    if (args.taskId) {
      const { task } = await requireTaskAccessForAgent(
        ctx,
        args.taskId,
        agent,
      );
      await requireTaskExecutionReady(ctx, args.taskId, agent._id);
      if (
        task.claimedByActorId !== agent._id ||
        task.claimedAt === undefined ||
        Date.now() - task.claimedAt > CLAIM_TTL_MS
      ) {
        throw new ConvexError("Claim this task before starting a run");
      }
      const recentRuns = await ctx.db
        .query("agentRuns")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
        .order("desc")
        .take(20);
      if (
        recentRuns.some(
          (run) => run.taskId === args.taskId && run.status === "running",
        )
      ) {
        throw new ConvexError(
          "A run is already active for this agent and task",
        );
      }
    }
    const runId = await ctx.db.insert("agentRuns", {
      agentId: agent._id,
      taskId: args.taskId,
      title,
      status: "running",
      startedAt: Date.now(),
    });
    if (args.taskId) {
      const assignment = await markExecutionAssignmentRunning(
        ctx,
        args.taskId,
        agent._id,
        runId,
      );
      if (assignment) {
        await ctx.db.patch(runId, {
          executionAssignmentId: assignment._id,
        });
      }
    }
    return runId;
  },
});

/**
 * One event in a running run's live stream.
 *
 * The AG-UI insight, mapped onto this stack: an agent's run should be a typed
 * event stream the UI renders as it unfolds — steps starting and finishing,
 * a line of narration, structured state deltas — not two bookends with silence
 * between. Here the run *document* is the stream: Convex pushes every patch to
 * subscribers, so emitting is publishing, and there is no second transport to
 * authenticate or replay.
 *
 * Event types (their AG-UI ancestors in parens):
 *   step_started / step_finished / step_failed  (STEP_*)
 *   narration                                    (TEXT_MESSAGE_*, one line)
 *   state_snapshot / state_delta                 (STATE_SNAPSHOT / STATE_DELTA)
 *
 * Presence-classified: telling people what you are doing must never consume
 * the budget for doing it. The discipline is on granularity instead — steps
 * are chapters, narration is a sentence replaced in place, state is small.
 */
export const emitRunEvent = mutation({
  args: {
    apiKey: v.string(),
    runId: v.id("agentRuns"),
    type: v.union(
      v.literal("step_started"),
      v.literal("step_finished"),
      v.literal("step_failed"),
      v.literal("narration"),
      v.literal("state_snapshot"),
      v.literal("state_delta"),
    ),
    /** step_* events: which step, by stable key. */
    step: v.optional(
      v.object({
        key: v.string(),
        title: v.optional(v.string()),
        detail: v.optional(v.string()),
      }),
    ),
    /** narration: the sentence. */
    text: v.optional(v.string()),
    /** state_*: the object (snapshot replaces, delta shallow-merges). */
    state: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const run = await ctx.db.get(args.runId);
    // "Not found" for another agent's run, not "forbidden": a run id is an
    // enumerable handle and its existence is itself information.
    if (!run || run.agentId !== agent._id) {
      throw new ConvexError("Run not found");
    }
    if (run.status !== "running") {
      throw new ConvexError("This run has finished; start a new one");
    }
    const now = Date.now();

    if (args.type === "narration") {
      const text = (args.text ?? "").trim();
      if (!text) throw new ConvexError("Narration needs text");
      await ctx.db.patch(run._id, {
        lastNarration: text.slice(0, 280),
        narratedAt: now,
      });
      return { ok: true };
    }

    if (args.type === "state_snapshot" || args.type === "state_delta") {
      const incoming = args.state;
      if (
        incoming === null ||
        typeof incoming !== "object" ||
        Array.isArray(incoming)
      ) {
        throw new ConvexError("State must be a plain object");
      }
      let next: Record<string, unknown>;
      if (args.type === "state_snapshot") {
        next = incoming as Record<string, unknown>;
      } else {
        // Shallow merge; an explicit null deletes the key, which is how a
        // delta can retract without resending the world.
        next = { ...((run.liveState ?? {}) as Record<string, unknown>) };
        for (const [k, v2] of Object.entries(
          incoming as Record<string, unknown>,
        )) {
          if (v2 === null) delete next[k];
          else next[k] = v2;
        }
      }
      // Small on purpose: this is a dashboard's worth of numbers, not a data
      // channel. A cap the agent hits is a design smell it should hear about.
      if (JSON.stringify(next).length > 4000) {
        throw new ConvexError(
          "Live state is capped at ~4KB — keep it to what a person watches",
        );
      }
      await ctx.db.patch(run._id, { liveState: next });
      return { ok: true };
    }

    // step_* events.
    const key = args.step?.key.trim();
    if (!key) throw new ConvexError("Step events need step.key");
    const steps = [...(run.steps ?? [])];
    const at = steps.findIndex((s) => s.key === key);

    if (args.type === "step_started") {
      if (at >= 0) {
        // Idempotent re-start refreshes the label rather than duplicating the
        // chapter — retried calls are the normal case for an LLM runtime.
        steps[at] = {
          ...steps[at],
          title: args.step?.title?.slice(0, 120) ?? steps[at].title,
          detail: args.step?.detail?.slice(0, 200) ?? steps[at].detail,
          status: "running",
        };
      } else {
        if (steps.length >= 50) {
          throw new ConvexError(
            "A run tells its story in at most 50 steps — finish this one and start another",
          );
        }
        steps.push({
          key,
          title: args.step?.title?.slice(0, 120) ?? key,
          detail: args.step?.detail?.slice(0, 200),
          status: "running",
          startedAt: now,
        });
      }
    } else {
      if (at < 0) {
        throw new ConvexError(
          `No step "${key}" was started in this run — start it first`,
        );
      }
      steps[at] = {
        ...steps[at],
        status: args.type === "step_finished" ? "done" : "failed",
        detail: args.step?.detail?.slice(0, 200) ?? steps[at].detail,
        finishedAt: now,
      };
    }
    await ctx.db.patch(run._id, { steps });
    return { ok: true };
  },
});

export const finishRun = mutation({
  args: {
    apiKey: v.string(),
    runId: v.id("agentRuns"),
    status: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("abandoned"),
    ),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    links: v.optional(v.array(v.string())),
    tokensUsed: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    const run = await ctx.db.get(args.runId);
    if (!run || run.agentId !== agent._id) {
      throw new ConvexError("Run not found or it doesn't belong to you");
    }
    if (run.status !== "running") {
      if (run.status === args.status) {
        return { runId: run._id, status: run.status, replayed: true };
      }
      throw new ConvexError(
        `Run is already ${run.status}; terminal outcomes cannot be changed`,
      );
    }
    if (
      args.tokensUsed !== undefined &&
      (!Number.isFinite(args.tokensUsed) || args.tokensUsed < 0)
    ) {
      throw new ConvexError("tokensUsed must be a non-negative number");
    }
    if (
      args.costUsd !== undefined &&
      (!Number.isFinite(args.costUsd) || args.costUsd < 0)
    ) {
      throw new ConvexError("costUsd must be a non-negative number");
    }
    if ((args.links?.length ?? 0) > 20) {
      throw new ConvexError("links may contain at most 20 URLs");
    }
    for (const link of args.links ?? []) {
      let parsed: URL;
      try {
        parsed = new URL(link);
      } catch {
        throw new ConvexError(`Invalid evidence URL: ${link}`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ConvexError(`Evidence URL must use http or https: ${link}`);
      }
    }
    if (args.status === "succeeded" && run.taskId) {
      await requireTaskExecutionReady(ctx, run.taskId, agent._id);
    }
    await ctx.db.patch(args.runId, {
      status: args.status,
      summary: args.summary?.slice(0, 2000),
      error: args.error?.slice(0, 2000),
      links: args.links?.slice(0, 20),
      tokensUsed: args.tokensUsed,
      costUsd: args.costUsd,
      finishedAt: Date.now(),
    });
    if (run.executionAssignmentId) {
      await finishExecutionAssignment(
        ctx,
        run.executionAssignmentId,
        agent._id,
        {
          status: args.status,
          summary: args.summary,
          error: args.error,
          links: args.links,
        },
      );
    }
    if (
      args.status !== "succeeded" &&
      run.taskId
    ) {
      const task = await ctx.db.get(run.taskId);
      if (task?.claimedByActorId === agent._id) {
        await releaseTaskCore(ctx, run.taskId, agentActor(agent));
      }
      if (agent.currentTaskId === run.taskId) {
        await ctx.db.patch(agent._id, {
          currentTaskId: undefined,
          statusText: undefined,
        });
      }
    }
    if (args.status === "failed") {
      await emitEvent(ctx, {
        ...scopeOf(agent),
        type: "agent.error",
        actor: agentActor(agent),
        entityType: "agent",
        entityId: agent._id,
        entityTitle: agent.name,
        payload: {
          runTitle: run.title,
          error: args.error?.slice(0, 500),
          taskId: run.taskId,
        },
      });
    }
    return { runId: run._id, status: args.status, replayed: false };
  },
});

// Report a failure outside any run: recorded as an instant failed run and
// surfaced as an agent.error event so humans (and watching agents) see it.
export const reportError = mutation({
  args: {
    apiKey: v.string(),
    message: v.string(),
    taskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "presence");
    if (args.taskId) await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", {
      agentId: agent._id,
      taskId: args.taskId,
      title: "Error report",
      status: "failed",
      error: args.message.slice(0, 2000),
      startedAt: now,
      finishedAt: now,
    });
    if (args.taskId) {
      const assignment = await markExecutionAssignmentRunning(
        ctx,
        args.taskId,
        agent._id,
        runId,
      );
      if (assignment) {
        await ctx.db.patch(runId, {
          executionAssignmentId: assignment._id,
        });
        await finishExecutionAssignment(
          ctx,
          assignment._id,
          agent._id,
          { status: "failed", error: args.message },
        );
      }
      const task = await ctx.db.get(args.taskId);
      if (task?.claimedByActorId === agent._id) {
        await releaseTaskCore(ctx, args.taskId, agentActor(agent));
      }
      if (agent.currentTaskId === args.taskId) {
        await ctx.db.patch(agent._id, {
          currentTaskId: undefined,
          statusText: undefined,
        });
      }
    }
    await emitEvent(ctx, {
      ...scopeOf(agent),
      type: "agent.error",
      actor: agentActor(agent),
      entityType: "agent",
      entityId: agent._id,
      entityTitle: agent.name,
      payload: { error: args.message.slice(0, 500), taskId: args.taskId },
    });
  },
});

// ── Channels (agent↔agent topic threads) ───────────────────────────────

export const listChannels = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();

    // An agent needs the same answer the human rail needs: is there anything
    // here I haven't seen. Without it, "catch up on chat" means re-reading
    // every channel from the top on every wake.
    const reads = await ctx.db
      .query("channelReads")
      .withIndex("by_actor", (q) => q.eq("actorId", agent._id))
      .collect();
    const readAt = new Map(
      reads.map((r) => [r.channelId as string, r.lastReadAt]),
    );

    const out = [];
    for (const c of channels) {
      if (c.archivedAt !== undefined) continue;
      const since = readAt.get(c._id) ?? 0;
      let unread = 0;
      if ((c.lastMessageAt ?? 0) > since) {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "channel").eq("parentId", c._id),
          )
          .collect();
        unread = messages.filter(
          (m) => m.createdAt > since && m.authorClerkId !== agent._id,
        ).length;
      }
      out.push({
        channelId: c._id,
        name: c.name,
        topic: c.topic,
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        unread,
      });
    }
    out.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    return out;
  },
});

/**
 * One channel's transcript, with authors and references resolved.
 *
 * Distinct from list_comments because a channel read should also move the
 * agent's read cursor and hand back the structured `refs` — otherwise the
 * agent has to re-parse prose to learn which project is being discussed,
 * which is exactly what messages.refs exists to avoid.
 */
export const readChannel = query({
  args: {
    apiKey: v.string(),
    channelId: v.id("channels"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, channelId, limit }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const channel = await ctx.db.get(channelId);
    if (
      !channel ||
      channel.scopeType !== agent.parentType ||
      channel.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Channel not found in your scope");
    }
    const all = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "channel").eq("parentId", channelId),
      )
      .collect();
    const window = all
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-Math.min(limit ?? 100, 300));

    const messages = [];
    for (const m of window) {
      let authorName = "Someone";
      let authorIsAgent = false;
      const authorAgentId = ctx.db.normalizeId("agents", m.authorClerkId);
      if (authorAgentId) {
        const a = await ctx.db.get(authorAgentId);
        if (a) {
          authorName = a.name;
          authorIsAgent = true;
        }
      } else {
        const u = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.authorClerkId))
          .unique();
        if (u) authorName = u.name ?? u.email;
      }
      messages.push({
        messageId: m._id,
        body: m.body,
        authorId: m.authorClerkId,
        authorName,
        authorIsAgent,
        refs: m.refs ?? [],
        createdAt: m.createdAt,
      });
    }
    return {
      channelId: channel._id,
      name: channel.name,
      topic: channel.topic,
      messages,
      truncated: all.length > messages.length,
    };
  },
});

export const markChannelRead = mutation({
  args: { apiKey: v.string(), channelId: v.id("channels") },
  handler: async (ctx, { apiKey, channelId }) => {
    // "presence" rather than "write": catching up on reading is not a
    // metered action and must not consume an agent's daily budget.
    const { agent } = await requireAgentByKey(ctx, apiKey, "presence");
    const channel = await ctx.db.get(channelId);
    if (
      !channel ||
      channel.scopeType !== agent.parentType ||
      channel.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Channel not found in your scope");
    }
    await markChannelReadCore(ctx, channelId, agent._id);
    return null;
  },
});

export const setChannelTopic = mutation({
  args: {
    apiKey: v.string(),
    channelId: v.id("channels"),
    topic: v.string(),
  },
  handler: async (ctx, { apiKey, channelId, topic }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const channel = await ctx.db.get(channelId);
    if (
      !channel ||
      channel.scopeType !== agent.parentType ||
      channel.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Channel not found in your scope");
    }
    const trimmed = topic.trim().slice(0, 280);
    await ctx.db.patch(channelId, {
      topic: trimmed.length > 0 ? trimmed : undefined,
    });
    return null;
  },
});

/**
 * Everything an agent can point a `#[Label](kind:id)` reference at.
 *
 * Same set the human composer's `#` menu reads, so a person and an agent
 * writing about the same project produce the same token.
 */
export const referenceTargets = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const out: { kind: string; id: string; label: string; context?: string }[] =
      [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const space of spaces) {
      if (space.archivedAt !== undefined) continue;
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const project of projects) {
        if (project.archivedAt !== undefined) continue;
        out.push({
          kind: "project",
          id: project._id,
          label: project.name,
          context: space.name,
        });
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        for (const list of lists) {
          out.push({
            kind: "list",
            id: list._id,
            label: list.name,
            context: project.name,
          });
        }
      }
      const bare = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const list of bare) {
        out.push({
          kind: "list",
          id: list._id,
          label: list.name,
          context: space.name,
        });
      }
    }
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    for (const page of pages) {
      if (page.archivedAt !== undefined) continue;
      out.push({ kind: "page", id: page._id, label: page.title });
    }
    return out;
  },
});

// Create (or join — same name returns the existing id) a topic channel.
export const createChannel = mutation({
  args: { apiKey: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    return await createChannelCore(
      ctx,
      { ...scopeOf(agent), name: args.name },
      agentActor(agent),
    );
  },
});

// ── Time tracking ──────────────────────────────────────────────────────

export const logTime = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    durationMs: v.number(),
    description: v.optional(v.string()),
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    if (args.durationMs <= 0) throw new ConvexError("durationMs must be positive");
    const startedAt = args.startedAt ?? Date.now() - args.durationMs;
    return await ctx.db.insert("timeEntries", {
      taskId: args.taskId,
      userClerkId: agent._id,
      startedAt,
      endedAt: startedAt + args.durationMs,
      durationMs: args.durationMs,
      description: args.description,
      billable: false,
      createdAt: Date.now(),
    });
  },
});

export const listTimeEntries = query({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireTaskAccessForAgent(ctx, taskId, agent);
    const entries = await ctx.db
      .query("timeEntries")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    return entries
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => ({
        entryId: e._id,
        actorId: e.userClerkId,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
        description: e.description,
      }));
  },
});

// ── Goals ──────────────────────────────────────────────────────────────

export const listGoals = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const rows = await ctx.db
      .query("goals")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    // Same derived overlay humans see: a project-linked goal's progress and
    // status come from the linked list's rollup, so agents and humans can
    // never read different numbers for the same goal.
    const derived = await Promise.all(
      rows.map((g) => withDerivedProgress(ctx, g)),
    );
    return derived.map((g) => ({
      goalId: g._id,
      title: g.title,
      description: g.description,
      targetType: g.targetType,
      targetValue: g.targetValue,
      currentValue: g.currentValue,
      unit: g.unit,
      dueDate: g.dueDate,
      status: g.status,
      linked: g.linked,
      sourceListId: g.sourceListId,
      createdAt: g.createdAt,
    }));
  },
});

export const createGoal = mutation({
  args: {
    apiKey: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    targetType: v.union(
      v.literal("number"),
      v.literal("money"),
      v.literal("boolean"),
    ),
    targetValue: v.number(),
    unit: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    // Link the goal to a project (list) for auto-rollup: progress derives
    // live from that list's completed tasks — the same linked goals humans
    // create. Same guardrails as goals.create.
    sourceListId: v.optional(v.id("lists")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (args.sourceListId) {
      if (args.targetType !== "number") {
        throw new ConvexError("Only number goals can track a project");
      }
      const { list, space } = await requireListAccessForAgent(
        ctx,
        args.sourceListId,
        agent,
      );
      if (space.private) {
        // Goals are a shared surface — tracking a private-space project
        // would leak its live completion count to everyone in the scope.
        throw new ConvexError(
          "Projects in private spaces can't be tracked by a goal",
        );
      }
      const scope = await scopeForList(ctx, list);
      if (
        !scope ||
        scope.scopeType !== agent.parentType ||
        scope.scopeId !== agent.parentId
      ) {
        throw new ConvexError("Linked project must live in the goal's scope");
      }
    }
    return await ctx.db.insert("goals", {
      parentType: agent.parentType,
      parentId: agent.parentId,
      title: args.title,
      description: args.description,
      targetType: args.targetType,
      targetValue: args.targetType === "boolean" ? 1 : args.targetValue,
      currentValue: 0,
      unit: args.unit,
      dueDate: args.dueDate,
      sourceListId: args.sourceListId,
      status: "open",
      ownerClerkId: agent._id,
      createdAt: Date.now(),
    });
  },
});

export const setGoalProgress = mutation({
  args: {
    apiKey: v.string(),
    goalId: v.id("goals"),
    currentValue: v.number(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const goal = await ctx.db.get(args.goalId);
    if (
      !goal ||
      goal.parentType !== agent.parentType ||
      goal.parentId !== agent.parentId
    ) {
      throw new ConvexError("Goal not found");
    }
    // Same rule as the human mutation: a project-linked goal derives its
    // progress from the list — manual writes would silently diverge.
    if (goal.sourceListId) {
      throw new ConvexError(
        "This goal tracks a project automatically — its progress comes from completed tasks in the linked list. Complete tasks there instead (or ask a human to unlink the goal).",
      );
    }
    const complete =
      goal.status !== "abandoned" &&
      goal.targetValue > 0 &&
      args.currentValue >= goal.targetValue;
    await ctx.db.patch(args.goalId, {
      currentValue: args.currentValue,
      status:
        goal.status === "abandoned"
          ? "abandoned"
          : complete
            ? "complete"
            : "open",
      completedAt: complete ? Date.now() : undefined,
    });
    await emitEvent(ctx, {
      ...scopeOf(agent),
      type: complete ? "goal.completed" : "goal.progress",
      actor: agentActor(agent),
      entityType: "goal",
      entityId: args.goalId,
      entityTitle: goal.title,
      payload: { currentValue: args.currentValue, targetValue: goal.targetValue },
    });
  },
});

// ── List automations ───────────────────────────────────────────────────

const automationActionValidator = v.union(
  v.object({ kind: v.literal("assign_user"), clerkId: v.string() }),
  v.object({ kind: v.literal("set_priority"), priority: priorityValidator }),
  v.object({ kind: v.literal("set_status"), statusId: v.id("listStatuses") }),
  v.object({ kind: v.literal("set_due_in_days"), days: v.number() }),
);

export const listAutomationsForList = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const rows = await ctx.db
      .query("listAutomations")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return rows.map((a) => ({
      automationId: a._id,
      listId: a.listId,
      trigger: a.trigger,
      action: a.action,
      enabled: a.enabled,
      createdAt: a.createdAt,
    }));
  },
});

export const createAutomation = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    trigger: v.union(
      v.literal("task_created"),
      v.literal("status_changed_to_complete"),
    ),
    action: automationActionValidator,
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    return await ctx.db.insert("listAutomations", {
      listId: args.listId,
      trigger: args.trigger,
      action: args.action,
      enabled: true,
      createdAt: Date.now(),
    });
  },
});

export const deleteAutomation = mutation({
  args: { apiKey: v.string(), automationId: v.id("listAutomations") },
  handler: async (ctx, { apiKey, automationId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const auto = await ctx.db.get(automationId);
    if (!auto) return;
    await requireListAccessForAgent(ctx, auto.listId, agent);
    await ctx.db.delete(automationId);
  },
});

// ── Sprint templates ───────────────────────────────────────────────────
// The built-in sprint playbooks (convex/sprintTemplates.ts): a timebox with
// its ceremonies and starter tasks. Sprints are workspace-level objects, so
// both ends are workspace-only — a personal-scope agent is refused with the
// same message create_sprint gives, rather than being handed a catalog it
// could never apply.

export const listSprintTemplates = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    requireWorkspaceAgent(agent);
    return sprintTemplateCatalog();
  },
});

export const applySprintTemplate = mutation({
  args: {
    apiKey: v.string(),
    slug: v.string(),
    startDate: v.number(),
    listId: v.optional(v.id("lists")),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    // Creating a sprint reshapes the workspace, so it's structure-level —
    // the same gate create_sprint uses.
    requireUnrestricted(agent);
    const workspaceId = requireWorkspaceAgent(agent);
    // Workspace membership doesn't imply access to every list (private
    // spaces), and an allow-listed agent must not seed tasks outside its
    // lists — so the destination is checked on its own terms.
    if (args.listId !== undefined) {
      await requireListAccessForAgent(ctx, args.listId, agent);
    }
    return await applySprintTemplateCore(
      ctx,
      {
        workspaceId,
        slug: args.slug,
        startDate: args.startDate,
        listId: args.listId,
        name: args.name,
      },
      agentActor(agent),
    );
  },
});

// ── Template Center ────────────────────────────────────────────────────
// The full catalog (convex/templateCatalog.ts) across five entity types —
// list, task, doc, whiteboard, and saved view — applied through the same
// cores the human Template Center calls.

/** The destination shape each entity type accepts. */
const TEMPLATE_DESTINATIONS: Record<string, ("space" | "project" | "list")[]> = {
  list: ["space", "project"],
  task: ["list"],
  doc: ["space"],
  whiteboard: ["space"],
  view: ["list"],
};

export const listCatalogTemplates = query({
  args: {
    apiKey: v.string(),
    entityType: v.optional(v.string()),
    category: v.optional(v.string()),
    useCase: v.optional(v.string()),
    complexity: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAgentByKey(ctx, args.apiKey);
    const catalog = templateCenterCatalog();
    const needle = args.search?.trim().toLowerCase();
    const templates = catalog.templates.filter(
      (t) =>
        (args.entityType === undefined || t.entityType === args.entityType) &&
        (args.category === undefined || t.category === args.category) &&
        (args.complexity === undefined || t.complexity === args.complexity) &&
        (args.useCase === undefined || t.useCases.includes(args.useCase)) &&
        (needle === undefined ||
          needle === "" ||
          `${t.slug} ${t.name} ${t.description} ${t.useCases.join(" ")}`
            .toLowerCase()
            .includes(needle)),
    );
    return {
      templates,
      matched: templates.length,
      total: catalog.templates.length,
      // The filter vocabulary, so an agent can narrow down without guessing.
      facets: {
        entityTypes: catalog.entityTypes,
        categories: catalog.categories,
        complexities: catalog.complexities,
        useCases: catalog.useCases,
      },
    };
  },
});

export const getCatalogTemplate = query({
  args: { apiKey: v.string(), slug: v.string() },
  handler: async (ctx, { apiKey, slug }) => {
    await requireAgentByKey(ctx, apiKey);
    const template = findTemplate(slug);
    if (!template) {
      throw new ConvexError(
        `Unknown template "${slug}". Call list_templates for the available slugs.`,
      );
    }
    return {
      summary: summarizeTemplate(template),
      // Everything the template will actually create, verbatim.
      template,
      // What apply_template's destinationType must be for this entity type.
      destinationTypes: TEMPLATE_DESTINATIONS[template.entityType],
    };
  },
});

export const applyCatalogTemplate = mutation({
  args: {
    apiKey: v.string(),
    slug: v.string(),
    name: v.optional(v.string()),
    destinationType: v.union(
      v.literal("space"),
      v.literal("project"),
      v.literal("list"),
    ),
    destinationId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    entityType: "list" | "task" | "doc" | "whiteboard" | "view";
    id: string;
    name: string;
  }> => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    // Applying a template creates structure (lists, statuses, fields, docs,
    // boards), so it's off-limits to list-restricted agents — same posture
    // as create_list and the starter-template tool.
    requireUnrestricted(agent);

    const template = findTemplate(args.slug);
    if (!template) {
      throw new ConvexError(
        `Unknown template "${args.slug}". Call list_templates for the available slugs.`,
      );
    }
    if (
      !TEMPLATE_DESTINATIONS[template.entityType].includes(args.destinationType)
    ) {
      throw new ConvexError(
        `A ${template.entityType} template can't be applied to a ${args.destinationType} — send destinationType "${TEMPLATE_DESTINATIONS[template.entityType].join('" or "')}".`,
      );
    }

    // Authorization resolves up the hierarchy exactly as every other agent
    // write does.
    if (args.destinationType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.destinationId as Id<"spaces">,
        agent,
      );
    } else if (args.destinationType === "project") {
      await requireProjectAccessForAgent(
        ctx,
        args.destinationId as Id<"projects">,
        agent,
      );
    } else {
      await requireListAccessForAgent(
        ctx,
        args.destinationId as Id<"lists">,
        agent,
      );
    }

    const actor = agentActor(agent);

    if (template.entityType === "list") {
      const id = await applyCatalogListTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          parentType: args.destinationType === "space" ? "space" : "project",
          parentId: args.destinationId,
        },
        actor,
      );
      return {
        entityType: "list",
        id,
        name: args.name?.trim() || template.name,
      };
    }

    if (template.entityType === "task") {
      const id = await applyCatalogTaskTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          listId: args.destinationId as Id<"lists">,
        },
        actor,
      );
      return {
        entityType: "task",
        id,
        name: args.name?.trim() || template.task.title,
      };
    }

    if (template.entityType === "doc") {
      const id = await applyCatalogDocTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          parentType: "space",
          parentId: args.destinationId,
        },
        agent._id,
      );
      return {
        entityType: "doc",
        id,
        name: args.name?.trim() || template.doc.title,
      };
    }

    if (template.entityType === "whiteboard") {
      const id = await applyCatalogWhiteboardTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          parentType: "space",
          parentId: args.destinationId,
        },
        agent._id,
      );
      return {
        entityType: "whiteboard",
        id,
        name: args.name?.trim() || template.whiteboard.title,
      };
    }

    const id = await applyCatalogViewTemplateCore(
      ctx,
      {
        slug: args.slug,
        name: args.name,
        listId: args.destinationId as Id<"lists">,
      },
      agent._id,
    );
    return {
      entityType: "view",
      id,
      name: args.name?.trim() || template.view.name,
    };
  },
});

// ── Starter list templates (the four built-in list presets) ────────────

export const listTemplates = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    await requireAgentByKey(ctx, apiKey);
    return templateCatalog();
  },
});

export const applyTemplate = mutation({
  args: {
    apiKey: v.string(),
    templateId: v.string(),
    name: v.string(),
    parentType: v.union(v.literal("space"), v.literal("project")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (args.parentType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.parentId as Id<"spaces">,
        agent,
      );
    } else {
      const project = await ctx.db.get(args.parentId as Id<"projects">);
      if (!project) throw new ConvexError("Project not found");
      await requireSpaceAccessForAgent(ctx, project.spaceId, agent);
    }
    return await applyListTemplateCore(
      ctx,
      {
        templateId: args.templateId,
        name: args.name,
        parentType: args.parentType,
        parentId: args.parentId,
      },
      agent._id,
    );
  },
});

// ── Custom fields ──────────────────────────────────────────────────────

export const listCustomFields = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return fields
      .sort((a, b) => a.position - b.position)
      .map((f) => ({
        fieldId: f._id,
        name: f.name,
        type: f.type,
        options: f.options,
        // The config IS the contract: it tells you what to send (currency,
        // decimal places, bounds, how many stars) and, for computed types,
        // why you can't send anything at all.
        config: f.config ?? null,
        computed: isComputedType(f.type),
        writeHint: FIELD_WRITE_HINTS[f.type],
      }));
  },
});

// One line per type telling an agent exactly which argument set_task_field
// expects. Surfaced on every list_custom_fields read so a tool call doesn't
// need a round trip through an error to get the shape right.
const FIELD_WRITE_HINTS: Record<string, string> = {
  text: "textValue: string",
  long_text: "textValue: string (up to 20k chars)",
  number: "numberValue: number",
  money: "numberValue: number, currency?: 3-letter code",
  dropdown: "textValue: the option id",
  labels: "optionIds: string[] of option ids",
  date: "dateValue: ISO date or epoch ms",
  checkbox: "booleanValue: true | false",
  email: "textValue: an email address",
  phone: "textValue: a phone number",
  url: "textValue: an http(s) URL",
  location: "location: { label, lat?, lng? }",
  rating: "numberValue: 1..ratingMax (0 clears)",
  progress: "numberValue: 0..100",
  people: "actorIds: string[] of clerkIds or agent ids (see list_members)",
  files: "files: [{ storageId, name, mimeType, sizeBytes }]",
  relationship: "taskIds: string[] of task ids",
  voting: "booleanValue: true to add your vote, false to remove it",
  rollup: "computed — read only",
  formula: "computed — read only",
};

/**
 * Every custom field on a task with its resolved value, including the
 * computed ones (formula results, rollup results, vote counts) that have no
 * stored row and therefore never appear in a raw value read.
 */
export const getTaskFields = query({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    const rows = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    const byField = new Map(rows.map((r) => [r.fieldId as string, r]));
    const computed = new Map(
      (await computeDerivedValues(ctx, task, fields, rows)).map((c) => [
        c.fieldId as string,
        c.value,
      ]),
    );
    return fields
      .sort((a, b) => a.position - b.position)
      .map((f) =>
        fieldValueSummary(f, byField.get(f._id), computed.get(f._id)),
      );
  },
});

export const setTaskFieldValue = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    ...fieldValueArgs,
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const field = await ctx.db.get(args.fieldId);
    if (!field || field.listId !== task.listId) {
      throw new ConvexError("Field does not belong to this task's list");
    }
    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", args.taskId).eq("fieldId", args.fieldId),
      )
      .unique();

    // Same validator the UI writes through — an agent gets identical
    // refusals, with the message telling it what to send instead.
    const patch = normalizeFieldValue(field, args, {
      voterId: agent._id,
      existing,
    });
    if (patch === null) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    await assertValueReferences(ctx, field, patch);
    // A list-restricted agent must be able to reach every task it links.
    for (const linkedId of patch.taskIds ?? []) {
      await requireTaskAccessForAgent(ctx, linkedId, agent);
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("taskFieldValues", {
      taskId: args.taskId,
      fieldId: args.fieldId,
      ...patch,
    });
  },
});

export const clearTaskFieldValue = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", args.taskId).eq("fieldId", args.fieldId),
      )
      .unique();
    if (!existing) return;
    // Voting fields: clearing removes only this agent's vote.
    const field = await ctx.db.get(args.fieldId);
    if (field?.type === "voting") {
      const kept = (existing.actorIds ?? []).filter((id) => id !== agent._id);
      if (kept.length > 0) {
        await ctx.db.patch(existing._id, { actorIds: kept });
        return;
      }
    }
    await ctx.db.delete(existing._id);
  },
});

// ── Checklist templates ─────────────────────────────────────────────────
// Reusable playbooks ("Definition of done", "Release steps") scoped like
// skills, to my personal space or workspace. Applying one copies its items
// onto a task's embedded checklist.

export const listChecklistTemplates = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const templates = await ctx.db
      .query("checklistTemplates")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    return templates.map((t) => ({
      templateId: t._id,
      name: t.name,
      items: t.items,
      createdByActorId: t.createdByActorId,
      createdAt: t.createdAt,
    }));
  },
});

export const createChecklistTemplate = mutation({
  args: { apiKey: v.string(), name: v.string(), items: v.array(v.string()) },
  handler: async (ctx, { apiKey, name, items }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    if (!name.trim()) throw new ConvexError("Name is required");
    const cleanItems = items.map((i) => i.trim()).filter(Boolean);
    if (cleanItems.length === 0) {
      throw new ConvexError("At least one checklist item is required");
    }
    return await ctx.db.insert("checklistTemplates", {
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      name: name.trim(),
      items: cleanItems,
      createdByActorId: agent._id,
      createdAt: Date.now(),
    });
  },
});

// Appends the template's items onto the task's existing checklist (doesn't
// replace it) so applying a second template — or a human's own items —
// composes rather than clobbers.
export const applyChecklistTemplate = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    templateId: v.id("checklistTemplates"),
  },
  handler: async (ctx, { apiKey, taskId, templateId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const template = await ctx.db.get(templateId);
    if (
      !template ||
      template.scopeType !== agent.parentType ||
      template.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Checklist template not found");
    }
    const existing = task.checklist ?? [];
    const additions = template.items.map((text, i) => ({
      id: `tpl-${templateId}-${Date.now()}-${i}`,
      text,
      done: false,
    }));
    await updateTaskCore(
      ctx,
      { taskId, checklist: [...existing, ...additions] },
      agentActor(agent),
    );
  },
});

// ── Portfolio & dependency network ──────────────────────────────────────

// One row per list in my scope (skipping archived spaces), with the
// project metadata a portfolio view needs. Uses the precomputed rollup
// when available and falls back to a direct scan of that one list
// otherwise (same fallback rule as the human Home/Space overview).
export const getPortfolio = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const lists = await listsInScope(ctx, agent, { skipArchived: true });
    const out = [];
    for (const { list, spaceName } of lists) {
      const rollup = await getRollup(ctx, list._id);
      let total: number;
      let done: number;
      let inProgress: number;
      if (rollup) {
        ({ total, done, inProgress } = rollup);
      } else {
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        total = tasks.length;
        done = 0;
        inProgress = 0;
        for (const t of tasks) {
          const status = await ctx.db.get(t.statusId);
          if (status?.category === "complete" || status?.category === "closed") {
            done++;
          } else if (status?.category === "in_progress") {
            inProgress++;
          }
        }
      }
      out.push({
        listId: list._id,
        name: list.name,
        spaceName,
        projectStatus: list.projectStatus,
        targetDate: list.targetDate,
        total,
        done,
        inProgress,
      });
    }
    return out;
  },
});

// A list's tasks with their blocked-by edges and status categories, so an
// agent can reason about dependency order (what's ready to start, what's
// gating what) without fetching every task individually.
export const getTaskNetwork = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    const out = [];
    for (const t of tasks) {
      const status = await ctx.db.get(t.statusId);
      out.push({
        taskId: t._id,
        title: t.title,
        status: status
          ? { statusId: status._id, name: status.name, category: status.category }
          : null,
        blockedByTaskIds: t.blockedByTaskIds ?? [],
        milestone: t.milestone ?? false,
      });
    }
    return out;
  },
});

// ── Roadmaps ───────────────────────────────────────────────────────────

// The workspace's roadmaps with their phases and the projects (lists)
// slotted into them — same rollup numbers humans see. Restricted agents
// only see projects on their allow-list; personal-scope agents have no
// workspace to read roadmaps from.
export const getRoadmaps = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    if (agent.parentType !== "workspace") {
      throw new ConvexError("Roadmaps require a workspace-scoped agent");
    }
    const workspaceId = agent.parentId as Id<"workspaces">;
    const roadmaps = await ctx.db
      .query("roadmaps")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    roadmaps.sort((a, b) => a.position - b.position);
    const out = [];
    for (const rm of roadmaps) {
      const assigned = await ctx.db
        .query("projects")
        .withIndex("by_roadmap", (q) => q.eq("roadmapId", rm._id))
        .collect();
      const projects = [];
      for (const project of assigned) {
        if (project.archivedAt !== undefined) continue;
        const space = await ctx.db.get(project.spaceId);
        if (
          !space ||
          space.parentType !== "workspace" ||
          space.parentId !== workspaceId
        ) {
          continue;
        }
        if (space.archivedAt !== undefined) continue;
        // A project's progress is the sum of its lists', so a roadmap row
        // reports the workstream rather than one board inside it.
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect();
        let total = 0;
        let done = 0;
        for (const l of lists) {
          if (!agentCanTouchList(agent, l._id)) continue;
          const rollup = await getRollup(ctx, l._id);
          total += rollup?.total ?? 0;
          done += rollup?.done ?? 0;
        }
        projects.push({
          projectId: project._id,
          name: project.name,
          projectStatus: project.projectStatus ?? null,
          targetDate: project.targetDate ?? null,
          listCount: lists.length,
          phaseId: project.roadmapPhaseId,
          position: project.roadmapPosition ?? 0,
          total,
          done,
        });
      }
      projects.sort((a, b) => a.position - b.position);
      out.push({
        roadmapId: rm._id,
        name: rm.name,
        description: rm.description,
        phases: rm.phases,
        projects,
      });
    }
    return out;
  },
});

// Put a project (list) into a roadmap phase, or pull it out with
// roadmapId: null. Structure-level: off-limits to list-restricted agents.
// Mirrors the validation in roadmaps.assignProject.
// Roadmaps sequence Projects. This used to take a listId, back when a list
// WAS a project; keeping that signature after the split is how a roadmap and
// its workstreams end up describing the same work without being connected.
export const assignProjectToPhase = mutation({
  args: {
    apiKey: v.string(),
    projectId: v.id("projects"),
    roadmapId: v.union(v.id("roadmaps"), v.null()),
    phaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (agent.parentType !== "workspace") {
      throw new ConvexError("Roadmaps require a workspace-scoped agent");
    }
    const { space } = await requireProjectAccessForAgent(
      ctx,
      args.projectId,
      agent,
    );
    if (args.roadmapId === null) {
      await ctx.db.patch(args.projectId, {
        roadmapId: undefined,
        roadmapPhaseId: undefined,
        roadmapPosition: undefined,
      });
      return;
    }
    if (space.parentType !== "workspace") {
      throw new ConvexError("Only workspace projects can join a roadmap");
    }
    const roadmap = await ctx.db.get(args.roadmapId);
    if (!roadmap || roadmap.workspaceId !== space.parentId) {
      throw new ConvexError("Roadmap belongs to a different workspace");
    }
    // An explicit phaseId that no longer exists (deleted concurrently) is
    // an error, not a silent drop into the first phase.
    const phase =
      args.phaseId !== undefined
        ? roadmap.phases.find((p) => p.id === args.phaseId)
        : roadmap.phases[0];
    if (!phase) {
      throw new ConvexError(
        args.phaseId !== undefined ? "Phase not found" : "Roadmap has no phases",
      );
    }
    const siblings = await ctx.db
      .query("projects")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
      .collect();
    const inPhase = siblings.filter(
      (p) => p.roadmapPhaseId === phase.id && p._id !== args.projectId,
    );
    // max+1, not count: unassigns leave gaps, so length would collide.
    const maxPosition = inPhase.reduce(
      (m, p) => Math.max(m, p.roadmapPosition ?? 0),
      -1,
    );
    await ctx.db.patch(args.projectId, {
      roadmapId: roadmap._id,
      roadmapPhaseId: phase.id,
      roadmapPosition: maxPosition + 1,
    });
  },
});

async function requireRoadmapForAgent(
  ctx: QueryCtx | MutationCtx,
  roadmapId: Id<"roadmaps">,
  agent: Doc<"agents">,
): Promise<Doc<"roadmaps">> {
  if (agent.parentType !== "workspace") {
    throw new ConvexError("Roadmaps require a workspace-scoped agent");
  }
  const roadmap = await ctx.db.get(roadmapId);
  if (!roadmap || roadmap.workspaceId !== agent.parentId) {
    throw new ConvexError(
      "Roadmap not found in your workspace. Call get_roadmaps to see the roadmaps you can edit.",
    );
  }
  return roadmap;
}

export const createRoadmap = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    // Explicit phases skip the Now/Next/Later defaults, so a planner can
    // lay out M1..M4 with target dates in the same call.
    phases: v.optional(
      v.array(
        v.object({ name: v.string(), targetDate: v.optional(v.number()) }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (agent.parentType !== "workspace") {
      throw new ConvexError("Roadmaps require a workspace-scoped agent");
    }
    const roadmapId = await createRoadmapCore(
      ctx,
      agent.parentId as Id<"workspaces">,
      { name: args.name, description: args.description, phases: args.phases },
      agentActor(agent),
    );
    const roadmap = await ctx.db.get(roadmapId);
    return {
      roadmapId,
      name: roadmap?.name,
      phases: roadmap?.phases ?? [],
    };
  },
});

export const addRoadmapPhase = mutation({
  args: {
    apiKey: v.string(),
    roadmapId: v.id("roadmaps"),
    name: v.string(),
    targetDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const roadmap = await requireRoadmapForAgent(ctx, args.roadmapId, agent);
    const phaseId = await addPhaseCore(
      ctx,
      roadmap,
      { name: args.name, targetDate: args.targetDate },
      agentActor(agent),
    );
    return { phaseId };
  },
});

export const updateRoadmapPhase = mutation({
  args: {
    apiKey: v.string(),
    roadmapId: v.id("roadmaps"),
    phaseId: v.string(),
    name: v.optional(v.string()),
    // null clears the target date.
    targetDate: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const roadmap = await requireRoadmapForAgent(ctx, args.roadmapId, agent);
    await updatePhaseCore(
      ctx,
      roadmap,
      { phaseId: args.phaseId, name: args.name, targetDate: args.targetDate },
      agentActor(agent),
    );
  },
});

export const removeRoadmapPhase = mutation({
  args: {
    apiKey: v.string(),
    roadmapId: v.id("roadmaps"),
    phaseId: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const roadmap = await requireRoadmapForAgent(ctx, args.roadmapId, agent);
    await removePhaseCore(ctx, roadmap, args.phaseId, agentActor(agent));
  },
});

// ── Structure lifecycle parity (Phase N) ───────────────────────────────
// Agents could create spaces/projects/lists but never fix or annotate
// them — a typo at creation was permanent garbage. These give create's
// missing other half. All structure-level: requireUnrestricted.

export const renameList = mutation({
  args: { apiKey: v.string(), listId: v.id("lists"), name: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    await renameListCore(ctx, list, args.name, agentActor(agent));
  },
});

export const updateListMeta = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    // null clears a field; omitted fields stay untouched.
    description: v.optional(v.union(v.string(), v.null())),
    sopSlug: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    const { apiKey: _apiKey, listId: _listId, ...patch } = args;
    await updateListMetaCore(ctx, list, patch, agentActor(agent));
  },
});

// Project identity — health, owner, notes, target date. Separate from
// updateListMeta because a list is a board of tasks and a project is the
// thing the board belongs to; an agent reporting "this project is at risk"
// is making a claim about the project, not about one of its boards.
export const updateProjectMeta = mutation({
  args: {
    apiKey: v.string(),
    projectId: v.id("projects"),
    // null clears a field; omitted fields stay untouched.
    description: v.optional(v.union(v.string(), v.null())),
    projectStatus: v.optional(
      v.union(
        v.literal("on_track"),
        v.literal("at_risk"),
        v.literal("off_track"),
        v.literal("paused"),
        v.null(),
      ),
    ),
    ownerActorId: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { project, space } = await requireProjectAccessForAgent(
      ctx,
      args.projectId,
      agent,
    );
    const { apiKey: _apiKey, projectId: _projectId, ...patch } = args;
    await updateProjectMetaCore(
      ctx,
      project,
      space,
      {
        description: patch.description ?? undefined,
        projectStatus: patch.projectStatus,
        ownerActorId: patch.ownerActorId,
        notes: patch.notes ?? undefined,
        targetDate: patch.targetDate,
      },
      agentActor(agent),
    );
  },
});

export const deleteList = mutation({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    await removeListCore(ctx, list, agentActor(agent));
  },
});

export const reorderLists = mutation({
  args: {
    apiKey: v.string(),
    parentType: v.union(v.literal("space"), v.literal("project")),
    parentId: v.string(),
    orderedIds: v.array(v.id("lists")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (args.parentType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.parentId as Id<"spaces">,
        agent,
      );
    } else {
      const project = await ctx.db.get(args.parentId as Id<"projects">);
      if (!project) throw new ConvexError("Project not found");
      await requireSpaceAccessForAgent(ctx, project.spaceId, agent);
    }
    await reorderListsCore(ctx, args.parentType, args.parentId, args.orderedIds);
  },
});

// Regroup a list inside its space: space → project, project → space, project →
// sibling project. Both ends are access-checked independently, and
// moveListCore itself refuses any destination outside the list's current
// space — a space is a visibility boundary, so "moving" across one would
// silently change who can see the tasks.
export const moveList = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    parentType: v.union(v.literal("space"), v.literal("project")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    if (args.parentType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.parentId as Id<"spaces">,
        agent,
      );
    } else {
      await requireProjectAccessForAgent(
        ctx,
        args.parentId as Id<"projects">,
        agent,
      );
    }
    await moveListCore(
      ctx,
      list,
      { parentType: args.parentType, parentId: args.parentId },
      agentActor(agent),
    );
  },
});

// ── Project lifecycle ───────────────────────────────────────────────────
// Agents could create projects but never fix or unpick them. Same cores the
// human sidebar calls, so renames/deletes emit `project.renamed` /
// `project.deleted` with the agent as the actor. Structure-level throughout.

export const renameProject = mutation({
  args: { apiKey: v.string(), projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { project, space } = await requireProjectAccessForAgent(
      ctx,
      args.projectId,
      agent,
    );
    await renameProjectCore(ctx, project, space, args.name, agentActor(agent));
  },
});

// Deleting a project is a grouping change, not a content deletion: every list
// inside it moves up to the parent space with its tasks intact.
export const deleteProject = mutation({
  args: { apiKey: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { project, space } = await requireProjectAccessForAgent(
      ctx,
      args.projectId,
      agent,
    );
    await removeProjectCore(ctx, project, space, agentActor(agent));
  },
});

export const reorderProjects = mutation({
  args: {
    apiKey: v.string(),
    spaceId: v.id("spaces"),
    orderedIds: v.array(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    await requireSpaceAccessForAgent(ctx, args.spaceId, agent);
    await reorderProjectsCore(ctx, args.spaceId, args.orderedIds);
  },
});

// Task-level ordering: "do these in this order" without overloading
// dependencies. Same global-renumber semantics as the human Board/List
// drag (tasks.reorder); position round-trips through list_tasks/get_task.
export const reorderTasks = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    orderedIds: v.array(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    await reorderTasksCore(
      ctx,
      { listId: args.listId, orderedIds: args.orderedIds },
      agentActor(agent),
    );
  },
});

// ── Milestones (per project) ───────────────────────────────────────────
// Dated checkpoints inside one project. Authoring them changes the shape of
// the project (like statuses and custom fields), so it's structure-level:
// requireUnrestricted. Linking a task to one is ordinary task work, so
// list-restricted agents can do it on lists they're allowed to touch.

async function requireMilestoneForAgent(
  ctx: QueryCtx | MutationCtx,
  milestoneId: Id<"milestones">,
  agent: Doc<"agents">,
): Promise<Doc<"milestones">> {
  const milestone = await ctx.db.get(milestoneId);
  if (!milestone) {
    throw new ConvexError(
      "Milestone not found. Call list_milestones for this project's checkpoints.",
    );
  }
  await requireListAccessForAgent(ctx, milestone.listId, agent);
  return milestone;
}

export const listMilestones = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    await requireListAccessForAgent(ctx, args.listId, agent);
    const milestones = await milestonesWithProgress(ctx, args.listId);
    return milestones.map((m) => ({
      milestoneId: m._id,
      listId: m.listId,
      name: m.name,
      description: m.description,
      targetDate: m.targetDate,
      status: m.status,
      completedAt: m.completedAt,
      position: m.position,
      total: m.total,
      done: m.done,
    }));
  },
});

export const createMilestone = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    name: v.string(),
    description: v.optional(v.string()),
    targetDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { list } = await requireListAccessForAgent(ctx, args.listId, agent);
    const milestoneId = await createMilestoneCore(
      ctx,
      list,
      {
        name: args.name,
        description: args.description,
        targetDate: args.targetDate,
      },
      agentActor(agent),
    );
    return { milestoneId };
  },
});

export const updateMilestone = mutation({
  args: {
    apiKey: v.string(),
    milestoneId: v.id("milestones"),
    // null clears an optional field; omitted fields stay untouched.
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
    status: v.optional(v.union(v.literal("open"), v.literal("complete"))),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const milestone = await requireMilestoneForAgent(
      ctx,
      args.milestoneId,
      agent,
    );
    await updateMilestoneCore(
      ctx,
      milestone,
      {
        name: args.name,
        description: args.description,
        targetDate: args.targetDate,
        status: args.status,
      },
      agentActor(agent),
    );
  },
});

export const deleteMilestone = mutation({
  args: { apiKey: v.string(), milestoneId: v.id("milestones") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const milestone = await requireMilestoneForAgent(
      ctx,
      args.milestoneId,
      agent,
    );
    await removeMilestoneCore(ctx, milestone, agentActor(agent));
  },
});

export const setTaskMilestone = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    // null detaches the task from its milestone.
    milestoneId: v.union(v.id("milestones"), v.null()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    await updateTaskCore(
      ctx,
      { taskId: args.taskId, milestoneId: args.milestoneId },
      agentActor(agent),
    );
  },
});

// ── Bulk create (Phase N) ──────────────────────────────────────────────
// One intent, one call: a whole plan-slice of tasks with inline subtask
// nesting (parentRef) and named dependencies (dependsOn), instead of N
// create_task + M add_dependency round-trips burning the burst budget.

const bulkTaskSpecValidator = v.object({
  // A caller-chosen handle other specs can reference in parentRef /
  // dependsOn. Must be unique within the batch.
  ref: v.optional(v.string()),
  title: v.string(),
  description: v.optional(v.string()),
  statusId: v.optional(v.id("listStatuses")),
  priority: v.optional(priorityValidator),
  startDate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
  assigneeIds: v.optional(v.array(v.string())),
  requiredCapabilities: v.optional(v.array(v.string())),
  // Parent by ref (earlier spec in this batch) or by existing task id.
  parentRef: v.optional(v.string()),
  parentTaskId: v.optional(v.id("tasks")),
  // Blockers by ref (any spec in this batch) or existing task id.
  dependsOn: v.optional(v.array(v.string())),
  sprintId: v.optional(v.id("sprints")),
  checklist: v.optional(checklistValidator),
  requiresApproval: v.optional(v.boolean()),
  estimatePoints: v.optional(v.number()),
  milestone: v.optional(v.boolean()),
});

export const createTasks = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    tasks: v.array(bulkTaskSpecValidator),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    if (args.tasks.length === 0) {
      throw new ConvexError("tasks must not be empty");
    }
    if (args.tasks.length > 50) {
      throw new ConvexError(
        "Batches are capped at 50 tasks per call — split larger plans into multiple create_tasks calls.",
      );
    }
    const seenRefs = new Set<string>();
    for (const spec of args.tasks) {
      if (spec.ref === undefined) continue;
      if (seenRefs.has(spec.ref)) {
        throw new ConvexError(`Duplicate ref "${spec.ref}" in batch`);
      }
      seenRefs.add(spec.ref);
    }
    const refs = new Map<string, Id<"tasks">>();

    const actor = agentActor(agent);
    const created: { ref: string | null; taskId: Id<"tasks">; title: string }[] =
      [];

    // Pass 1: create in array order so parentRef can point at any EARLIER
    // spec (subtasks after their parent, the natural writing order).
    for (const spec of args.tasks) {
      let parentTaskId = spec.parentTaskId;
      if (spec.parentRef !== undefined) {
        const resolved = refs.get(spec.parentRef);
        if (!resolved) {
          throw new ConvexError(
            `parentRef "${spec.parentRef}" must reference an earlier task in the batch`,
          );
        }
        parentTaskId = resolved;
      }
      const taskId = await createTaskCore(
        ctx,
        {
          listId: args.listId,
          title: spec.title,
          description: spec.description,
          statusId: spec.statusId,
          priority: spec.priority,
          startDate: spec.startDate,
          dueDate: spec.dueDate,
          assigneeIds: spec.assigneeIds,
          requiredCapabilities: spec.requiredCapabilities,
          parentTaskId,
          sprintId: spec.sprintId,
          checklist: spec.checklist,
          requiresApproval: spec.requiresApproval,
          estimatePoints: spec.estimatePoints,
          milestone: spec.milestone,
        },
        actor,
      );
      if (spec.ref !== undefined) refs.set(spec.ref, taskId);
      created.push({ ref: spec.ref ?? null, taskId, title: spec.title });
    }

    // Pass 2: dependencies — refs may point forward or backward now that
    // every task exists. External ids must be tasks the agent can access.
    for (let i = 0; i < args.tasks.length; i++) {
      const spec = args.tasks[i];
      if (!spec.dependsOn || spec.dependsOn.length === 0) continue;
      const taskId = created[i].taskId;
      const blockerIds: Id<"tasks">[] = [];
      for (const dep of spec.dependsOn) {
        const byRef = refs.get(dep);
        if (byRef) {
          if (byRef === taskId) {
            throw new ConvexError(`Task "${spec.title}" can't depend on itself`);
          }
          blockerIds.push(byRef);
          continue;
        }
        const asId = ctx.db.normalizeId("tasks", dep);
        if (!asId) {
          throw new ConvexError(
            `dependsOn entry "${dep}" is neither a ref in this batch nor a task id`,
          );
        }
        await requireTaskAccessForAgent(ctx, asId, agent);
        blockerIds.push(asId);
      }
      await updateTaskCore(
        ctx,
        { taskId, blockedByTaskIds: blockerIds },
        actor,
      );
    }

    return { created, count: created.length };
  },
});

const executionPlanTaskValidator = v.object({
  ref: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  priority: v.optional(priorityValidator),
  startDate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
  assigneeIds: v.optional(v.array(v.string())),
  requiredCapabilities: v.optional(v.array(v.string())),
  parentRef: v.optional(v.string()),
  dependsOn: v.optional(v.array(v.string())),
  checklist: v.optional(checklistValidator),
  requiresApproval: v.optional(v.boolean()),
  estimatePoints: v.optional(v.number()),
  milestone: v.optional(v.boolean()),
});

const executionPlanProjectValidator = v.object({
  ref: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  phaseRef: v.string(),
  projectStatus: v.optional(
    v.union(
      v.literal("on_track"),
      v.literal("at_risk"),
      v.literal("off_track"),
      v.literal("paused"),
    ),
  ),
  ownerActorId: v.optional(v.string()),
  targetDate: v.optional(v.number()),
  tasks: v.array(executionPlanTaskValidator),
});

function executionRef(value: string, label: string): string {
  const ref = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ref)) {
    throw new ConvexError(
      `${label} must be 1-64 letters, numbers, underscores, or hyphens`,
    );
  }
  return ref;
}

function executionText(
  value: string,
  label: string,
  max: number,
): string {
  const text = value.trim();
  if (!text) throw new ConvexError(`${label} is required`);
  if (text.length > max) {
    throw new ConvexError(`${label} must be ${max} characters or fewer`);
  }
  return text;
}

function executionTextList(
  values: string[],
  label: string,
  options: { min?: number; max?: number } = {},
): string[] {
  const rows = values.map((value, index) =>
    executionText(value, `${label}[${index}]`, 500),
  );
  if (rows.length < (options.min ?? 0)) {
    throw new ConvexError(`${label} must contain at least ${options.min} item`);
  }
  if (rows.length > (options.max ?? 25)) {
    throw new ConvexError(`${label} is capped at ${options.max ?? 25} items`);
  }
  return rows;
}

function executionContext(args: {
  name: string;
  objective: string;
  sourceContext: string;
  successCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
  projectName: string;
  projectDescription?: string;
}): string {
  const bullets = (rows: string[], empty: string) =>
    rows.length > 0 ? rows.map((row) => `- ${row}`).join("\n") : empty;
  return [
    `# ${args.name}`,
    "",
    "## Objective",
    args.objective,
    "",
    "## This project",
    args.projectDescription
      ? `${args.projectName}: ${args.projectDescription}`
      : args.projectName,
    "",
    "## Success criteria",
    bullets(args.successCriteria, "- Define success before execution."),
    "",
    "## Confirmed source context",
    args.sourceContext,
    "",
    "## Explicit assumptions",
    bullets(args.assumptions, "None."),
    "",
    "## Open questions",
    bullets(args.openQuestions, "None."),
  ].join("\n");
}

// Compile one conversation/brief into an executable company plan in a
// single Convex transaction. Any invalid ref, assignee, dependency, or
// context packet rolls the whole mutation back, so an agent never leaves a
// half-built roadmap behind. The immutable manifest is both provenance and
// the idempotency receipt for safe retries.
export const createExecutionPlan = mutation({
  args: {
    apiKey: v.string(),
    idempotencyKey: v.string(),
    spaceId: v.id("spaces"),
    name: v.string(),
    objective: v.string(),
    sourceContext: v.string(),
    successCriteria: v.array(v.string()),
    assumptions: v.optional(v.array(v.string())),
    openQuestions: v.optional(v.array(v.string())),
    phases: v.array(
      v.object({
        ref: v.string(),
        name: v.string(),
        targetDate: v.optional(v.number()),
      }),
    ),
    projects: v.array(executionPlanProjectValidator),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (agent.parentType !== "workspace") {
      throw new ConvexError(
        "Execution plans require a workspace-scoped agent because they create roadmaps and multi-project work",
      );
    }
    const workspaceId = agent.parentId as Id<"workspaces">;
    const { space } = await requireSpaceAccessForAgent(
      ctx,
      args.spaceId,
      agent,
    );
    if (space.parentType !== "workspace" || space.parentId !== workspaceId) {
      throw new ConvexError("Pick a Space in this agent's workspace");
    }

    const idempotencyKey = executionText(
      args.idempotencyKey,
      "idempotencyKey",
      120,
    );
    const fingerprintInput = {
      spaceId: args.spaceId,
      name: args.name,
      objective: args.objective,
      sourceContext: args.sourceContext,
      successCriteria: args.successCriteria,
      assumptions: args.assumptions ?? [],
      openQuestions: args.openQuestions ?? [],
      phases: args.phases,
      projects: args.projects,
    };
    const requestFingerprint = sha256Hex(canonicalJson(fingerprintInput));
    const previous = await ctx.db
      .query("executionPlans")
      .withIndex("by_agent_key", (q) =>
        q
          .eq("createdByAgentId", agent._id)
          .eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) {
        throw new ConvexError(
          "This idempotencyKey was already committed with a different plan. Use a new key for a changed plan.",
        );
      }
      return { ...executionPlanView(previous), replayed: true };
    }

    const name = executionText(args.name, "Plan name", 120);
    const objective = executionText(args.objective, "Objective", 1_000);
    const sourceContext = executionText(
      args.sourceContext,
      "sourceContext",
      35_000,
    );
    const successCriteria = executionTextList(
      args.successCriteria,
      "successCriteria",
      { min: 1, max: 25 },
    );
    const assumptions = executionTextList(
      args.assumptions ?? [],
      "assumptions",
      { max: 25 },
    );
    const openQuestions = executionTextList(
      args.openQuestions ?? [],
      "openQuestions",
      { max: 25 },
    );
    if (args.phases.length === 0 || args.phases.length > 12) {
      throw new ConvexError("phases must contain 1-12 ordered phases");
    }
    if (args.projects.length === 0 || args.projects.length > 12) {
      throw new ConvexError("projects must contain 1-12 projects");
    }

    const phaseRefs = new Map<string, number>();
    const phases = args.phases.map((phase, index) => {
      const ref = executionRef(phase.ref, `phases[${index}].ref`);
      if (phaseRefs.has(ref)) {
        throw new ConvexError(`Duplicate phase ref "${ref}"`);
      }
      phaseRefs.set(ref, index);
      return {
        ref,
        name: executionText(phase.name, `phases[${index}].name`, 120),
        targetDate: phase.targetDate,
      };
    });

    const projectRefs = new Set<string>();
    const tasksByRef = new Map<
      string,
      {
        projectRef: string;
        projectIndex: number;
        taskIndex: number;
        spec: (typeof args.projects)[number]["tasks"][number];
      }
    >();
    const parentByRef = new Map<string, string | undefined>();
    let totalTasks = 0;
    const projects = args.projects.map((project, projectIndex) => {
      const ref = executionRef(
        project.ref,
        `projects[${projectIndex}].ref`,
      );
      if (projectRefs.has(ref)) {
        throw new ConvexError(`Duplicate project ref "${ref}"`);
      }
      projectRefs.add(ref);
      const phaseRef = executionRef(
        project.phaseRef,
        `projects[${projectIndex}].phaseRef`,
      );
      if (!phaseRefs.has(phaseRef)) {
        throw new ConvexError(
          `Project "${ref}" references unknown phase "${phaseRef}"`,
        );
      }
      if (project.tasks.length === 0 || project.tasks.length > 50) {
        throw new ConvexError(
          `Project "${ref}" must contain 1-50 tasks`,
        );
      }
      totalTasks += project.tasks.length;
      const localRefs = new Set<string>();
      const tasks = project.tasks.map((task, taskIndex) => {
        const localRef = executionRef(
          task.ref,
          `projects[${projectIndex}].tasks[${taskIndex}].ref`,
        );
        if (localRefs.has(localRef)) {
          throw new ConvexError(
            `Duplicate task ref "${localRef}" in project "${ref}"`,
          );
        }
        localRefs.add(localRef);
        const qualifiedRef = `${ref}.${localRef}`;
        tasksByRef.set(qualifiedRef, {
          projectRef: ref,
          projectIndex,
          taskIndex,
          spec: task,
        });
        let parentRef: string | undefined;
        if (task.parentRef !== undefined) {
          const localParent = executionRef(
            task.parentRef,
            `parentRef for "${qualifiedRef}"`,
          );
          if (!localRefs.has(localParent) || localParent === localRef) {
            throw new ConvexError(
              `parentRef "${task.parentRef}" for "${qualifiedRef}" must reference an earlier task in the same project`,
            );
          }
          parentRef = `${ref}.${localParent}`;
        }
        parentByRef.set(qualifiedRef, parentRef);
        return {
          ...task,
          ref: localRef,
          qualifiedRef,
          title: executionText(task.title, `Task "${qualifiedRef}" title`, 500),
        };
      });
      return {
        ...project,
        ref,
        phaseRef,
        name: executionText(project.name, `Project "${ref}" name`, 120),
        description:
          project.description === undefined
            ? undefined
            : executionText(
                project.description,
                `Project "${ref}" description`,
                1_000,
              ),
        tasks,
      };
    });
    if (totalTasks > 100) {
      throw new ConvexError(
        "Execution plans are capped at 100 tasks; split a larger program into multiple plans",
      );
    }
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError("Workspace not found");
    const executionPolicy = executionPolicyFor(workspace);
    const hasApprovalGatedTasks = projects.some((project) =>
      project.tasks.some((task) => task.requiresApproval === true),
    );
    const policyAuthorized =
      executionPolicy.mode === "bounded_autonomous" &&
      totalTasks <= executionPolicy.maxPlanTasks &&
      openQuestions.length === 0 &&
      !hasApprovalGatedTasks;
    const reviewStatus = policyAuthorized ? "approved" : "pending";
    const authorizationReason = policyAuthorized
      ? `Automatically authorized by workspace policy v${executionPolicy.version}: ${totalTasks} tasks, no open questions, and no approval-gated work.`
      : executionPolicy.mode === "bounded_autonomous"
        ? totalTasks > executionPolicy.maxPlanTasks
          ? `Human review required because ${totalTasks} tasks exceeds the autonomous plan limit of ${executionPolicy.maxPlanTasks}.`
          : openQuestions.length > 0
            ? "Human review required because the plan contains open questions."
            : "Human review required because the plan contains approval-gated tasks."
        : "Workspace policy requires human review.";

    const dependencyRefs = new Map<string, string[]>();
    for (const project of projects) {
      for (const task of project.tasks) {
        const resolved: string[] = [];
        for (const raw of task.dependsOn ?? []) {
          const trimmed = raw.trim();
          const ref = trimmed.includes(".")
            ? trimmed
            : `${project.ref}.${executionRef(trimmed, `dependency for "${task.qualifiedRef}"`)}`;
          if (!tasksByRef.has(ref)) {
            throw new ConvexError(
              `Task "${task.qualifiedRef}" depends on unknown task ref "${raw}"`,
            );
          }
          if (ref === task.qualifiedRef) {
            throw new ConvexError(
              `Task "${task.qualifiedRef}" can't depend on itself`,
            );
          }
          if (!resolved.includes(ref)) resolved.push(ref);
        }
        dependencyRefs.set(task.qualifiedRef, resolved);
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    function visit(ref: string, path: string[]) {
      if (visiting.has(ref)) {
        throw new ConvexError(
          `Dependency cycle detected: ${[...path, ref].join(" -> ")}`,
        );
      }
      if (visited.has(ref)) return;
      visiting.add(ref);
      for (const dependency of dependencyRefs.get(ref) ?? []) {
        visit(dependency, [...path, ref]);
      }
      visiting.delete(ref);
      visited.add(ref);
    }
    for (const ref of tasksByRef.keys()) visit(ref, []);

    const validActorIds = new Set<string>();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    for (const membership of memberships) {
      validActorIds.add(membership.userClerkId);
    }
    const scopeAgents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    for (const scopeAgent of scopeAgents) validActorIds.add(scopeAgent._id);
    for (const project of projects) {
      if (
        project.ownerActorId !== undefined &&
        !validActorIds.has(project.ownerActorId)
      ) {
        throw new ConvexError(
          `Project "${project.ref}" ownerActorId is not a workspace member or agent`,
        );
      }
      for (const task of project.tasks) {
        for (const assigneeId of task.assigneeIds ?? []) {
          if (!validActorIds.has(assigneeId)) {
            throw new ConvexError(
              `Task "${task.qualifiedRef}" assignee "${assigneeId}" is not a workspace member or agent`,
            );
          }
        }
      }
    }

    const actor = agentActor(agent);
    const roadmapId = await createRoadmapCore(
      ctx,
      workspaceId,
      {
        name,
        description: objective,
        phases: phases.map((phase) => ({
          name: phase.name,
          targetDate: phase.targetDate,
        })),
      },
      actor,
    );
    const roadmap = await ctx.db.get(roadmapId);
    if (!roadmap) throw new ConvexError("Roadmap creation failed");
    const phaseIds = new Map(
      phases.map((phase, index) => [phase.ref, roadmap.phases[index].id]),
    );
    const siblingProjects = await ctx.db
      .query("projects")
      .withIndex("by_space", (q) => q.eq("spaceId", args.spaceId))
      .collect();
    const nextProjectPosition = siblingProjects.reduce(
      (max, project) => Math.max(max, project.position + 1),
      0,
    );
    const phasePositions = new Map<string, number>();
    const createdProjects: Doc<"executionPlans">["projects"] = [];
    const createdTasks: Doc<"executionPlans">["tasks"] = [];
    const listByProject = new Map<string, Doc<"lists">>();
    const taskIdsByRef = new Map<string, Id<"tasks">>();
    const tasksByProject = new Map<string, Doc<"tasks">[]>();

    for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
      const project = projects[projectIndex];
      const phaseId = phaseIds.get(project.phaseRef)!;
      const roadmapPosition = phasePositions.get(phaseId) ?? 0;
      phasePositions.set(phaseId, roadmapPosition + 1);
      // A workstream materializes as a Project ON the roadmap, with one
      // List inside it holding the tasks. It used to be a bare list wearing
      // the roadmap fields, which is why a plan's roadmap and its
      // workstreams could both exist and reference nothing.
      const createdProjectId = await ctx.db.insert("projects", {
        name: project.name,
        spaceId: args.spaceId,
        position: nextProjectPosition + projectIndex,
        createdAt: Date.now(),
        roadmapId,
        roadmapPhaseId: phaseId,
        roadmapPosition,
        description: project.description,
        projectStatus: project.projectStatus ?? "on_track",
        ownerActorId: project.ownerActorId,
        targetDate: project.targetDate,
      });
      const listId = await ctx.db.insert("lists", {
        name: project.name,
        parentType: "project",
        parentId: createdProjectId,
        position: 0,
        createdAt: Date.now(),
        description: project.description,
      });
      await seedDefaultStatuses(ctx, listId, space.defaultStatuses);
      const list = (await ctx.db.get(listId))!;
      listByProject.set(project.ref, list);
      const projectTasks: Doc<"tasks">[] = [];
      for (const task of project.tasks) {
        const parentRef = parentByRef.get(task.qualifiedRef);
        const taskId = await createTaskCore(
          ctx,
          {
            listId,
            title: task.title,
            description: task.description,
            priority: task.priority,
            startDate: task.startDate,
            dueDate: task.dueDate,
            assigneeIds: task.assigneeIds,
            requiredCapabilities: task.requiredCapabilities,
            parentTaskId:
              parentRef === undefined ? undefined : taskIdsByRef.get(parentRef),
            checklist: task.checklist,
            requiresApproval: task.requiresApproval,
            estimatePoints: task.estimatePoints,
            milestone: task.milestone,
          },
          actor,
        );
        taskIdsByRef.set(task.qualifiedRef, taskId);
        const createdTask = (await ctx.db.get(taskId))!;
        projectTasks.push(createdTask);
        createdTasks.push({
          ref: task.qualifiedRef,
          title: task.title,
          taskId,
          listId,
        });
      }
      tasksByProject.set(project.ref, projectTasks);
    }

    for (const project of projects) {
      for (const task of project.tasks) {
        const blockers = (dependencyRefs.get(task.qualifiedRef) ?? []).map(
          (ref) => taskIdsByRef.get(ref)!,
        );
        if (blockers.length === 0) continue;
        await updateTaskCore(
          ctx,
          {
            taskId: taskIdsByRef.get(task.qualifiedRef)!,
            blockedByTaskIds: blockers,
          },
          actor,
        );
      }
    }

    for (const project of projects) {
      const list = listByProject.get(project.ref)!;
      const content = executionContext({
        name,
        objective,
        sourceContext,
        successCriteria,
        assumptions,
        openQuestions,
        projectName: project.name,
        projectDescription: project.description,
      });
      if (content.length > 50_000) {
        throw new ConvexError(
          "The compiled context packet exceeds 50,000 characters; shorten sourceContext or planning notes",
        );
      }
      const contextPacketId = await createContextPacketCore(
        ctx,
        list,
        {
          title: `${name}: operating brief`.slice(0, 120),
          summary: objective.slice(0, 500),
          content,
        },
        actor,
      );
      const packet = (await ctx.db.get(contextPacketId))!;
      for (const task of tasksByProject.get(project.ref) ?? []) {
        await attachContextPacketCore(ctx, packet, task, actor);
      }
      createdProjects.push({
        ref: project.ref,
        name: project.name,
        listId: list._id,
        phaseId: phaseIds.get(project.phaseRef)!,
        contextPacketId,
      });
    }

    const planId = await ctx.db.insert("executionPlans", {
      workspaceId,
      spaceId: args.spaceId,
      createdByAgentId: agent._id,
      idempotencyKey,
      requestFingerprint,
      name,
      objective,
      sourceContext,
      successCriteria,
      assumptions,
      openQuestions,
      reviewStatus,
      authorizationSource: policyAuthorized
        ? "workspace_policy"
        : undefined,
      authorizationPolicyVersion: policyAuthorized
        ? executionPolicy.version
        : undefined,
      authorizationReason,
      roadmapId,
      projects: createdProjects,
      tasks: createdTasks,
      createdAt: Date.now(),
    });
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: workspaceId,
      type: "plan.committed",
      actor,
      entityType: "roadmap",
      entityId: roadmapId,
      entityTitle: name,
      payload: {
        planId,
        projectCount: createdProjects.length,
        taskCount: createdTasks.length,
        openQuestionCount: openQuestions.length,
        reviewStatus,
        authorizationSource: policyAuthorized
          ? "workspace_policy"
          : "none",
        authorizationPolicyVersion: policyAuthorized
          ? executionPolicy.version
          : undefined,
      },
    });
    const plan = (await ctx.db.get(planId))!;
    return { ...executionPlanView(plan), replayed: false };
  },
});

// Append new source truth to an existing plan without rewriting its
// immutable original manifest. Every workstream packet advances together,
// prior acknowledgements become stale by version, and dispatch returns to
// human review until the revised context is explicitly authorized.
export const reviseExecutionPlanContext = mutation({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
    idempotencyKey: v.string(),
    changeSummary: v.string(),
    sourceAddendum: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    await requireSpaceAccessForAgent(ctx, plan.spaceId, agent);

    const idempotencyKey = executionText(
      args.idempotencyKey,
      "idempotencyKey",
      120,
    );
    const changeSummary = executionText(
      args.changeSummary,
      "changeSummary",
      1_000,
    );
    const sourceAddendum = executionText(
      args.sourceAddendum,
      "sourceAddendum",
      15_000,
    );
    const requestFingerprint = sha256Hex(
      canonicalJson({ changeSummary, sourceAddendum }),
    );
    const previous = await ctx.db
      .query("executionPlanRevisions")
      .withIndex("by_plan_key", (q) =>
        q.eq("planId", args.planId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) {
        throw new ConvexError(
          "This idempotencyKey was already committed with a different context revision.",
        );
      }
      return {
        revisionId: previous._id,
        revision: previous.revision,
        affectedPacketCount: previous.affectedPacketCount,
        affectedTaskCount: previous.affectedTaskCount,
        reviewStatus: "pending" as const,
        replayed: true,
      };
    }

    const revisions = await ctx.db
      .query("executionPlanRevisions")
      .withIndex("by_plan", (q) => q.eq("planId", args.planId))
      .order("desc")
      .take(1);
    const revision = (revisions[0]?.revision ?? plan.contextRevision ?? 0) + 1;
    const actor = agentActor(agent);
    const createdAt = Date.now();
    let affectedTaskCount = 0;
    const revisionBlock = [
      "",
      "",
      `# Plan context revision ${revision}`,
      "",
      `## Change summary`,
      changeSummary,
      "",
      `## Confirmed source addendum`,
      sourceAddendum,
    ].join("\n");

    for (const workstream of plan.projects) {
      const packet = await ctx.db.get(workstream.contextPacketId);
      const list = await ctx.db.get(workstream.listId);
      if (!packet || !list || packet.listId !== list._id) {
        throw new ConvexError(
          `Workstream "${workstream.name}" is missing its context packet`,
        );
      }
      await updateContextPacketCore(
        ctx,
        packet,
        list,
        { content: `${packet.content}${revisionBlock}` },
        actor,
      );
      const links = await ctx.db
        .query("taskContextPackets")
        .withIndex("by_packet", (q) =>
          q.eq("packetId", workstream.contextPacketId),
        )
        .collect();
      affectedTaskCount += links.length;
    }

    const revisionId = await ctx.db.insert("executionPlanRevisions", {
      planId: args.planId,
      revision,
      idempotencyKey,
      requestFingerprint,
      changeSummary,
      sourceAddendum,
      createdByAgentId: agent._id,
      affectedPacketCount: plan.projects.length,
      affectedTaskCount,
      createdAt,
    });
    await ctx.db.patch(args.planId, {
      contextRevision: revision,
      lastContextRevisionAt: createdAt,
      reviewStatus: "pending",
      authorizationSource: undefined,
      authorizationPolicyVersion: undefined,
      authorizationReason:
        `Context revision ${revision} requires owner or admin review before further dispatch.`,
    });
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: plan.workspaceId,
      type: "plan.context_revised",
      actor,
      entityType: "roadmap",
      entityId: plan.roadmapId,
      entityTitle: plan.name,
      payload: {
        planId: args.planId,
        revision,
        affectedPacketCount: plan.projects.length,
        affectedTaskCount,
      },
    });
    return {
      revisionId,
      revision,
      affectedPacketCount: plan.projects.length,
      affectedTaskCount,
      reviewStatus: "pending" as const,
      replayed: false,
    };
  },
});

export const getExecutionPlan = query({
  args: { apiKey: v.string(), planId: v.id("executionPlans") },
  handler: async (ctx, { apiKey, planId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const plan = await ctx.db.get(planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    const revisions = await ctx.db
      .query("executionPlanRevisions")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .order("desc")
      .collect();
    return {
      ...executionPlanView(plan),
      revisions: revisions.map((revision) => ({
        revisionId: revision._id,
        revision: revision.revision,
        changeSummary: revision.changeSummary,
        sourceAddendum: revision.sourceAddendum,
        createdByAgentId: revision.createdByAgentId,
        affectedPacketCount: revision.affectedPacketCount,
        affectedTaskCount: revision.affectedTaskCount,
        createdAt: revision.createdAt,
      })),
    };
  },
});

export const getExecutionPolicy = query({
  args: { apiKey: v.string() },
  returns: executionPolicyValidator,
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    if (agent.parentType !== "workspace") {
      throw new ConvexError(
        "Execution policy requires a workspace-scoped agent",
      );
    }
    const workspace = await ctx.db.get(
      agent.parentId as Id<"workspaces">,
    );
    if (!workspace) throw new ConvexError("Workspace not found");
    return executionPolicyFor(workspace);
  },
});

export const listExecutionPlans = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    if (agent.parentType !== "workspace") {
      throw new ConvexError(
        "Execution plans require a workspace-scoped agent",
      );
    }
    const plans = await ctx.db
      .query("executionPlans")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", agent.parentId as Id<"workspaces">),
      )
      .order("desc")
      .take(20);
    return plans.map(executionPlanSummary);
  },
});

export const getOutcomeAssurance = query({
  args: { apiKey: v.string(), planId: v.id("executionPlans") },
  handler: async (ctx, { apiKey, planId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const plan = await ctx.db.get(planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    return await outcomeAssuranceView(ctx, plan);
  },
});

export const submitOutcomeEvidence = mutation({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
    criterionIndex: v.number(),
    evidenceSummary: v.string(),
    evidenceLinks: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    const checkId = await submitOutcomeEvidenceCore(
      ctx,
      plan,
      args.criterionIndex,
      agent._id,
      args.evidenceSummary,
      args.evidenceLinks,
    );
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: plan.workspaceId,
      type: "outcome.evidence_submitted",
      actor: agentActor(agent),
      entityType: "executionPlan",
      entityId: plan._id,
      entityTitle: plan.name,
      payload: { criterionIndex: args.criterionIndex, checkId },
    });
    return await outcomeAssuranceView(ctx, plan);
  },
});

export const reviewOutcomeCriterion = mutation({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
    criterionIndex: v.number(),
    verdict: v.union(v.literal("passed"), v.literal("failed")),
    reviewNote: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    await reviewOutcomeCriterionCore(
      ctx,
      plan,
      args.criterionIndex,
      args.verdict,
      args.reviewNote,
      agentActor(agent),
    );
    return await outcomeAssuranceView(ctx, plan);
  },
});

function executionWaveView(wave: Doc<"executionWaves">) {
  return {
    waveId: wave._id,
    planId: wave.planId,
    assignments: wave.assignments,
    skipped: wave.skipped,
    openQuestionDisposition: wave.openQuestionDisposition,
    authorizationSource: wave.authorizationSource,
    authorizationPolicyVersion: wave.authorizationPolicyVersion,
    createdByAgentId: wave.createdByAgentId,
    createdAt: wave.createdAt,
  };
}

export const getExecutionReadiness = query({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
    agentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    return await executionReadinessCore(
      ctx,
      plan,
      args.agentIds ? new Set(args.agentIds) : undefined,
    );
  },
});

export const getExecutionControl = query({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    return await executionControlCore(ctx, plan);
  },
});

async function reconcileExecutionPlanCore(
  ctx: MutationCtx,
  plan: Doc<"executionPlans">,
  actorAgent: Doc<"agents">,
) {
  const result = await reconcileStaleExecutionAssignments(ctx, plan._id);
  const recoveredAgentIdsByTask = new Map<string, Set<string>>();
  for (const assignment of result.recovered) {
    const agentIds =
      recoveredAgentIdsByTask.get(assignment.taskId) ?? new Set<string>();
    agentIds.add(assignment.agentId);
    recoveredAgentIdsByTask.set(assignment.taskId, agentIds);
  }
  let releasedClaimCount = 0;
  for (const [taskId, recoveredAgentIds] of recoveredAgentIdsByTask) {
    const normalizedTaskId = ctx.db.normalizeId("tasks", taskId);
    if (!normalizedTaskId) continue;
    const [task, latestAssignment] = await Promise.all([
      ctx.db.get(normalizedTaskId),
      latestExecutionAssignmentForTask(ctx, normalizedTaskId),
    ]);
    if (
      !task?.claimedByActorId ||
      !recoveredAgentIds.has(task.claimedByActorId) ||
      (latestAssignment &&
        (latestAssignment.status === "dispatched" ||
          latestAssignment.status === "claimed" ||
          latestAssignment.status === "running"))
    ) {
      continue;
    }
    await releaseTaskCore(
      ctx,
      normalizedTaskId,
      agentActor(actorAgent),
      true,
    );
    releasedClaimCount += 1;
  }
  if (result.recovered.length > 0) {
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: plan.workspaceId,
      type: "plan.execution_reconciled",
      actor: agentActor(actorAgent),
      entityType: "roadmap",
      entityId: plan.roadmapId,
      entityTitle: plan.name,
      payload: {
        planId: plan._id,
        recoveredAssignmentCount: result.recovered.length,
        releasedClaimCount,
        truncated: result.truncated,
      },
    });
  }
  return {
    recoveredAssignmentCount: result.recovered.length,
    releasedClaimCount,
    scannedCount: result.scannedCount,
    truncated: result.truncated,
    assignments: result.recovered,
  };
}

export const reconcileExecutionPlan = mutation({
  args: {
    apiKey: v.string(),
    planId: v.id("executionPlans"),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const plan = await ctx.db.get(args.planId);
    if (
      !plan ||
      agent.parentType !== "workspace" ||
      plan.workspaceId !== agent.parentId
    ) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    return await reconcileExecutionPlanCore(ctx, plan, agent);
  },
});

export const dispatchExecutionWave = mutation({
  args: {
    apiKey: v.string(),
    idempotencyKey: v.string(),
    planId: v.id("executionPlans"),
    maxTasks: v.optional(v.number()),
    agentIds: v.optional(v.array(v.id("agents"))),
    openQuestionDisposition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (agent.parentType !== "workspace") {
      throw new ConvexError(
        "Execution waves require a workspace-scoped agent",
      );
    }
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.workspaceId !== agent.parentId) {
      throw new ConvexError("Execution plan not found in your workspace");
    }
    const workspace = await ctx.db.get(plan.workspaceId);
    if (!workspace) throw new ConvexError("Workspace not found");
    const executionPolicy = executionPolicyFor(workspace);
    const authorization = planAuthorization(plan, executionPolicy);
    if (!authorization.authorized) {
      throw new ConvexError(authorization.reason);
    }
    if (authorization.source === "none") {
      throw new ConvexError("Execution authorization source is missing");
    }
    const idempotencyKey = executionText(
      args.idempotencyKey,
      "idempotencyKey",
      120,
    );
    const maxTasks = args.maxTasks ?? executionPolicy.maxTasksPerWave;
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 25) {
      throw new ConvexError("maxTasks must be an integer from 1-25");
    }
    if (maxTasks > executionPolicy.maxTasksPerWave) {
      throw new ConvexError(
        `Workspace execution policy allows at most ${executionPolicy.maxTasksPerWave} tasks per wave`,
      );
    }
    const requestedAgentIds = [...new Set(args.agentIds ?? [])];
    for (const agentId of requestedAgentIds) {
      const candidate = await ctx.db.get(agentId);
      if (
        !candidate ||
        candidate.parentType !== "workspace" ||
        candidate.parentId !== plan.workspaceId
      ) {
        throw new ConvexError(
          `agentIds includes an agent outside this workspace: ${agentId}`,
        );
      }
    }
    let openQuestionDisposition = args.openQuestionDisposition?.trim();
    if (openQuestionDisposition && openQuestionDisposition.length > 2_000) {
      throw new ConvexError(
        "openQuestionDisposition must be 2,000 characters or fewer",
      );
    }
    if (plan.openQuestions.length > 0) {
      if (!openQuestionDisposition || openQuestionDisposition.length < 10) {
        throw new ConvexError(
          "This plan has open questions. Provide openQuestionDisposition explaining what was resolved, deferred, or intentionally bounded before dispatch.",
        );
      }
    } else {
      openQuestionDisposition = undefined;
    }
    const fingerprint = sha256Hex(
      canonicalJson({
        planId: args.planId,
        maxTasks,
        agentIds: requestedAgentIds,
        openQuestionDisposition,
      }),
    );
    const previous = await ctx.db
      .query("executionWaves")
      .withIndex("by_agent_key", (q) =>
        q
          .eq("createdByAgentId", agent._id)
          .eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) {
        throw new ConvexError(
          "This idempotencyKey already dispatched a different wave. Use a new key for changed routing.",
        );
      }
      return { ...executionWaveView(previous), replayed: true };
    }

    await reconcileExecutionPlanCore(ctx, plan, agent);
    const readiness = await executionReadinessCore(
      ctx,
      plan,
      requestedAgentIds.length > 0
        ? new Set(requestedAgentIds)
        : undefined,
    );
    const selected = readiness.recommendations.slice(0, maxTasks);
    if (selected.length === 0) {
      const reasons = [
        ...new Set(readiness.skipped.map((row) => row.reason)),
      ].join(", ");
      throw new ConvexError(
        `No tasks are dispatchable in this wave${reasons ? ` (${reasons})` : ""}`,
      );
    }
    const assignments: Doc<"executionWaves">["assignments"] = [];
    for (const recommendation of selected) {
      const task = await ctx.db.get(recommendation.taskId);
      const target = await ctx.db.get(recommendation.recommendedAgentId);
      if (!task || !target) {
        throw new ConvexError(
          `Dispatch artifact disappeared for ${recommendation.taskRef}; retry with a new wave key`,
        );
      }
      const humanAssignees = task.assigneeClerkIds.filter(
        (assigneeId) => !ctx.db.normalizeId("agents", assigneeId),
      );
      const assigneeIds = [
        ...humanAssignees,
        recommendation.recommendedAgentId,
      ];
      if (
        assigneeIds.length !== task.assigneeClerkIds.length ||
        assigneeIds.some(
          (assigneeId, index) =>
            assigneeId !== task.assigneeClerkIds[index],
        )
      ) {
        await updateTaskCore(
          ctx,
          { taskId: task._id, assigneeIds },
          agentActor(agent),
          { suppressAgentPing: true },
        );
      }
      const delivery = target.notifyUrl
        ? ("notify_url" as const)
        : ("poll_required" as const);
      assignments.push({
        taskId: task._id,
        taskRef: recommendation.taskRef,
        agentId: target._id,
        delivery,
        contextPacketCount: recommendation.contextPacketCount,
        estimatedContextTokens: recommendation.estimatedContextTokens,
        contextVersionFingerprint:
          recommendation.contextVersionFingerprint,
      });
    }
    const selectedRefs = new Set(
      selected.map((recommendation) => recommendation.taskRef),
    );
    const skipped = readiness.skipped.filter(
      (row) => !selectedRefs.has(row.taskRef),
    );
    for (const recommendation of readiness.recommendations.slice(maxTasks)) {
      skipped.push({
        taskRef: recommendation.taskRef,
        reason: "wave_limit",
      });
    }
    const dispatchedAt = Date.now();
    const waveId = await ctx.db.insert("executionWaves", {
      workspaceId: plan.workspaceId,
      planId: plan._id,
      createdByAgentId: agent._id,
      idempotencyKey,
      requestFingerprint: fingerprint,
      openQuestionDisposition,
      authorizationSource: authorization.source,
      authorizationPolicyVersion:
        authorization.source === "workspace_policy"
          ? executionPolicy.version
          : undefined,
      assignments,
      skipped,
      createdAt: dispatchedAt,
    });
    const recommendationByTaskId = new Map(
      selected.map((recommendation) => [
        recommendation.taskId as string,
        recommendation,
      ]),
    );
    for (const assignment of assignments) {
      const previousAttempts = await ctx.db
        .query("executionAssignments")
        .withIndex("by_task", (q) => q.eq("taskId", assignment.taskId))
        .collect();
      const executionAssignmentId = await ctx.db.insert(
        "executionAssignments",
        {
        workspaceId: plan.workspaceId,
        planId: plan._id,
        waveId,
        taskId: assignment.taskId,
        taskRef: assignment.taskRef,
        agentId: assignment.agentId,
        delivery: assignment.delivery,
        contextPacketCount: assignment.contextPacketCount,
        estimatedContextTokens: assignment.estimatedContextTokens,
        contextVersionFingerprint: assignment.contextVersionFingerprint,
        status: "dispatched",
        attempt: previousAttempts.length + 1,
        dispatchedAt,
        },
      );
      const recommendation = recommendationByTaskId.get(
        assignment.taskId as string,
      );
      if (!recommendation) {
        throw new ConvexError(
          `Dispatch recommendation disappeared for ${assignment.taskRef}`,
        );
      }
      await enqueueAgentPingDelivery(ctx, {
        scopeType: "workspace",
        scopeId: plan.workspaceId,
        workspaceId: plan.workspaceId,
        sourceKind: "execution_assignment",
        sourceId: executionAssignmentId,
        executionAssignmentId,
        agentId: assignment.agentId,
        taskId: assignment.taskId,
        push: assignment.delivery === "notify_url",
        type: "task.ready",
        payload: {
          planId: plan._id,
          taskId: assignment.taskId,
          listId: recommendation.listId,
          title: recommendation.title,
          contextRequired: true,
          contextPacketCount: recommendation.contextPacketCount,
          estimatedContextTokens: recommendation.estimatedContextTokens,
          contextVersionFingerprint:
            recommendation.contextVersionFingerprint,
          contextPackets: recommendation.contextPackets.map((packet) => ({
            packetId: packet.packetId,
            version: packet.version,
          })),
        },
      });
    }
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: plan.workspaceId,
      type: "plan.wave_dispatched",
      actor: agentActor(agent),
      entityType: "roadmap",
      entityId: plan.roadmapId,
      entityTitle: plan.name,
      payload: {
        planId: plan._id,
        waveId,
        assignmentCount: assignments.length,
        pollRequiredCount: assignments.filter(
          (assignment) => assignment.delivery === "poll_required",
        ).length,
      },
    });
    const wave = (await ctx.db.get(waveId))!;
    return { ...executionWaveView(wave), replayed: false };
  },
});

// ── Creation gaps (Phase N) ────────────────────────────────────────────
// Custom fields and statuses were read/use-only for agents; creation is
// the missing half a PRD build needs ("Severity" dropdown, "QA" status).

export const createCustomField = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    name: v.string(),
    type: fieldTypeValidator,
    options: v.optional(v.array(fieldOptionValidator)),
    config: v.optional(fieldConfigValidator),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    await requireListAccessForAgent(ctx, args.listId, agent);
    const name = args.name.trim();
    if (!name) throw new ConvexError("Field name is required");

    const siblings = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    // Identical definition rules to customFields.create — formulas are
    // parsed and their references checked here too, so an agent finds out
    // its expression is wrong at definition time, not on every read.
    const { options, config } = normalizeFieldDefinition({
      type: args.type,
      options: args.options,
      config: args.config,
      siblings,
      selfName: name,
    });
    const fieldId = await ctx.db.insert("customFields", {
      listId: args.listId,
      name,
      type: args.type,
      options,
      config,
      position: siblings.length,
      createdAt: Date.now(),
    });
    return { fieldId };
  },
});

// Default pastel per category, matching listStatuses.DEFAULT_STATUSES.
const STATUS_CATEGORY_COLORS: Record<string, string> = {
  open: "#c9ccd4",
  in_progress: "#a9c6f2",
  complete: "#a9dcbd",
  closed: "#c2c2ca",
};

export const createStatus = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    name: v.string(),
    category: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("complete"),
      v.literal("closed"),
    ),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    await requireListAccessForAgent(ctx, args.listId, agent);
    if (!args.name.trim()) throw new ConvexError("Status name is required");
    const siblings = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    const statusId = await ctx.db.insert("listStatuses", {
      listId: args.listId,
      name: args.name.trim(),
      color: args.color ?? STATUS_CATEGORY_COLORS[args.category],
      category: args.category,
      position: siblings.length,
      createdAt: Date.now(),
    });
    return { statusId };
  },
});

// ── Comment management (author-only) ───────────────────────────────────

export const updateComment = mutation({
  args: { apiKey: v.string(), messageId: v.id("messages"), body: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const msg = await ctx.db.get(args.messageId);
    if (!msg || msg.authorClerkId !== agent._id) {
      throw new ConvexError("Only the author can edit");
    }
    if (!args.body.trim()) throw new ConvexError("Empty message");
    await ctx.db.patch(args.messageId, {
      body: args.body,
      editedAt: Date.now(),
    });
  },
});

export const deleteComment = mutation({
  args: { apiKey: v.string(), messageId: v.id("messages") },
  handler: async (ctx, { apiKey, messageId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const msg = await ctx.db.get(messageId);
    if (!msg) return;
    if (msg.authorClerkId !== agent._id) {
      throw new ConvexError("Only the author can delete");
    }
    const replies = await ctx.db
      .query("messages")
      .withIndex("by_parent_message", (q) => q.eq("parentMessageId", messageId))
      .collect();
    for (const r of replies) {
      const ms = await ctx.db
        .query("mentions")
        .withIndex("by_message", (q) => q.eq("messageId", r._id))
        .collect();
      for (const m of ms) await ctx.db.delete(m._id);
      await ctx.db.delete(r._id);
    }
    const ms = await ctx.db
      .query("mentions")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    for (const m of ms) await ctx.db.delete(m._id);
    await ctx.db.delete(messageId);
  },
});

export const resolveComment = mutation({
  args: {
    apiKey: v.string(),
    messageId: v.id("messages"),
    resolved: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const msg = await ctx.db.get(args.messageId);
    if (!msg) throw new ConvexError("Message not found");
    await requireMessageParentAccessForAgent(
      ctx,
      msg.parentType,
      msg.parentId,
      agent,
    );
    await ctx.db.patch(args.messageId, {
      resolvedAt: args.resolved ? Date.now() : undefined,
      resolvedByClerkId: args.resolved ? agent._id : undefined,
    });
  },
});

// ── Task blueprints (Phase L) ──────────────────────────────────────────

// Blueprints in my scope: reusable task definitions ops humans (or other
// agents) have standardized.
export const listBlueprints = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const rows = await ctx.db
      .query("taskBlueprints")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((bp) => ({
        blueprintId: bp._id,
        name: bp.name,
        title: bp.title,
        description: bp.description,
        priority: bp.priority,
        checklist: bp.checklist,
        estimatePoints: bp.estimatePoints,
        sopSlug: bp.sopSlug,
        dueInDays: bp.dueInDays,
        requiresApproval: bp.requiresApproval ?? false,
      }));
  },
});

export const createBlueprint = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    checklist: v.optional(v.array(v.string())),
    estimatePoints: v.optional(v.number()),
    sopSlug: v.optional(v.string()),
    dueInDays: v.optional(v.number()),
    requiresApproval: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const { apiKey: _apiKey, ...blueprint } = args;
    return await createTaskBlueprintCore(
      ctx,
      {
        scopeType: agent.parentType,
        scopeId: agent.parentId,
        ...blueprint,
      },
      agentActor(agent),
    );
  },
});

// Instantiate a blueprint into a list. Runs through the shared task core,
// so routing, automations, rollups, and events all apply.
export const instantiateBlueprint = mutation({
  args: {
    apiKey: v.string(),
    blueprintId: v.id("taskBlueprints"),
    listId: v.id("lists"),
    assigneeIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
    const bp = await ctx.db.get(args.blueprintId);
    if (
      !bp ||
      bp.scopeType !== agent.parentType ||
      bp.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Blueprint not found in your scope");
    }
    return await createTaskCore(
      ctx,
      {
        listId: args.listId,
        assigneeIds: args.assigneeIds,
        ...blueprintTaskFields(bp),
      },
      agentActor(agent),
    );
  },
});

// revisions and pinned context already ride get_task's reply (see getTask
// above); these functions exist for the cases that read has no room for —
// project-level revisions, the full text of a long brief, and writing back.

/**
 * Every revision still needing work in the agent's scope, task-level and
 * project-level, newest first. `listId` narrows to one project.
 */
export const listOpenRevisions = query({
  args: {
    apiKey: v.string(),
    listId: v.optional(v.id("lists")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, listId, limit }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    // Normalize to plain list docs: requireListAccessForAgent returns a
    // { list, spaceName } envelope, listsInScope returns the docs themselves.
    const lists = listId
      ? [(await requireListAccessForAgent(ctx, listId, agent)).list]
      : (await listsInScope(ctx, agent)).map((entry) =>
          "list" in entry ? entry.list : entry,
        );

    const out: {
      revisionId: Id<"revisions">;
      parentType: "task" | "list";
      parentId: string;
      listId: Id<"lists">;
      listName: string;
      taskTitle: string | null;
      body: string;
      requestedBy: string;
      requestedAt: number;
    }[] = [];

    for (const list of lists) {
      // Project-level asks: "the whole list needs reordering", not one task.
      for (const revision of openOnly(
        await revisionsForParent(ctx, "list", list._id),
      )) {
        out.push({
          revisionId: revision._id,
          parentType: "list",
          parentId: list._id,
          listId: list._id,
          listName: list.name,
          taskTitle: null,
          body: revision.body,
          requestedBy: revision.requestedByName,
          requestedAt: revision.createdAt,
        });
      }
      // Task-level asks. Walked per task rather than off the status index so
      // the result can never include a task outside the agent's scope.
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      for (const task of tasks) {
        for (const revision of openOnly(
          await revisionsForParent(ctx, "task", task._id),
        )) {
          out.push({
            revisionId: revision._id,
            parentType: "task",
            parentId: task._id,
            listId: list._id,
            listName: list.name,
            taskTitle: task.title,
            body: revision.body,
            requestedBy: revision.requestedByName,
            requestedAt: revision.createdAt,
          });
        }
      }
    }
    return out
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, Math.min(limit ?? 50, 200));
  },
});

/**
 * Report a revision as addressed, with a note saying what changed. An agent
 * cannot accept its own revision — a person decides that, the same asymmetry
 * the approval gates use.
 */
export const addressRevision = mutation({
  args: {
    apiKey: v.string(),
    revisionId: v.id("revisions"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, revisionId, note }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const revision = await ctx.db.get(revisionId);
    if (!revision) throw new ConvexError("Revision not found");
    // Scope check through the parent, so an agent can only touch revisions on
    // work it can already reach.
    if (revision.parentType === "task") {
      await requireTaskAccessForAgent(
        ctx,
        revision.parentId as Id<"tasks">,
        agent,
      );
    } else {
      await requireListAccessForAgent(
        ctx,
        revision.parentId as Id<"lists">,
        agent,
      );
    }
    await addressRevisionCore(ctx, { revisionId, note }, agentActor(agent));
    return { ok: true as const };
  },
});

/** Ask a human (or another agent) for a change. Same object, other direction. */
export const requestRevision = mutation({
  args: {
    apiKey: v.string(),
    parentType: v.union(v.literal("task"), v.literal("list")),
    parentId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, { apiKey, parentType, parentId, body }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    if (parentType === "task") {
      await requireTaskAccessForAgent(ctx, parentId as Id<"tasks">, agent);
    } else {
      await requireListAccessForAgent(ctx, parentId as Id<"lists">, agent);
    }
    const revisionId = await createRevisionCore(
      ctx,
      { parentType, parentId, body },
      agentActor(agent),
    );
    return { revisionId };
  },
});

/** Every context doc on a project, with full text. */
/**
 * Pages attached to a project, pinned ones first.
 *
 * Keeps its old name — an agent's prompt shouldn't break because the product
 * consolidated — but it reads `pages` now. There is one writing primitive.
 */
export const listProjectDocs = query({
  args: { apiKey: v.string(), listId: v.id("lists") },
  handler: async (ctx, { apiKey, listId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireListAccessForAgent(ctx, listId, agent);
    const attachments = await ctx.db
      .query("pageAttachments")
      .withIndex("by_target", (q) =>
        q.eq("targetType", "list").eq("targetId", listId),
      )
      .collect();
    const out: {
      pageId: Id<"pages">;
      title: string;
      markdown: string;
      pinnedContext: boolean;
      updatedAt: number;
    }[] = [];
    for (const att of attachments) {
      const page = await ctx.db.get(att.pageId);
      if (!page || page.archivedAt !== undefined) continue;
      out.push({
        pageId: page._id,
        title: page.title,
        markdown: page.markdown,
        pinnedContext: att.pinned === true,
        updatedAt: page.updatedAt,
      });
    }
    return out.sort((a, b) => {
      if (a.pinnedContext !== b.pinnedContext) return a.pinnedContext ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  },
});

/**
 * Create or update a page attached to a project, optionally as its canonical
 * context — the successor to a pinned doc, on the one primitive.
 */
export const writeProjectDoc = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    title: v.string(),
    text: v.string(),
    pageId: v.optional(v.id("pages")),
    pinnedContext: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const list = await requireListAccessForAgent(ctx, args.listId, agent);
    const scope = scopeOf(agent);
    const actor = agentActor(agent);

    let pageId = args.pageId;
    if (pageId) {
      const page = await ctx.db.get(pageId);
      if (
        !page ||
        page.scopeType !== scope.scopeType ||
        page.scopeId !== scope.scopeId
      ) {
        throw new ConvexError("Page not found in your scope");
      }
      await updatePageCore(
        ctx,
        page,
        { title: args.title, markdown: args.text },
        actor,
      );
    } else {
      pageId = await createPageCore(
        ctx,
        { scopeType: scope.scopeType, scopeId: scope.scopeId },
        { title: args.title, markdown: args.text },
        actor,
      );
    }

    const page = (await ctx.db.get(pageId))!;
    const attachmentId = await attachPageCore(
      ctx,
      page,
      "list",
      args.listId,
      actor,
    );
    if (args.pinnedContext !== undefined) {
      await ctx.db.patch(attachmentId, { pinned: args.pinnedContext });
    }
    void list;
    return { pageId, attachmentId };
  },
});

export const getProjectUpdates = query({
  args: {
    apiKey: v.string(),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, since, limit }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const perProjectLimit = Math.min(limit ?? 40, 100);
    const cutoff = since ?? 0;

    // Which projects count as "mine": anywhere I hold work, plus anywhere I
    // have been explicitly scoped to. A list-restricted agent gets exactly its
    // restriction; an unrestricted one gets the projects it is working in
    // rather than the entire account.
    const scoped = (await listsInScope(ctx, agent)).map((e) => e.list);
    const mine: Doc<"lists">[] = [];
    for (const list of scoped) {
      if (agent.allowedListIds?.includes(list._id)) {
        mine.push(list);
        continue;
      }
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      if (tasks.some((t) => t.assigneeClerkIds.includes(agent._id))) {
        mine.push(list);
      }
    }

    // One scope-ranged read, then bucketed — cheaper than a query per project
    // and it keeps the ordering consistent across buckets.
    const events = await ctx.db
      .query("events")
      .withIndex("by_scope", (q) =>
        q
          .eq("scopeType", agent.parentType)
          .eq("scopeId", agent.parentId)
          .gt("createdAt", cutoff),
      )
      .collect();

    const mineIds = new Set(mine.map((l) => l._id as string));
    let newest = cutoff;

    const projects = await Promise.all(
      mine.map(async (list) => {
        const listEvents = events
          .filter((e) => e.listId === list._id)
          // Own actions are not news. Without this an agent wakes itself up
          // every time it writes anything.
          .filter((e) => e.actorId !== agent._id)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, perProjectLimit);
        for (const e of listEvents) {
          if (e.createdAt > newest) newest = e.createdAt;
        }

        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        const openRevisions: {
          revisionId: Id<"revisions">;
          parentType: "task" | "list";
          parentId: string;
          taskTitle: string | null;
          body: string;
          requestedBy: string;
        }[] = [];
        for (const revision of openOnly(
          await revisionsForParent(ctx, "list", list._id),
        )) {
          openRevisions.push({
            revisionId: revision._id,
            parentType: "list",
            parentId: list._id,
            taskTitle: null,
            body: revision.body,
            requestedBy: revision.requestedByName,
          });
        }
        for (const task of tasks) {
          for (const revision of openOnly(
            await revisionsForParent(ctx, "task", task._id),
          )) {
            openRevisions.push({
              revisionId: revision._id,
              parentType: "task",
              parentId: task._id,
              taskTitle: task.title,
              body: revision.body,
              requestedBy: revision.requestedByName,
            });
          }
        }

        const awaitingApproval = tasks
          .filter(
            (t) =>
              t.requiresApproval === true &&
              t.approvedAt === undefined &&
              t.assigneeClerkIds.includes(agent._id),
          )
          .map((t) => ({ taskId: t._id, title: t.title }));

        return {
          listId: list._id,
          listName: list.name,
          events: listEvents.map((e) => ({
            eventId: e._id,
            type: e.type,
            actorType: e.actorType,
            actorName: e.actorName,
            entityType: e.entityType,
            entityId: e.entityId,
            entityTitle: e.entityTitle,
            createdAt: e.createdAt,
          })),
          openRevisions,
          awaitingApproval,
        };
      }),
    );

    return {
      cursor: newest,
      // Events outside any of my projects, so an agent can tell "nothing for
      // me" from "nothing happened at all" without a second call.
      otherScopeActivity: events.filter(
        (e) => e.listId === undefined || !mineIds.has(e.listId),
      ).length,
      projects: projects.filter(
        (p) =>
          p.events.length > 0 ||
          p.openRevisions.length > 0 ||
          p.awaitingApproval.length > 0,
      ),
    };
  },
});


/**
 * The scope a page target lives in, resolved agent-side.
 *
 * An agent is bound to exactly one scope, so this is both the access check
 * and the answer: resolve the target's scope and refuse anything outside the
 * agent's own. No separate permission model — an agent cannot reach a target
 * it could not already read.
 */
async function requireTargetAccessForAgent(
  ctx: MutationCtx,
  targetType:
    | "workspace"
    | "space"
    | "project"
    | "list"
    | "task"
    | "agent"
    | "goal"
    | "sprint",
  targetId: string,
  agent: Doc<"agents">,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string }> {
  const scope = await scopeOfTarget(ctx, targetType, targetId);
  if (!scope) throw new ConvexError("Not found");
  if (
    scope.scopeType !== agent.parentType ||
    scope.scopeId !== agent.parentId
  ) {
    throw new ConvexError("Forbidden");
  }
  return scope;
}

async function scopeOfTarget(
  ctx: MutationCtx,
  targetType: string,
  targetId: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  const spaceScope = async (spaceId: Id<"spaces">) => {
    const space = await ctx.db.get(spaceId);
    return space
      ? { scopeType: space.parentType, scopeId: space.parentId }
      : null;
  };
  switch (targetType) {
    case "workspace":
      return { scopeType: "workspace", scopeId: targetId };
    case "space":
      return await spaceScope(targetId as Id<"spaces">);
    case "project": {
      const project = await ctx.db.get(targetId as Id<"projects">);
      return project ? await spaceScope(project.spaceId) : null;
    }
    case "list": {
      const list = await ctx.db.get(targetId as Id<"lists">);
      if (!list) return null;
      const space = await getSpaceForList(ctx, list);
      return space
        ? { scopeType: space.parentType, scopeId: space.parentId }
        : null;
    }
    case "task": {
      const task = await ctx.db.get(targetId as Id<"tasks">);
      if (!task) return null;
      const list = await ctx.db.get(task.listId);
      if (!list) return null;
      const space = await getSpaceForList(ctx, list);
      return space
        ? { scopeType: space.parentType, scopeId: space.parentId }
        : null;
    }
    case "agent": {
      const a = await ctx.db.get(targetId as Id<"agents">);
      return a ? { scopeType: a.parentType, scopeId: a.parentId } : null;
    }
    case "goal": {
      const g = await ctx.db.get(targetId as Id<"goals">);
      return g ? { scopeType: g.parentType, scopeId: g.parentId } : null;
    }
    case "sprint": {
      const sp = await ctx.db.get(targetId as Id<"sprints">);
      return sp
        ? { scopeType: "workspace" as const, scopeId: sp.workspaceId }
        : null;
    }
    default:
      return null;
  }
}

// ── Pages ──────────────────────────────────────────────────────────────
//
// The long-form surface, agent side. Markdown is what an agent writes
// natively, and it is exactly what the page stores — so an agent drafting a
// spec and a human editing it afterwards are touching the same bytes, with
// no conversion step in between to lose anyone's work.

/**
 * Pin or unpin a page as the canonical context for something.
 *
 * Attachment and pinning are separate on purpose: attaching says "this page
 * is relevant here", pinning says "hand this to whoever works on it". Merging
 * them would make every reference mandatory reading.
 */
export const pinPage = mutation({
  args: {
    apiKey: v.string(),
    pageId: v.id("pages"),
    targetType: v.union(
      v.literal("workspace"),
      v.literal("space"),
      v.literal("project"),
      v.literal("list"),
      v.literal("task"),
      v.literal("agent"),
      v.literal("goal"),
      v.literal("sprint"),
    ),
    targetId: v.string(),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const page = await ctx.db.get(args.pageId);
    if (
      !page ||
      page.scopeType !== agent.parentType ||
      page.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Page not found in your scope");
    }
    await requireTargetAccessForAgent(
      ctx,
      args.targetType,
      args.targetId,
      agent,
    );
    const attachment = await ctx.db
      .query("pageAttachments")
      .withIndex("by_page_and_target", (q) =>
        q
          .eq("pageId", args.pageId)
          .eq("targetType", args.targetType)
          .eq("targetId", args.targetId),
      )
      .unique();
    if (!attachment) {
      throw new ConvexError(
        "That page isn't attached there yet — attach it first with write_page's attachTo.",
      );
    }
    await ctx.db.patch(attachment._id, { pinned: args.pinned });
    return null;
  },
});

export const listPages = query({
  args: {
    apiKey: v.string(),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, search, limit }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const needle = search?.trim().toLowerCase();
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    return pages
      .filter((p) => p.archivedAt === undefined)
      .filter((p) =>
        needle
          ? `${p.title} ${p.markdown}`.toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(limit ?? 50, 200))
      .map((p) => ({
        pageId: p._id,
        title: p.title,
        excerpt: markdownExcerpt(p.markdown),
        updatedAt: p.updatedAt,
        updatedBy: p.updatedByName ?? p.createdByName,
      }));
  },
});

export const readPage = query({
  args: { apiKey: v.string(), pageId: v.id("pages") },
  handler: async (ctx, { apiKey, pageId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const page = await ctx.db.get(pageId);
    if (!page) throw new ConvexError("Page not found");
    if (
      page.scopeType !== agent.parentType ||
      page.scopeId !== agent.parentId
    ) {
      throw new ConvexError("Forbidden");
    }
    const attachments = await ctx.db
      .query("pageAttachments")
      .withIndex("by_page", (q) => q.eq("pageId", pageId))
      .collect();
    return {
      pageId: page._id,
      title: page.title,
      // The full markdown, not a rendering of it — this is the point.
      markdown: page.markdown,
      updatedAt: page.updatedAt,
      updatedBy: page.updatedByName ?? page.createdByName,
      attachedTo: attachments.map((a) => ({
        targetType: a.targetType,
        targetId: a.targetId,
      })),
    };
  },
});

export const writePage = mutation({
  args: {
    apiKey: v.string(),
    // Omit to create; pass to update in place.
    pageId: v.optional(v.id("pages")),
    title: v.optional(v.string()),
    markdown: v.string(),
    attachTo: v.optional(
      v.object({
        targetType: v.union(
          v.literal("workspace"),
          v.literal("space"),
          v.literal("project"),
          v.literal("list"),
          v.literal("task"),
          v.literal("agent"),
          v.literal("goal"),
          v.literal("sprint"),
        ),
        targetId: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const actor = agentActor(agent);

    let pageId = args.pageId;
    if (pageId) {
      const page = await ctx.db.get(pageId);
      if (!page) throw new ConvexError("Page not found");
      if (
        page.scopeType !== agent.parentType ||
        page.scopeId !== agent.parentId
      ) {
        throw new ConvexError("Forbidden");
      }
      await updatePageCore(
        ctx,
        page,
        { title: args.title, markdown: args.markdown },
        actor,
      );
      // Writing a page puts the agent in that page's rail, so someone reading
      // it sees who is changing it under them.
      await markPresence(ctx, "page", pageId, actor, {
        editing: true,
        detail: agent.statusText ?? undefined,
      });
    } else {
      pageId = await createPageCore(
        ctx,
        { scopeType: agent.parentType, scopeId: agent.parentId },
        { title: args.title, markdown: args.markdown },
        actor,
      );
    }

    if (args.attachTo && pageId) {
      const page = (await ctx.db.get(pageId))!;
      const scope = await requireTargetAccessForAgent(
        ctx,
        args.attachTo.targetType,
        args.attachTo.targetId,
        agent,
      );
      if (
        scope.scopeType !== page.scopeType ||
        scope.scopeId !== page.scopeId
      ) {
        throw new ConvexError(
          "A page can only be attached to things in its own workspace",
        );
      }
      await attachPageCore(
        ctx,
        page,
        args.attachTo.targetType,
        args.attachTo.targetId,
        actor,
      );
    }

    return { pageId, url: `/dashboard/pages/${pageId}` };
  },
});
