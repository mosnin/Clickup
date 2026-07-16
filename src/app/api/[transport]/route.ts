import { randomBytes } from "crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";

// Hosted MCP server (Streamable HTTP) at POST /api/mcp.
//
// Any MCP-capable agent connects with just a URL and an agent API key
// (created on the Agents page):
//
//   { "url": "https://<app>/api/mcp",
//     "headers": { "Authorization": "Bearer cua_..." } }
//
// Every tool is a thin adapter over the key-authenticated Convex functions
// in convex/agentApi.ts — authorization, validation, events, and webhooks
// all live server-side there. stdio-only clients can use the proxy in
// mcp/ (npx-runnable) which bridges stdio ↔ this endpoint.

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

// The MCP boundary passes through JSON arguments; the Convex validators in
// agentApi.ts are the source of truth for shapes, so we erase the generated
// arg types here rather than re-declare 40 of them.
function asQuery(ref: unknown): FunctionReference<"query"> {
  return ref as FunctionReference<"query">;
}
function asMutation(ref: unknown): FunctionReference<"mutation"> {
  return ref as FunctionReference<"mutation">;
}
function asAction(ref: unknown): FunctionReference<"action"> {
  return ref as FunctionReference<"action">;
}

// ISO date string (or epoch ms) → epoch ms.
function ms(value: string | number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number") return value;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${value}`);
  return t;
}

const dateArg = z
  .union([z.string(), z.number()])
  .describe("ISO 8601 date/time or epoch milliseconds");
const nullableDateArg = z
  .union([z.string(), z.number(), z.null()])
  .describe("ISO 8601 date/time, epoch ms, or null to clear");

const priorityArg = z.enum(["urgent", "high", "normal", "low"]);
const checklistArg = z
  .array(
    z.object({
      id: z.string().describe("stable item id (any short unique string)"),
      text: z.string(),
      done: z.boolean(),
    }),
  )
  .describe("Full checklist (replaces the existing one)");

type ToolDef = {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod raw shapes are heterogeneous by design
  shape: Record<string, any>;
  run: (
    client: ConvexHttpClient,
    apiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by zod before reaching run()
    args: any,
  ) => Promise<unknown>;
};

