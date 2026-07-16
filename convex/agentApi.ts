import { v } from "convex/values";
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
  requireListAccessForAgent,
  requireSpaceAccessForAgent,
  requireTaskAccessForAgent,
  requireUnrestricted,
  requireWorkspaceAccessForAgent,
  canAgentAccessSpace,
} from "./_agentAuth";
import {
  CLAIM_TTL_MS,
  claimTaskCore,
  createTaskCore,
  handoffTaskCore,
  releaseTaskCore,
  removeTaskCore,
  updateTaskCore,
} from "./tasks";
import { createMessageCore, scopeForMessageParent } from "./messages";
import {
  createSprintCore,
  sprintSummaryCore,
  updateSprintCore,
} from "./sprints";
import { createScheduledTaskCore, computeNextRunAt } from "./scheduledTasks";
import { createSubscription } from "./webhooks";
import { skillsForScope } from "./skills";
import { createChannelCore } from "./channels";
import { applyListTemplateCore, templateCatalog } from "./templates";
import { seedDefaultStatuses } from "./listStatuses";
import { emitEvent, scopeForList } from "./events";

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

// ── Shared helpers ─────────────────────────────────────────────────────

function scopeOf(agent: Doc<"agents">): {
  scopeType: "user" | "workspace";
  scopeId: string;
} {
  return { scopeType: agent.parentType, scopeId: agent.parentId };
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
    throw new Error("Forbidden");
  }
}

async function requireDocAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  docId: Id<"docs">,
  agent: Doc<"agents">,
): Promise<Doc<"docs">> {
  const doc = await ctx.db.get(docId);
  if (!doc) throw new Error("Doc not found");
  if (doc.parentType === "space") {
    const space = await ctx.db.get(doc.parentId as Id<"spaces">);
    if (!space || !canAgentAccessSpace(space, agent)) {
      throw new Error("Forbidden");
    }
  } else if (
    doc.parentType !== agent.parentType ||
    doc.parentId !== agent.parentId
  ) {
    throw new Error("Forbidden");
  }
  return doc;
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
    parentTaskId: task.parentTaskId,
    sprintId: task.sprintId,
    recurrence: task.recurrence,
    checklist: task.checklist ?? [],
    blockedBy: blockers,
    requiresApproval: task.requiresApproval ?? false,
    approvedAt: task.approvedAt,
    claimedBy: task.claimedByActorId,
    claimedAt: task.claimedAt,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
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
    return {
      agentId: agent._id,
      name: agent.name,
      description: agent.description,
      scopeType: agent.parentType,
      scopeId: agent.parentId,
      scopeName,
      statusText: agent.statusText,
      currentTaskId: agent.currentTaskId,
    };
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
    const patch: Record<string, unknown> = { lastSeenAt: Date.now() };
    if (args.statusText !== undefined) {
      patch.statusText = args.statusText.slice(0, 200) || undefined;
    }
    if (args.currentTaskId !== undefined) {
      if (args.currentTaskId === null) {
        patch.currentTaskId = undefined;
      } else {
        await requireTaskAccessForAgent(ctx, args.currentTaskId, agent);
        patch.currentTaskId = args.currentTaskId;
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
            .map((l) => ({ listId: l._id, name: l.name })),
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
          .map((l) => ({ listId: l._id, name: l.name })),
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
    if (!name.trim()) throw new Error("Name is required");
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

export const createFolder = mutation({
  args: { apiKey: v.string(), spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { apiKey, spaceId, name }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    requireUnrestricted(agent);
    await requireSpaceAccessForAgent(ctx, spaceId, agent);
    if (!name.trim()) throw new Error("Name is required");
    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    return await ctx.db.insert("folders", {
      name: name.trim(),
      spaceId,
      position: siblings.length,
      createdAt: Date.now(),
    });
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
    if (!args.name.trim()) throw new Error("Name is required");
    if (args.parentType === "space") {
      await requireSpaceAccessForAgent(
        ctx,
        args.parentId as Id<"spaces">,
        agent,
      );
    } else {
      const folder = await ctx.db.get(args.parentId as Id<"folders">);
      if (!folder) throw new Error("Folder not found");
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
      if (!sprint) throw new Error("Sprint not found");
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
    const max = Math.min(args.limit ?? 200, 500);
    const views = [];
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
      views.push(view);
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
    return {
      ...view,
      fieldValues: fieldValues.map((fv) => ({
        fieldId: fv.fieldId,
        textValue: fv.textValue,
        numberValue: fv.numberValue,
        booleanValue: fv.booleanValue,
        dateValue: fv.dateValue,
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
    parentTaskId: v.optional(v.id("tasks")),
    recurrence: v.optional(
      v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly")),
    ),
    sprintId: v.optional(v.id("sprints")),
    checklist: v.optional(checklistValidator),
    requiresApproval: v.optional(v.boolean()),
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
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const { apiKey: _apiKey, ...rest } = args;
    await updateTaskCore(ctx, rest, agentActor(agent));
  },
});

// Move the task to its list's first complete-category status.
export const completeTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, taskId, agent);
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", task.listId))
      .collect();
    const complete = statuses
      .sort((a, b) => a.position - b.position)
      .find((s) => s.category === "complete");
    if (!complete) throw new Error("List has no complete status");
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
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await claimTaskCore(ctx, taskId, agentActor(agent));
  },
});

export const releaseTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    await requireTaskAccessForAgent(ctx, taskId, agent);
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
    return all
      .sort((a, b) => a.createdAt - b.createdAt)
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
      throw new Error("Mention not found");
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
      });
    }
    return members;
  },
});

