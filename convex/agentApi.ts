import { v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  agentActor,
  requireAgentByKey,
  requireListAccessForAgent,
  requireSpaceAccessForAgent,
  requireTaskAccessForAgent,
  requireWorkspaceAccessForAgent,
  canAgentAccessSpace,
} from "./_agentAuth";
import {
  claimTaskCore,
  createTaskCore,
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
  parentType: "task" | "space" | "workspace",
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
  parentType: "task" | "space" | "workspace",
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
    const { agent, key } = await requireAgentByKey(ctx, args.apiKey);
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
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
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
          lists: lists.map((l) => ({ listId: l._id, name: l.name })),
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
        lists: lists.map((l) => ({ listId: l._id, name: l.name })),
      });
    }
    return { scopeType: agent.parentType, scopeId: agent.parentId, spaces: out };
  },
});

export const createSpace = mutation({
  args: { apiKey: v.string(), name: v.string() },
  handler: async (ctx, { apiKey, name }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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

const DEFAULT_STATUSES: {
  name: string;
  color: string;
  category: "open" | "in_progress" | "complete" | "closed";
}[] = [
  { name: "To Do", color: "#94a3b8", category: "open" },
  { name: "In Progress", color: "#3b82f6", category: "in_progress" },
  { name: "Complete", color: "#22c55e", category: "complete" },
  { name: "Closed", color: "#64748b", category: "closed" },
];

export const createList = mutation({
  args: {
    apiKey: v.string(),
    name: v.string(),
    parentType: v.union(v.literal("space"), v.literal("folder")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    // Seed the same defaults as lists.create so every list is usable.
    for (let i = 0; i < DEFAULT_STATUSES.length; i++) {
      await ctx.db.insert("listStatuses", {
        listId,
        ...DEFAULT_STATUSES[i],
        position: i,
        createdAt: Date.now(),
      });
    }
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
            const ts = await ctx.db
              .query("tasks")
              .withIndex("by_list", (q) => q.eq("listId", l._id))
              .collect();
            tasks.push(...ts);
          }
        }
      }
    }

    if (args.assignedToMe) {
      tasks = tasks.filter((t) => t.assigneeClerkIds.includes(agent._id));
    }
    const views = [];
    for (const t of tasks) {
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
    return {
      ...view,
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
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
    await requireTaskAccessForAgent(ctx, args.taskId, agent);
    const { apiKey: _apiKey, ...rest } = args;
    await updateTaskCore(ctx, rest, agentActor(agent));
  },
});

// Move the task to its list's first complete-category status.
export const completeTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await removeTaskCore(ctx, taskId, agentActor(agent));
  },
});

export const claimTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    await requireTaskAccessForAgent(ctx, taskId, agent);
    await claimTaskCore(ctx, taskId, agentActor(agent));
  },
});

export const releaseTask = mutation({
  args: { apiKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { apiKey, taskId }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    ),
    parentId: v.string(),
    body: v.string(),
    parentMessageId: v.optional(v.id("messages")),
    mentionIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, args.apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
    const { agent } = await requireAgentByKey(ctx, apiKey);
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