const TOOLS: ToolDef[] = [
  // ── Identity & presence ──────────────────────────────────────────
  {
    name: "whoami",
    description:
      "Who am I? Returns this agent's id, name, and scope (personal space or workspace). Call once at session start; use the returned ids when other tools need them.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.whoami), { apiKey: k }),
  },
  {
    name: "heartbeat",
    description:
      "Presence ping shown live on the humans' Agents page. Call every few minutes while working. Set statusText to a short 'what I'm doing right now' line and currentTaskId to the task you're on (null to clear).",
    shape: {
      statusText: z.string().max(200).optional(),
      currentTaskId: z.string().nullable().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.heartbeat), { apiKey: k, ...a }),
  },

  // ── Structure ────────────────────────────────────────────────────
  {
    name: "get_tree",
    description:
      "The full structure of my scope: spaces → folders → lists, with ids. Start here to find where work lives.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.getTree), { apiKey: k }),
  },
  {
    name: "create_space",
    description: "Create a new space (top-level project container) in my scope.",
    shape: { name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createSpace), { apiKey: k, ...a }),
  },
  {
    name: "create_folder",
    description: "Create a folder inside a space to group lists.",
    shape: { spaceId: z.string(), name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createFolder), { apiKey: k, ...a }),
  },
  {
    name: "create_list",
    description:
      "Create a task list inside a space or folder. Seeds default statuses (To Do / In Progress / Complete / Closed).",
    shape: {
      name: z.string(),
      parentType: z.enum(["space", "folder"]),
      parentId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createList), { apiKey: k, ...a }),
  },
  {
    name: "list_statuses",
    description:
      "Workflow statuses of a list (id, name, category). Needed when setting a task's statusId directly.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listStatusesForList), { apiKey: k, ...a }),
  },

  // ── Tasks ────────────────────────────────────────────────────────
  {
    name: "list_tasks",
    description:
      "List tasks. Filter by listId or sprintId, or omit both to sweep my whole scope. assignedToMe narrows to my assignments. Completed/closed tasks are hidden unless includeCompleted.",
    shape: {
      listId: z.string().optional(),
      sprintId: z.string().optional(),
      assignedToMe: z.boolean().optional(),
      includeCompleted: z.boolean().optional(),
      limit: z.number().optional().describe("max results, default 200"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listTasks), { apiKey: k, ...a }),
  },
  {
    name: "get_task",
    description:
      "Full detail of one task: status, checklist, dependencies (with open/closed state), claim, subtasks, and the last 50 comments.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getTask), { apiKey: k, ...a }),
  },
  {
    name: "create_task",
    description:
      "Create a task. assigneeIds may mix human ids and agent ids (from list_members). checklist seeds acceptance criteria.",
    shape: {
      listId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      statusId: z.string().optional(),
      priority: priorityArg.optional(),
      startDate: dateArg.optional(),
      dueDate: dateArg.optional(),
      assigneeIds: z.array(z.string()).optional(),
      parentTaskId: z.string().optional().describe("makes this a subtask"),
      recurrence: z.enum(["daily", "weekly", "monthly"]).optional(),
      sprintId: z.string().optional(),
      checklist: checklistArg.optional(),
      requiresApproval: z
        .boolean()
        .optional()
        .describe("gate completion behind human approval"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createTask), {
        apiKey: k,
        ...a,
        startDate: ms(a.startDate) ?? undefined,
        dueDate: ms(a.dueDate) ?? undefined,
      }),
  },
  {
    name: "update_task",
    description:
      "Update any task fields. Completing via statusId fails while open blockers exist. sprintId/dates accept null to clear.",
    shape: {
      taskId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      statusId: z.string().optional(),
      priority: priorityArg.optional(),
      startDate: nullableDateArg.optional(),
      dueDate: nullableDateArg.optional(),
      assigneeIds: z.array(z.string()).optional(),
      recurrence: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
      sprintId: z.string().nullable().optional(),
      blockedByTaskIds: z.array(z.string()).optional(),
      checklist: checklistArg.optional(),
      requiresApproval: z
        .boolean()
        .optional()
        .describe("true = gate completion behind human approval (only a human can set false)"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateTask), {
        apiKey: k,
        ...a,
        startDate: ms(a.startDate),
        dueDate: ms(a.dueDate),
      }),
  },
  {
    name: "complete_task",
    description:
      "Mark a task complete (moves it to the list's Complete status, releases my claim, triggers recurrence/automations). Fails if blockers are open.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.completeTask), { apiKey: k, ...a }),
  },
  {
    name: "request_approval",
    description:
      "My work on a gated task is done, ask a human to sign off. Raises the approval gate if needed, emits task.approval_requested, and emails a responsible human. Wait for the task.approved event (or poll get_task) before complete_task.",
    shape: {
      taskId: z.string(),
      note: z.string().optional().describe("what to review / where to look"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.requestApproval), { apiKey: k, ...a }),
  },
  {
    name: "delete_task",
    description: "Delete a task (and its subtasks). Prefer completing over deleting.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteTask), { apiKey: k, ...a }),
  },
  {
    name: "claim_task",
    description:
      "Claim a task before working on it so other agents don't duplicate the work. Fails if another actor holds a fresh claim (claims expire after 60 min).",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.claimTask), { apiKey: k, ...a }),
  },
  {
    name: "release_task",
    description: "Release my claim on a task (e.g. when handing off or pausing).",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.releaseTask), { apiKey: k, ...a }),
  },
  {
    name: "set_checklist",
    description:
      "Replace a task's checklist (acceptance criteria). Read it with get_task first, then send the full updated list to tick items.",
    shape: { taskId: z.string(), items: checklistArg },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setChecklist), { apiKey: k, ...a }),
  },
  {
    name: "add_dependency",
    description: "Mark taskId as blocked by blockedByTaskId.",
    shape: { taskId: z.string(), blockedByTaskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.addDependency), { apiKey: k, ...a }),
  },
  {
    name: "remove_dependency",
    description: "Remove a blocked-by dependency from a task.",
    shape: { taskId: z.string(), blockedByTaskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.removeDependency), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "search_tasks",
    description:
      "Keyword search over task titles/descriptions in my scope. For semantic search use semantic_search.",
    shape: { query: z.string(), limit: z.number().optional() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.searchTasks), { apiKey: k, ...a }),
  },
  {
    name: "semantic_search",
    description:
      "Semantic (embedding) search over tasks and docs in my scope. Returns raw matching sources. Requires the deployment to have AI configured; otherwise configured=false.",
    shape: { query: z.string() },
    run: (c, k, a) =>
      c.action(asAction(api.agentAi.search), { apiKey: k, ...a }),
  },

  // ── Comments & mentions ──────────────────────────────────────────
  {
    name: "list_comments",
    description:
      "Comments/chat under a task, space, or workspace (workspace = team chat).",
    shape: {
      parentType: z.enum(["task", "space", "workspace", "channel"]),
      parentId: z.string(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listComments), { apiKey: k, ...a }),
  },
  {
    name: "add_comment",
    description:
      "Post a comment (task) or chat message (workspace). Mention someone by putting @[Name](id) in the body AND listing the id in mentionIds, they'll be notified.",
    shape: {
      parentType: z.enum(["task", "space", "workspace", "channel"]),
      parentId: z.string(),
      body: z.string(),
      parentMessageId: z.string().optional().describe("reply to this message"),
      mentionIds: z.array(z.string()).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.addComment), { apiKey: k, ...a }),
  },
  {
    name: "list_my_mentions",
    description:
      "My inbox: every comment that @mentioned me. Poll with unreadOnly=true to find new requests addressed to me.",
    shape: { unreadOnly: z.boolean().optional() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listMyMentions), { apiKey: k, ...a }),
  },
  {
    name: "mark_mention_read",
    description: "Mark one of my mentions as read after handling it.",
    shape: { mentionId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.markMentionRead), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_members",
    description:
      "Everyone in my scope, humans and agents, with ids usable in assigneeIds/mentionIds. Agents include live status.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listMembers), { apiKey: k }),
  },

  // ── Sprints ──────────────────────────────────────────────────────
  {
    name: "create_sprint",
    description:
      "Create a sprint (workspace-scoped timebox). Pull tasks in via update_task's sprintId.",
    shape: {
      name: z.string(),
      goal: z.string().optional(),
      startDate: dateArg,
      endDate: dateArg,
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createSprint), {
        apiKey: k,
        ...a,
        startDate: ms(a.startDate),
        endDate: ms(a.endDate),
      }),
  },
  {
    name: "list_sprints",
    description: "All sprints in my workspace, newest first.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listSprints), { apiKey: k }),
  },
  {
    name: "update_sprint",
    description:
      "Update a sprint. Setting status to 'active' starts it, 'complete' closes it (both emit events).",
    shape: {
      sprintId: z.string(),
      name: z.string().optional(),
      goal: z.string().optional(),
      startDate: dateArg.optional(),
      endDate: dateArg.optional(),
      status: z.enum(["planned", "active", "complete"]).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateSprint), {
        apiKey: k,
        ...a,
        startDate: ms(a.startDate) ?? undefined,
        endDate: ms(a.endDate) ?? undefined,
      }),
  },
  {
    name: "sprint_summary",
    description:
      "Sprint rollup: totals by status category, per-assignee counts, and every task with its state. Use for standups and progress reports.",
    shape: { sprintId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.sprintSummary), { apiKey: k, ...a }),
  },

  // ── Scheduled recurring tasks ────────────────────────────────────
  {
    name: "create_scheduled_task",
    description:
      "Time-based recurring task: 'every Monday 09:00 UTC create X in list Y'. cadence daily/weekly/monthly; dayOfWeek 0-6 (weekly), dayOfMonth 1-28 (monthly); dueInDays sets the created task's due date.",
    shape: {
      listId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      priority: priorityArg.optional(),
      assigneeIds: z.array(z.string()).optional(),
      cadence: z.enum(["daily", "weekly", "monthly"]),
      dayOfWeek: z.number().min(0).max(6).optional(),
      dayOfMonth: z.number().min(1).max(28).optional(),
      hourUtc: z.number().min(0).max(23).optional(),
      dueInDays: z.number().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createScheduledTask), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_scheduled_tasks",
    description: "Recurring task definitions on a list.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listScheduledTasks), { apiKey: k, ...a }),
  },
  {
    name: "set_scheduled_task_enabled",
    description: "Pause or resume a recurring task definition.",
    shape: { scheduledTaskId: z.string(), enabled: z.boolean() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateScheduledTask), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "delete_scheduled_task",
    description: "Delete a recurring task definition.",
    shape: { scheduledTaskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteScheduledTask), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Events & webhooks ────────────────────────────────────────────
  {
    name: "list_events",
    description:
      "Activity log for my scope (task/comment/sprint events), oldest first. Poll with sinceCreatedAt = the last event's createdAt for a cursor. Prefer register_webhook for push.",
    shape: {
      sinceCreatedAt: z.number().optional(),
      limit: z.number().optional(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listEvents), { apiKey: k, ...a }),
  },
  {
    name: "register_webhook",
    description:
      "Push events to my runtime instead of polling: POSTs each matching event to url, HMAC-SHA256 signed (X-Webhook-Signature: sha256=<hex of body with the returned secret>). eventTypes empty = all (task.*, comment.*, mention.*, sprint.*). Optional listId filter.",
    shape: {
      url: z.string().describe("https:// endpoint on my runtime"),
      eventTypes: z.array(z.string()).optional(),
      listId: z.string().optional(),
      secret: z.string().optional().describe("supply your own or one is generated"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.registerWebhook), {
        apiKey: k,
        ...a,
        secret: a.secret ?? `whsec_${randomBytes(32).toString("hex")}`,
      }),
  },
  {
    name: "list_webhooks",
    description: "Webhooks I've registered (secrets not included).",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listWebhooks), { apiKey: k }),
  },
  {
    name: "delete_webhook",
    description: "Delete one of my webhook registrations.",
    shape: { subscriptionId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteWebhook), { apiKey: k, ...a }),
  },

  // ── Skills ───────────────────────────────────────────────────────
  {
    name: "list_skills",
    description:
      "Playbooks available in this workspace (built-in + custom): sprint planning, standups, triage, kickoff, reporting, collaboration protocol. Import one with get_skill before running that kind of process.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listSkills), { apiKey: k }),
  },
  {
    name: "get_skill",
    description:
      "Fetch a skill's full markdown playbook by slug. Follow it step by step; it references these MCP tools by name.",
    shape: { slug: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getSkill), { apiKey: k, ...a }),
  },
  {
    name: "create_skill",
    description:
      "Author a new custom skill (markdown playbook) for this workspace so other agents can import it.",
    shape: {
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      content: z.string().describe("markdown playbook body"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createSkill), { apiKey: k, ...a }),
  },

  // ── Docs ─────────────────────────────────────────────────────────
  {
    name: "list_docs",
    description: "Documents in my scope (id, title, updatedAt).",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listDocs), { apiKey: k }),
  },
  {
    name: "get_doc",
    description: "Read a document as plain text.",
    shape: { docId: z.string() },
    run: (c, k, a) => c.query(asQuery(api.agentApi.getDoc), { apiKey: k, ...a }),
  },
  {
    name: "create_doc",
    description:
      "Create a document from plain text/markdown (blank line = paragraph break).",
    shape: { title: z.string(), text: z.string().optional() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createDoc), { apiKey: k, ...a }),
  },
  {
    name: "update_doc",
    description: "Replace a document's title and/or text.",
    shape: {
      docId: z.string(),
      title: z.string().optional(),
      text: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateDoc), { apiKey: k, ...a }),
  },
  // ── Dispatch & handoff ───────────────────────────────────────────
  {
    name: "next_task",
    description:
      "What should I work on next? Returns the best open, unclaimed, unblocked task(s), my assignments first (by priority, then due date), then unassigned work. Claim what it returns before starting.",
    shape: {
      includeUnassigned: z.boolean().optional().describe("default true"),
      limit: z.number().optional().describe("default 1, max 10"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.nextTask), { apiKey: k, ...a }),
  },
  {
    name: "handoff_task",
    description:
      "Hand a task to another member or agent with a context note (what's done, what's left, what I tried). Reassigns, releases my claim, posts the note as a comment mentioning them, and emits task.handoff.",
    shape: {
      taskId: z.string(),
      toId: z.string().describe("recipient id from list_members"),
      note: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.handoffTask), { apiKey: k, ...a }),
  },

  // ── Runs & errors ────────────────────────────────────────────────
  {
    name: "start_run",
    description:
      "Start a structured work session ('run') humans can see on my detail page. Pair with finish_run. Use for any multi-step piece of work.",
    shape: {
      title: z.string().describe("what this session is doing"),
      taskId: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.startRun), { apiKey: k, ...a }),
  },
  {
    name: "finish_run",
    description:
      "Finish a run with its outcome. failed runs emit an agent.error event that alerts humans.",
    shape: {
      runId: z.string(),
      status: z.enum(["succeeded", "failed", "abandoned"]),
      summary: z.string().optional(),
      error: z.string().optional(),
      links: z
        .array(z.string())
        .optional()
        .describe("artifacts produced: PR/doc/deploy URLs (max 20)"),
      tokensUsed: z.number().optional(),
      costUsd: z.number().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.finishRun), { apiKey: k, ...a }),
  },
  {
    name: "report_error",
    description:
      "Something went wrong and I can't proceed, record it so humans are alerted (agent.error event + failed run on my history). Use instead of going silent.",
    shape: {
      message: z.string(),
      taskId: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reportError), { apiKey: k, ...a }),
  },

  // ── Channels ─────────────────────────────────────────────────────
  {
    name: "list_channels",
    description:
      "Topic channels in my scope, threads for agent↔agent discussion that stay out of the main chat. Post with add_comment (parentType 'channel').",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listChannels), { apiKey: k }),
  },
  {
    name: "create_channel",
    description:
      "Create (or join, same name returns the existing channel) a topic channel, e.g. 'sprint-12-planning'.",
    shape: { name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createChannel), { apiKey: k, ...a }),
  },

  // ── Time tracking ────────────────────────────────────────────────
  {
    name: "log_time",
    description: "Log time spent on a task (shows up in reports and the task's Time section).",
    shape: {
      taskId: z.string(),
      durationMs: z.number(),
      description: z.string().optional(),
      startedAt: dateArg.optional().describe("defaults to now minus duration"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.logTime), {
        apiKey: k,
        ...a,
        startedAt: ms(a.startedAt) ?? undefined,
      }),
  },
  {
    name: "list_time_entries",
    description: "Time entries logged against a task.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listTimeEntries), { apiKey: k, ...a }),
  },

  // ── Goals ────────────────────────────────────────────────────────
  {
    name: "list_goals",
    description: "Goals/OKRs in my scope with target and current progress.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listGoals), { apiKey: k }),
  },
  {
    name: "create_goal",
    description: "Create a goal (number / money / boolean target).",
    shape: {
      title: z.string(),
      description: z.string().optional(),
      targetType: z.enum(["number", "money", "boolean"]),
      targetValue: z.number(),
      unit: z.string().optional().describe("e.g. USD"),
      dueDate: dateArg.optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createGoal), {
        apiKey: k,
        ...a,
        dueDate: ms(a.dueDate) ?? undefined,
      }),
  },
  {
    name: "set_goal_progress",
    description:
      "Update a goal's current value. Reaching the target marks it complete and emits goal.completed.",
    shape: { goalId: z.string(), currentValue: z.number() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setGoalProgress), { apiKey: k, ...a }),
  },

  // ── Automations ──────────────────────────────────────────────────
  {
    name: "list_automations",
    description: "Automation rules on a list (trigger → action).",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listAutomationsForList), { apiKey: k, ...a }),
  },
  {
    name: "create_automation",
    description:
      "Add a list automation. Triggers: task_created, status_changed_to_complete. Actions: assign_user {clerkId}, set_priority {priority}, set_status {statusId}, set_due_in_days {days}.",
    shape: {
      listId: z.string(),
      trigger: z.enum(["task_created", "status_changed_to_complete"]),
      action: z
        .object({
          kind: z.enum([
            "assign_user",
            "set_priority",
            "set_status",
            "set_due_in_days",
          ]),
          clerkId: z.string().optional(),
          priority: priorityArg.optional(),
          statusId: z.string().optional(),
          days: z.number().optional(),
        })
        .describe("only the field matching `kind` is used"),
    },
    run: (c, k, a) => {
      const { kind, clerkId, priority, statusId, days } = a.action;
      const action =
        kind === "assign_user"
          ? { kind, clerkId }
          : kind === "set_priority"
            ? { kind, priority }
            : kind === "set_status"
              ? { kind, statusId }
              : { kind, days };
      return c.mutation(asMutation(api.agentApi.createAutomation), {
        apiKey: k,
        listId: a.listId,
        trigger: a.trigger,
        action,
      });
    },
  },
  {
    name: "delete_automation",
    description: "Delete a list automation rule.",
    shape: { automationId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteAutomation), { apiKey: k, ...a }),
  },

  // ── Templates ────────────────────────────────────────────────────
  {
    name: "list_templates",
    description:
      "Built-in list templates (software sprint, marketing campaign, personal to-do, sales pipeline) that seed statuses + fields + sample tasks.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listTemplates), { apiKey: k }),
  },
  {
    name: "apply_template",
    description: "Create a new list from a template inside a space or folder.",
    shape: {
      templateId: z.string(),
      name: z.string(),
      parentType: z.enum(["space", "folder"]),
      parentId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.applyTemplate), { apiKey: k, ...a }),
  },

  // ── Custom fields ────────────────────────────────────────────────
  {
    name: "list_custom_fields",
    description:
      "Custom field definitions on a list (text/number/dropdown/date/checkbox; dropdowns carry options).",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listCustomFields), { apiKey: k, ...a }),
  },
  {
    name: "set_task_field",
    description:
      "Set a custom field value on a task. Pass exactly one of textValue/numberValue/booleanValue/dateValue matching the field's type; dropdowns take the option id in textValue.",
    shape: {
      taskId: z.string(),
      fieldId: z.string(),
      textValue: z.string().optional(),
      numberValue: z.number().optional(),
      booleanValue: z.boolean().optional(),
      dateValue: dateArg.optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setTaskFieldValue), {
        apiKey: k,
        ...a,
        dateValue: ms(a.dateValue) ?? undefined,
      }),
  },
  {
    name: "clear_task_field",
    description: "Clear a custom field value on a task.",
    shape: { taskId: z.string(), fieldId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.clearTaskFieldValue), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Comment management ───────────────────────────────────────────
  {
    name: "update_comment",
    description: "Edit one of my own comments.",
    shape: { messageId: z.string(), body: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateComment), { apiKey: k, ...a }),
  },
  {
    name: "delete_comment",
    description: "Delete one of my own comments (and its replies).",
    shape: { messageId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteComment), { apiKey: k, ...a }),
  },
  {
    name: "resolve_comment",
    description: "Resolve (or reopen) an assigned comment in my scope.",
    shape: { messageId: z.string(), resolved: z.boolean() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.resolveComment), { apiKey: k, ...a }),
  },

  // ── Billing (x402 agent payments) ─────────────────────────────────
  {
    name: "get_wallet",
    description:
      "My scope's prepaid credit balance, whether metering is on and the per-action price, the pricing (asset/network/payTo), and recent payments. Metered write actions consume credits; when the balance can't cover one, that action fails with an x402 payment-required challenge. Top up with buy_credits then settle_payment.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.x402.walletByKey), { apiKey: k }),
  },
  {
    name: "buy_credits",
    description:
      "Get an x402 payment challenge to purchase `credits` credits. Returns the standard 402 body: `accepts[0]` carries the scheme, network, asset, payTo address, and maxAmountRequired (atomic units). Build a signed X-PAYMENT authorization for those requirements, then call settle_payment.",
    shape: {
      credits: z.number().int().positive().describe("credits to purchase"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.x402.topupRequirements), { apiKey: k, ...a }),
  },
  {
    name: "settle_payment",
    description:
      "Settle a top-up: submit the base64 X-PAYMENT you built from a buy_credits challenge. Verifies and settles it through the payment facilitator, then credits my wallet. Returns the new balance and the settlement reference. Payments are single-use (replay-protected).",
    shape: {
      xPayment: z
        .string()
        .describe("base64-encoded X-PAYMENT header value"),
      credits: z
        .number()
        .int()
        .positive()
        .describe("must match the credits from buy_credits"),
    },
    run: (c, k, a) =>
      c.action(asAction(api.x402Actions.settleTopup), { apiKey: k, ...a }),
  },
];