// ── Sprints ────────────────────────────────────────────────────────────

function requireWorkspaceAgent(agent: Doc<"agents">): Id<"workspaces"> {
  if (agent.parentType !== "workspace") {
    throw new Error("Sprints require a workspace-scoped agent");
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
    return sprints.sort((a, b) => b.startDate - a.startDate);
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
      throw new Error("Sprint not found");
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
      throw new Error("Sprint not found");
    }
    return await sprintSummaryCore(ctx, sprintId);
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
    return await ctx.db
      .query("scheduledTasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
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
    if (!st) throw new Error("Not found");
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
    return subs.map(({ secret: _secret, ...rest }) => rest);
  },
});

export const deleteWebhook = mutation({
  args: { apiKey: v.string(), subscriptionId: v.id("webhookSubscriptions") },
  handler: async (ctx, { apiKey, subscriptionId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey, "write");
    const sub = await ctx.db.get(subscriptionId);
    if (!sub) return;
    if (sub.ownerType !== "agent" || sub.ownerId !== agent._id) {
      throw new Error("Forbidden");
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
    if (!slug) throw new Error("Slug is required");
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
      )
      .collect();
    if (existing.some((s) => s.slug === slug)) {
      throw new Error("A skill with this slug already exists");
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
    const results: { taskId: Id<"tasks">; listId: Id<"lists">; title: string }[] = [];
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
              results.push({ taskId: t._id, listId: l._id, title: t.title });
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
        throw new Error("Recipient is not in this scope");
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
      if (!member) throw new Error("Recipient is not in this scope");
    } else if (args.toId !== agent.parentId) {
      throw new Error("Recipient is not in this scope");
    }
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
    if (args.taskId) await requireTaskAccessForAgent(ctx, args.taskId, agent);
    return await ctx.db.insert("agentRuns", {
      agentId: agent._id,
      taskId: args.taskId,
      title: args.title.slice(0, 200),
      status: "running",
      startedAt: Date.now(),
    });
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
    if (!run || run.agentId !== agent._id) throw new Error("Run not found");
    await ctx.db.patch(args.runId, {
      status: args.status,
      summary: args.summary?.slice(0, 2000),
      error: args.error?.slice(0, 2000),
      links: args.links?.slice(0, 20),
      tokensUsed: args.tokensUsed,
      costUsd: args.costUsd,
      finishedAt: Date.now(),
    });
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
    await ctx.db.insert("agentRuns", {
      agentId: agent._id,
      taskId: args.taskId,
      title: "Error report",
      status: "failed",
      error: args.message.slice(0, 2000),
      startedAt: now,
      finishedAt: now,
    });
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
    if (args.durationMs <= 0) throw new Error("durationMs must be positive");
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
    return await ctx.db
      .query("goals")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", agent.parentType).eq("parentId", agent.parentId),
      )
      .collect();
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
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    requireUnrestricted(agent);
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
      throw new Error("Goal not found");
    }
    const complete = args.currentValue >= goal.targetValue;
    await ctx.db.patch(args.goalId, {
      currentValue: args.currentValue,
      status: complete ? "complete" : "open",
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
    return await ctx.db
      .query("listAutomations")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
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

// ── List templates ─────────────────────────────────────────────────────

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
      if (!folder) throw new Error("Folder not found");
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
      }));
  },
});

export const setTaskFieldValue = mutation({
  args: {
    apiKey: v.string(),
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    textValue: v.optional(v.string()),
    numberValue: v.optional(v.number()),
    booleanValue: v.optional(v.boolean()),
    dateValue: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const { task } = await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const field = await ctx.db.get(args.fieldId);
    if (!field || field.listId !== task.listId) {
      throw new Error("Field does not belong to this task's list");
    }
    const existing = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", args.taskId).eq("fieldId", args.fieldId),
      )
      .unique();
    const patch = {
      textValue: args.textValue,
      numberValue: args.numberValue,
      booleanValue: args.booleanValue,
      dateValue: args.dateValue,
    };
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
    if (existing) await ctx.db.delete(existing._id);
  },
});

// ── Comment management (author-only) ───────────────────────────────────

export const updateComment = mutation({
  args: { apiKey: v.string(), messageId: v.id("messages"), body: v.string() },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey, "write");
    const msg = await ctx.db.get(args.messageId);
    if (!msg || msg.authorClerkId !== agent._id) {
      throw new Error("Only the author can edit");
    }
    if (!args.body.trim()) throw new Error("Empty message");
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
      throw new Error("Only the author can delete");
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
    if (!msg) throw new Error("Message not found");
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
