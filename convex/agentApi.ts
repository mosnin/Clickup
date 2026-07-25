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
  requireFolderAccessForAgent,
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
  createFolderCore,
  removeFolderCore,
  renameFolderCore,
  reorderFoldersCore,
} from "./folders";
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
import { blueprintTaskFields } from "./taskBlueprints";
import { createChannelCore } from "./channels";
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
  parentType: "task" | "space" | "workspace" | "channel",
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

// Walk every list in the agent's scope (spaces → folders → lists),
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
    const parents: { type: "space" | "folder"; id: string }[] = [
      { type: "space", id: space._id },
    ];
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    for (const f of folders) parents.push({ type: "folder", id: f._id });
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
    // Project-level intent, so the tree alone answers "what is this list
    // for and when is it due" without a per-list read.
    description: l.description ?? null,
    projectStatus: l.projectStatus ?? null,
    targetDate: l.targetDate ?? null,
    roadmap: l.roadmapId
      ? { roadmapId: l.roadmapId, phaseId: l.roadmapPhaseId ?? null }
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

// Extract plain text from Tiptap JSON (mirror of the helper in ai.ts,
// which lives in the Node runtime and can't be imported here).
function tiptapToText(content: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
  walk(content);
  return parts.join(" ").trim();
}

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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
      capabilities: agent.capabilities ?? [],
      maxConcurrentTasks: agent.maxConcurrentTasks ?? 1,
      allowedLists,
      dailyActionLimit,
      actionsUsedToday,
      actionsRemainingToday: Math.max(0, dailyActionLimit - actionsUsedToday),
      burstLimitPerMinute: BURST_LIMIT_PER_MINUTE,
      billing: {
        meteringEnabled,
        creditsBalance: wallet ? wallet.balance : null,
        creditsPerAction,
      },
      firstSteps:
        "New here? Fetch the collaboration-protocol skill, find work with next_task, read get_task, acknowledge its context versions, then claim and heartbeat while working.",
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