const handler = createMcpHandler(
  (server) => {
    // Skills double as MCP resources (skill://<slug>) so clients that
    // prefer resource imports over tool calls can pull playbooks directly.
    server.resource(
      "skills",
      new ResourceTemplate("skill://{slug}", {
        list: async (extra) => {
          const apiKey = extra.authInfo?.token;
          if (!apiKey) return { resources: [] };
          try {
            const skills = (await convexClient().query(
              asQuery(api.agentApi.listSkills),
              { apiKey },
            )) as { slug: string; name: string; description: string }[];
            return {
              resources: skills.map((sk) => ({
                uri: `skill://${sk.slug}`,
                name: sk.name,
                description: sk.description,
                mimeType: "text/markdown",
              })),
            };
          } catch {
            return { resources: [] };
          }
        },
      }),
      async (uri, variables, extra) => {
        const apiKey = extra.authInfo?.token;
        if (!apiKey) throw new Error("Missing API key");
        const skill = (await convexClient().query(
          asQuery(api.agentApi.getSkill),
          { apiKey, slug: String(variables.slug) },
        )) as { content: string } | null;
        if (!skill) throw new Error(`Unknown skill: ${variables.slug}`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: skill.content,
            },
          ],
        };
      },
    );

    for (const tool of TOOLS) {
      server.tool(tool.name, tool.description, tool.shape, async (args, extra) => {
        const apiKey = extra.authInfo?.token;
        if (!apiKey) {
          return {
            content: [{ type: "text" as const, text: "Error: missing API key" }],
            isError: true,
          };
        }
        try {
          const result = await tool.run(convexClient(), apiKey, args);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result ?? { ok: true }, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      });
    }
  },
  {
    serverInfo: { name: "operate-agents", version: "1.0.0" },
  },
  {
    basePath: "/api",
    disableSse: true,
    maxDuration: 60,
  },
);

// Bearer-token auth: the token IS the agent API key. Verified upstream by
// asking Convex who it belongs to; tools then pass it through on each call
// (Convex re-validates every function).
const authHandler = withMcpAuth(
  handler,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      const me = await convexClient().query(asQuery(api.agentApi.whoami), {
        apiKey: bearerToken,
      });
      return {
        token: bearerToken,
        clientId: (me as { agentId: string }).agentId,
        scopes: [],
      };
    } catch {
      return undefined;
    }
  },
  { required: true },
);

// This file lives at app/api/[transport]/route.ts, which is a catch-all
// under /api — explicitly 404 anything that isn't the MCP endpoint so
// unknown /api/* paths never reach the MCP handler. (Static routes always
// win over this dynamic segment, so real API routes are unaffected.)
function guarded(req: Request): Promise<Response> | Response {
  const { pathname } = new URL(req.url);
  if (pathname !== "/api/mcp") {
    return new Response("Not found", { status: 404 });
  }
  return authHandler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