// ── Structure: tree, spaces, folders, lists ────────────────────────────

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
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      const folderNodes = [];
      for (const folder of folders.sort((a, b) => a.position - b.position)) {
        const lists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", folder._id),
          )
          .collect();
        folderNodes.push({
          folderId: folder._id,
          name: folder.name,
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
        folders: folderNodes,
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

// Routed through createFolderCore, so an agent-created folder lands in the
// activity feed as `folder.created` exactly like a human-created one — and
// picks up the core's append-after-max positioning instead of a row count
// that collides once a folder has been deleted.
export const createFolder = mutation({
  args: { apiKey: v.string(), spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { apiKey, spaceId, name }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    const { space } = await requireSpaceAccessForAgent(ctx, spaceId, agent);
    return await createFolderCore(ctx, space, name, agentActor(agent));
  },
});

export const createList = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    parentType: v.union(v.literal("space"), v.literal("folder")),
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
      const folder = await ctx.db.get(args.parentId as Id<"folders">);
      if (!folder) throw new ConvexError("Folder not found");
      await requireSpaceAccessForAgent(ctx, folder.spaceId, agent);
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
        const listParents: { type: "space" | "folder"; id: string }[] = [
          { type: "space", id: space._id },
        ];
        const folders = await ctx.db
          .query("folders")
          .withIndex("by_space", (q) => q.eq("spaceId", space._id))
          .collect();
        for (const f of folders) listParents.push({ type: "folder", id: f._id });
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
    };
  },
});

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
      const message = await ctx.db.get(m.messageId);
      out.push({
        mentionId: m._id,
        parentType: m.parentType,
        parentId: m.parentId,
        body: message?.body ?? "",
        authorId: message?.authorClerkId,
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
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    dayOfWeek: v.optional(v.number()),
    dayOfMonth: v.optional(v.number()),
    hourUtc: v.optional(v.number()),
    dueInDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireListAccessForAgent(ctx, args.listId, agent);
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

export const listDocs = query({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const docs = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    // Docs attached to spaces inside the scope, too.
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
    for (const space of spaces) {
      const spaceDocs = await ctx.db
        .query("docs")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      docs.push(...spaceDocs);
    }
    return docs.map((d) => ({
      docId: d._id,
      title: d.title,
      updatedAt: d.updatedAt,
    }));
  },
});

export const getDoc = query({
  args: { apiKey: v.string(), docId: v.id("docs") },
  handler: async (ctx, { apiKey, docId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const doc = await requireDocAccessForAgent(ctx, docId, agent);
    return {
      docId: doc._id,
      title: doc.title,
      text: tiptapToText(doc.content),
      updatedAt: doc.updatedAt,
    };
  },
});

export const createDoc = mutation({
  args: { apiKey: v.string(), title: v.string(), text: v.optional(v.string()) },
  handler: async (ctx, { apiKey, title, text }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    const docId = await ctx.db.insert("docs", {
      parentType: agent.parentType,
      parentId: agent.parentId,
      title,
      content: textToTiptap(text ?? ""),
      createdByClerkId: agent._id,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
    return docId;
  },
});

export const updateDoc = mutation({
  args: {
    apiKey: v.string(),
    docId: v.id("docs"),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
  },
  handler: async (ctx, { apiKey, docId, title, text }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireDocAccessForAgent(ctx, docId, agent);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (title !== undefined) patch.title = title;
    if (text !== undefined) patch.content = textToTiptap(text);
    await ctx.db.patch(docId, patch);
    await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
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
      const parents: { type: "space" | "folder"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) parents.push({ type: "folder", id: f._id });
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
        parentType: v.union(v.literal("doc"), v.literal("task")),
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
      const parents: { type: "space" | "folder"; id: string }[] = [
        { type: "space", id: space._id },
      ];
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) parents.push({ type: "folder", id: f._id });
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
    return channels.map((c) => ({ channelId: c._id, name: c.name }));
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
const TEMPLATE_DESTINATIONS: Record<string, ("space" | "folder" | "list")[]> = {
  list: ["space", "folder"],
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
      v.literal("folder"),
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
    } else if (args.destinationType === "folder") {
      await requireFolderAccessForAgent(
        ctx,
        args.destinationId as Id<"folders">,
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
          parentType: args.destinationType === "space" ? "space" : "folder",
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
    parentType: v.union(v.literal("space"), v.literal("folder")),
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
      const folder = await ctx.db.get(args.parentId as Id<"folders">);
      if (!folder) throw new ConvexError("Folder not found");
      await requireSpaceAccessForAgent(ctx, folder.spaceId, agent);
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
        .query("lists")
        .withIndex("by_roadmap", (q) => q.eq("roadmapId", rm._id))
        .collect();
      const projects = [];
      for (const list of assigned) {
        if (!agentCanTouchList(agent, list._id)) continue;
        const space = await getSpaceForList(ctx, list);
        if (
          !space ||
          space.parentType !== "workspace" ||
          space.parentId !== workspaceId
        ) {
          continue;
        }
        if (space.archivedAt !== undefined) continue;
        const rollup = await getRollup(ctx, list._id);
        projects.push({
          listId: list._id,
          name: list.name,
          phaseId: list.roadmapPhaseId,
          position: list.roadmapPosition ?? 0,
          total: rollup?.total ?? 0,
          done: rollup?.done ?? 0,
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
export const assignProjectToPhase = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    roadmapId: v.union(v.id("roadmaps"), v.null()),
    phaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    if (agent.parentType !== "workspace") {
      throw new ConvexError("Roadmaps require a workspace-scoped agent");
    }
    const { space } = await requireListAccessForAgent(
      ctx,
      args.listId,
      agent,
    );
    if (args.roadmapId === null) {
      await ctx.db.patch(args.listId, {
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
      .query("lists")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
      .collect();
    const inPhase = siblings.filter(
      (l) => l.roadmapPhaseId === phase.id && l._id !== args.listId,
    );
    // max+1, not count: unassigns leave gaps, so length would collide.
    const maxPosition = inPhase.reduce(
      (m, l) => Math.max(m, l.roadmapPosition ?? 0),
      -1,
    );
    await ctx.db.patch(args.listId, {
      roadmapId: roadmap._id,
      roadmapPhaseId: phase.id,
      roadmapPosition: maxPosition + 1,
    });
  },
});

// ── Roadmap authoring (Phase N) ────────────────────────────────────────
// The other half of the roadmap surface: agents could already read and
// place projects, now they can build the timeline itself. Structure-level:
// off-limits to list-restricted agents, workspace scope required.

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
// Agents could create spaces/folders/lists but never fix or annotate
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
    projectStatus: v.optional(
      v.union(
        v.literal("on_track"),
        v.literal("at_risk"),
        v.literal("off_track"),
        v.literal("paused"),
        v.null(),
      ),
    ),
    notes: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
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
    parentType: v.union(v.literal("space"), v.literal("folder")),
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
      const folder = await ctx.db.get(args.parentId as Id<"folders">);
      if (!folder) throw new ConvexError("Folder not found");
      await requireSpaceAccessForAgent(ctx, folder.spaceId, agent);
    }
    await reorderListsCore(ctx, args.parentType, args.parentId, args.orderedIds);
  },
});

// Regroup a list inside its space: space → folder, folder → space, folder →
// sibling folder. Both ends are access-checked independently, and
// moveListCore itself refuses any destination outside the list's current
// space — a space is a visibility boundary, so "moving" across one would
// silently change who can see the tasks.
export const moveList = mutation({
  args: {
    apiKey: v.string(),
    listId: v.id("lists"),
    parentType: v.union(v.literal("space"), v.literal("folder")),
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
      await requireFolderAccessForAgent(
        ctx,
        args.parentId as Id<"folders">,
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

// ── Folder lifecycle ───────────────────────────────────────────────────
// Agents could create folders but never fix or unpick them. Same cores the
// human sidebar calls, so renames/deletes emit `folder.renamed` /
// `folder.deleted` with the agent as the actor. Structure-level throughout.

export const renameFolder = mutation({
  args: { apiKey: v.string(), folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { folder, space } = await requireFolderAccessForAgent(
      ctx,
      args.folderId,
      agent,
    );
    await renameFolderCore(ctx, folder, space, args.name, agentActor(agent));
  },
});

// Deleting a folder is a grouping change, not a content deletion: every list
// inside it moves up to the parent space with its tasks intact.
export const deleteFolder = mutation({
  args: { apiKey: v.string(), folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    const { folder, space } = await requireFolderAccessForAgent(
      ctx,
      args.folderId,
      agent,
    );
    await removeFolderCore(ctx, folder, space, agentActor(agent));
  },
});

export const reorderFolders = mutation({
  args: {
    apiKey: v.string(),
    spaceId: v.id("spaces"),
    orderedIds: v.array(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
    await requireSpaceAccessForAgent(ctx, args.spaceId, agent);
    await reorderFoldersCore(ctx, args.spaceId, args.orderedIds);
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
    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", args.spaceId),
      )
      .collect();
    const nextListPosition = siblings.reduce(
      (max, list) => Math.max(max, list.position + 1),
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
      const listId = await ctx.db.insert("lists", {
        name: project.name,
        parentType: "space",
        parentId: args.spaceId,
        position: nextListPosition + projectIndex,
        createdAt: Date.now(),
        roadmapId,
        roadmapPhaseId: phaseId,
        roadmapPosition,
        description: project.description,
        projectStatus: project.projectStatus ?? "on_track",
        ownerActorId: project.ownerActorId,
        targetDate: project.targetDate,
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
      if (assignment.delivery === "notify_url") {
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
