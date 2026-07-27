import { randomBytes } from "crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";
import { ConvexError } from "convex/values";
import {
  toolAvailableForProfile,
  toolAnnotationsForProfile,
  toolDescriptionForProfile,
  type AnnotationProfile,
} from "@/lib/mcp-annotation-profile";

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

// One client per warm lambda, not one per call.
//
// This used to construct a ConvexHttpClient on every invocation — the auth
// handler plus every tool call — which threw away the HTTP keep-alive pool
// each time and paid a fresh TLS handshake to Convex per request. An agent
// doing a normal task makes a dozen calls in a row; that is a dozen
// handshakes it does not need. The client holds no per-request state, so
// sharing it is safe: the API key travels as a function argument.
let sharedConvexClient: ConvexHttpClient | null = null;

function convexClient(): ConvexHttpClient {
  if (sharedConvexClient) return sharedConvexClient;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  sharedConvexClient = new ConvexHttpClient(url);
  return sharedConvexClient;
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
function ms(
  value: string | number | null | undefined,
): number | null | undefined {
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
// The full ClickUp-parity custom-field type set. Kept in one place so
// create_custom_field and its docs can't drift from the Convex validator in
// convex/_customFields.ts.
const fieldTypeArg = z.enum([
  "text",
  "long_text",
  "number",
  "money",
  "dropdown",
  "labels",
  "date",
  "checkbox",
  "email",
  "phone",
  "url",
  "location",
  "rating",
  "progress",
  "people",
  "files",
  "relationship",
  "rollup",
  "formula",
  "voting",
]);

const fieldConfigArg = z
  .object({
    currency: z.string().optional().describe("money: ISO 4217, e.g. USD"),
    precision: z.number().optional().describe("number/money: 0–4 decimals"),
    min: z.number().optional(),
    max: z.number().optional(),
    ratingMax: z.number().optional().describe("rating: 2–10 stars (default 5)"),
    multiple: z
      .boolean()
      .optional()
      .describe("people/relationship: allow more than one entry"),
    relationListId: z
      .string()
      .optional()
      .describe("relationship: the list linked tasks must come from"),
    formula: z
      .string()
      .optional()
      .describe(
        'formula: arithmetic over other numeric fields, e.g. "{Hours} * {Rate}"',
      ),
    rollup: z
      .object({
        source: z.enum(["subtasks", "relationship"]),
        op: z.enum(["sum", "avg", "count"]),
        sourceFieldId: z
          .string()
          .optional()
          .describe("the numeric field being rolled up (not needed for count)"),
        relationFieldId: z
          .string()
          .optional()
          .describe('required when source is "relationship"'),
      })
      .optional(),
  })
  .describe("Per-type configuration; only the keys your type uses are read");

const checklistArg = z
  .array(
    z.object({
      id: z.string().describe("stable item id (any short unique string)"),
      text: z.string(),
      done: z.boolean(),
    }),
  )
  .describe("Full checklist (replaces the existing one)");

// Annotation hints surfaced to MCP clients on tools/list. Reads, overwrites,
// irreversible actions, and external side effects are classified independently;
// safely-retryable mutations also get idempotentHint.
const READ_TOOLS = new Set([
  "list_pages",
  "read_page",
  "get_project_updates",
  "list_open_revisions",
  "list_project_docs",
  "whoami",
  "list_wake_inbox",
  "get_tree",
  "list_statuses",
  "list_tasks",
  "get_task",
  "list_context_packets",
  "get_context_packet",
  "search_tasks",
  "semantic_search",
  "list_comments",
  "list_my_mentions",
  "list_members",
  "list_sprints",
  "sprint_summary",
  "get_sprint_board",
  "get_sprint_planning",
  "get_roadmaps",
  "list_execution_plans",
  "get_execution_plan",
  "get_outcome_assurance",
  "get_execution_policy",
  "get_execution_readiness",
  "get_execution_control",
  "list_scheduled_tasks",
  "list_events",
  "list_webhooks",
  "list_skills",
  "get_skill",
  "list_blueprints",
  "list_docs",
  "get_doc",
  "next_task",
  "list_channels",
  "list_time_entries",
  "list_goals",
  "list_automations",
  "list_templates",
  "get_template",
  "list_starter_templates",
  "list_sprint_templates",
  "list_custom_fields",
  "get_task_fields",
  "list_checklist_templates",
  "get_portfolio",
  "get_task_network",
  "list_decisions_for_task",
  "list_milestones",
  "get_wallet",
  "buy_credits", // returns a payment challenge; charges nothing by itself
]);
const DESTRUCTIVE_TOOLS = new Set([
  "rename_project",
  "delete_task",
  "delete_scheduled_task",
  "delete_webhook",
  "delete_automation",
  "delete_comment",
  "delete_list",
  "delete_project",
  "delete_context_packet",
  "detach_context_packet",
  "supersede_decision",
  "reorder_tasks",
  "update_task",
  "set_estimate",
  "complete_task",
  "claim_task",
  "release_task",
  "set_checklist",
  "remove_dependency",
  "mark_mention_read",
  "apply_sprint_template",
  "update_sprint",
  "set_sprint_capacity",
  "set_sprint_retrospective",
  "revise_execution_plan_context",
  "review_outcome_criterion",
  "reconcile_execution_plan",
  "dispatch_execution_wave",
  "remove_roadmap_phase",
  "update_roadmap_phase",
  "assign_project_to_phase",
  "assign_list_to_phase",
  "set_scheduled_task_enabled",
  "update_doc",
  "handoff_task",
  "start_run",
  "finish_run",
  "report_error",
  "set_goal_progress",
  "apply_template",
  "apply_starter_template",
  "set_task_field",
  "clear_task_field",
  "apply_checklist_template",
  "update_comment",
  "resolve_comment",
  "settle_payment",
  "rename_list",
  "update_list_meta",
  "reorder_lists",
  "move_list",
  "reorder_projects",
  "delete_milestone",
  "update_milestone",
  "set_task_milestone",
]);
const OPEN_WORLD_TOOLS = new Set([
  // Delivers future workspace events to a user-supplied external endpoint.
  "register_webhook",
  // Completes a payment through the configured external payment rail.
  "settle_payment",
]);
const IDEMPOTENT_TOOLS = new Set([
  "write_page",
  "address_revision",
  "write_project_doc",
  "create_execution_plan",
  "revise_execution_plan_context",
  "dispatch_execution_wave",
  "reconcile_execution_plan",
  "heartbeat",
  "acknowledge_wake",
  "acknowledge_task_context",
  "update_task",
  "set_estimate",
  "complete_task",
  "set_checklist",
  "add_dependency",
  "remove_dependency",
  "release_task",
  "mark_mention_read",
  "update_sprint",
  "set_sprint_capacity",
  "set_sprint_retrospective",
  "assign_project_to_phase",
  "assign_list_to_phase",
  "rename_list",
  "update_list_meta",
  "update_project_meta",
  "reorder_lists",
  "move_list",
  "rename_project",
  "reorder_projects",
  "reorder_tasks",
  "update_roadmap_phase",
  "update_milestone",
  "set_task_milestone",
  "set_scheduled_task_enabled",
  "update_doc",
  "set_goal_progress",
  "set_task_field",
  "clear_task_field",
  "update_comment",
  "resolve_comment",
  "create_channel", // create-by-name returns the existing channel
]);

function titleFor(name: string): string {
  if (name === "whoami") return "Who am I?";
  const words = name.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function annotationsFor(
  name: string,
  profile: AnnotationProfile,
): ToolAnnotations {
  const readOnly = READ_TOOLS.has(name);
  return toolAnnotationsForProfile(
    {
      title: titleFor(name),
      readOnly,
      openWorld: OPEN_WORLD_TOOLS.has(name),
      destructive: DESTRUCTIVE_TOOLS.has(name),
      idempotent: IDEMPOTENT_TOOLS.has(name),
    },
    profile,
  );
}

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
      "Who am I? Returns this agent's id, name, and scope (personal space or workspace). Call once at session start; use the returned ids when other tools need them. Also returns your role, allowed lists, remaining daily budget, and billing status — check it to know your limits before you hit them.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.whoami), { apiKey: k }),
  },
  {
    name: "list_wake_inbox",
    description:
      "My unconsumed assignment, execution-ready, and mention wakes, newest first. Use at session start and after reconnecting so a missed push cannot lose work. Each row includes its authoritative deliveryId, payload, push status, attempts, and error; call acknowledge_wake for each row before fetching current task or collaboration context.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listWakeInbox), { apiKey: k }),
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
  {
    name: "acknowledge_wake",
    description:
      "Confirm that I consumed a signed runtime wake. Call immediately with the deliveryId from a task.assigned, task.ready, or mention.created payload, before fetching the authoritative task or collaboration context. Idempotent and presence-budget exempt.",
    shape: {
      deliveryId: z.string().describe("deliveryId from the signed wake body"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.acknowledgeWakeDelivery), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Structure ────────────────────────────────────────────────────
  {
    name: "get_tree",
    description:
      "The full structure of my scope: spaces → projects → lists, with ids. Start here to find where work lives.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.getTree), { apiKey: k }),
  },
  {
    name: "create_space",
    description:
      "Create a new top-level Space in my scope. Spaces own lists, optional projects, docs, whiteboards, and templates.",
    shape: { name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createSpace), { apiKey: k, ...a }),
  },
  {
    name: "create_project",
    description:
      "Create a Project inside a Space. A Project is the unit of work people name (\"the billing migration\"); Lists are the boards of tasks inside it. Pass roadmapId (and optionally phaseId) to place it on the roadmap in the same call — do that rather than creating projects and a roadmap separately, or you get two descriptions of the same work that reference nothing.",
    shape: {
      spaceId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      targetDate: z.number().optional().describe("epoch ms"),
      roadmapId: z.string().optional(),
      phaseId: z
        .string()
        .optional()
        .describe("phase id from get_roadmaps; defaults to the first phase"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createProject), { apiKey: k, ...a }),
  },

  {
    name: "rename_project",
    description:
      "Rename a project. Fix your own typos — no human needed. projectId comes from get_tree.",
    shape: { projectId: z.string(), name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.renameProject), { apiKey: k, ...a }),
  },
  {
    name: "delete_project",
    description:
      "Delete a project. This is a grouping change, NOT a content deletion: every list inside moves up to the parent space and keeps its tasks, statuses, fields, and history.",
    shape: { projectId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteProject), { apiKey: k, ...a }),
  },
  {
    name: "reorder_projects",
    description:
      "Reorder the projects inside one space. Pass the full desired order of project ids; ids that no longer live in this space are skipped. Project order is independent of list order.",
    shape: { spaceId: z.string(), orderedIds: z.array(z.string()) },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reorderProjects), { apiKey: k, ...a }),
  },
  {
    name: "create_list",
    description:
      "Create a task list inside a space or project. Seeds default statuses (To Do / In Progress / Complete / Closed).",
    shape: {
      name: z.string(),
      parentType: z.enum(["space", "project"]),
      parentId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createList), { apiKey: k, ...a }),
  },
  {
    name: "rename_list",
    description: "Rename a list. Fix your own typos — no human needed.",
    shape: { listId: z.string(), name: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.renameList), { apiKey: k, ...a }),
  },
  {
    name: "update_list_meta",
    description:
      "Set a list's own intent: its description and attached SOP slug. null clears a field. A list is one board of tasks — health, owner, notes and target date describe the Project that owns it, so use update_project_meta for those.",
    shape: {
      listId: z.string(),
      description: z.string().nullable().optional(),
      sopSlug: z
        .string()
        .nullable()
        .optional()
        .describe("skill slug attached as this list's SOP"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateListMeta), { apiKey: k, ...a }),
  },
  {
    name: "update_project_meta",
    description:
      "Report on a project: description, health (on_track/at_risk/off_track/paused), owner, target date, and freeform notes. null clears a field. This is how you tell humans a project has slipped without waiting to be asked — it drives the status chips on Home, the projects directory, and the roadmap.",
    shape: {
      projectId: z.string(),
      description: z.string().nullable().optional(),
      projectStatus: z
        .enum(["on_track", "at_risk", "off_track", "paused"])
        .nullable()
        .optional(),
      ownerActorId: z
        .string()
        .nullable()
        .optional()
        .describe("clerkId or agent id from list_members"),
      notes: z.string().nullable().optional(),
      targetDate: z.number().nullable().optional().describe("epoch ms"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateProjectMeta), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "delete_list",
    description:
      "Delete a list and everything in it: tasks, comments, statuses, fields, automations, schedules. Irreversible — prefer rename_list for fixing mistakes. Goals tracking the list freeze at their current value.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteList), { apiKey: k, ...a }),
  },
  {
    name: "reorder_lists",
    description:
      "Reorder the lists under one space or project. Pass the full desired order of list ids.",
    shape: {
      parentType: z.enum(["space", "project"]),
      parentId: z.string(),
      orderedIds: z.array(z.string()),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reorderLists), { apiKey: k, ...a }),
  },
  {
    name: "move_list",
    description:
      "Regroup a list: into a project, back out to its space, or over to a sibling project. The destination must be in the same space as the list — a space is a visibility boundary, so crossing one is refused rather than silently changing who can see the tasks.",
    shape: {
      listId: z.string(),
      parentType: z.enum(["space", "project"]),
      parentId: z.string().describe("the destination space or project id"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.moveList), { apiKey: k, ...a }),
  },
  {
    name: "list_statuses",
    description:
      "Workflow statuses of a list (id, name, category). Needed when setting a task's statusId directly.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listStatusesForList), { apiKey: k, ...a }),
  },
  {
    name: "create_status",
    description:
      "Add a workflow status to a list (e.g. a 'QA' stage). category drives completion semantics: open, in_progress, complete, or closed.",
    shape: {
      listId: z.string(),
      name: z.string(),
      category: z.enum(["open", "in_progress", "complete", "closed"]),
      color: z
        .string()
        .optional()
        .describe("hex; defaults to the category's pastel"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createStatus), { apiKey: k, ...a }),
  },
  {
    name: "create_custom_field",
    description:
      "Add a custom field to a list. Types: text, long_text, number, money, dropdown, labels (multi-select), date, checkbox, email, phone, url, location, rating, progress, people, files, relationship, voting, plus the computed rollup and formula. dropdown/labels need options (id + label). money takes config.currency; rating config.ratingMax; number config.precision/min/max; relationship config.relationListId; formula config.formula (arithmetic over other numeric fields as {Field name}); rollup config.rollup ({ source, op, sourceFieldId, relationFieldId }). Set values with set_task_field.",
    shape: {
      listId: z.string(),
      name: z.string(),
      type: fieldTypeArg,
      options: z
        .array(
          z.object({
            id: z.string().describe("stable option id (any short string)"),
            label: z.string(),
            color: z.string().optional(),
          }),
        )
        .optional()
        .describe("dropdown and labels only"),
      config: fieldConfigArg.optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createCustomField), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Milestones ───────────────────────────────────────────────────
  {
    name: "list_milestones",
    description:
      "The dated checkpoints inside one list: name, targetDate, status, and derived progress (done/total of the tasks linked to each). Read this before planning dates — it is the list's internal timeline.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listMilestones), { apiKey: k, ...a }),
  },
  {
    name: "create_milestone",
    description:
      "Add a dated checkpoint to a list (e.g. 'Beta cut', 'Design freeze'). Link tasks to it with set_task_milestone; its progress then derives from those tasks.",
    shape: {
      listId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      targetDate: dateArg.optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createMilestone), {
        apiKey: k,
        ...a,
        targetDate: ms(a.targetDate) ?? undefined,
      }),
  },
  {
    name: "update_milestone",
    description:
      "Rename a milestone, move its target date, edit its description, or mark it complete/open. null clears an optional field; omitted fields stay untouched.",
    shape: {
      milestoneId: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      targetDate: nullableDateArg.optional(),
      status: z.enum(["open", "complete"]).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateMilestone), {
        apiKey: k,
        ...a,
        targetDate: ms(a.targetDate),
      }),
  },
  {
    name: "delete_milestone",
    description:
      "Delete a milestone. Tasks linked to it are unlinked, never deleted.",
    shape: { milestoneId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteMilestone), { apiKey: k, ...a }),
  },
  {
    name: "set_task_milestone",
    description:
      "Put a task under one of its list's milestones, or pass milestoneId null to detach it. The milestone must belong to the task's own list.",
    shape: { taskId: z.string(), milestoneId: z.string().nullable() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setTaskMilestone), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Tasks ────────────────────────────────────────────────────────
  {
    name: "list_tasks",
    description:
      "List tasks. Filter by listId or sprintId, or omit both to sweep my whole scope. assignedToMe narrows to my assignments. Completed/closed tasks are hidden unless includeCompleted. Returns at most `limit` rows (default 100, max 500); long descriptions are truncated (descriptionTruncated: true) — get_task returns the full text.",
    shape: {
      listId: z.string().optional(),
      sprintId: z.string().optional(),
      assignedToMe: z.boolean().optional(),
      includeCompleted: z.boolean().optional(),
      limit: z
        .number()
        .optional()
        .describe("max results, default 100, max 500"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listTasks), { apiKey: k, ...a }),
  },
  {
    name: "get_task",
    description:
      "Full detail of one task: status, checklist, dependencies, claim, subtasks, comments, attachments, SOP, full attached contextPackets, and versioned operating decisions. contextReadiness says which packet versions this agent acknowledged; decisions show pending/no-change/rework-required impact reviews. Clear both gates before claiming, starting a run, reporting currentTaskId, or completing.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getTask), { apiKey: k, ...a }),
  },
  {
    name: "list_context_packets",
    description:
      "List the versioned source-of-truth briefs available in a list. Packets keep objectives, constraints, decisions, and references consistent across parallel tasks.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listContextPackets), { apiKey: k, ...a }),
  },
  {
    name: "get_context_packet",
    description:
      "Read one context packet in full. Re-read when its version changes before continuing work based on it.",
    shape: { packetId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getContextPacket), { apiKey: k, ...a }),
  },
  {
    name: "create_context_packet",
    description:
      "Create a versioned source-of-truth brief for a list and optionally attach it to many tasks atomically. Use markdown sections such as Objective, Constraints, Decisions, References, and Open Questions.",
    shape: {
      listId: z.string(),
      title: z.string(),
      summary: z.string().optional(),
      content: z.string(),
      taskIds: z.array(z.string()).max(100).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createContextPacket), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "update_context_packet",
    description:
      "Update a context packet. Every material change increments its version so agents can detect stale context instead of silently diverging.",
    shape: {
      packetId: z.string(),
      title: z.string().optional(),
      summary: z.string().nullable().optional(),
      content: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateContextPacket), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "acknowledge_task_context",
    description:
      "Prove that I loaded the complete current context bundle for a task. First call get_task, read every contextPacket, then send every packetId + exact version here. Required before claim_task, start_run, heartbeat(currentTaskId), or completion whenever context is attached; any later packet update makes the receipt stale automatically.",
    shape: {
      taskId: z.string(),
      packets: z.array(
        z.object({
          packetId: z.string(),
          version: z.number(),
        }),
      ),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.acknowledgeTaskContext), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "attach_context_packet",
    description:
      "Attach one list context packet to up to 100 tasks. get_task then returns the full packet to every assigned agent.",
    shape: {
      packetId: z.string(),
      taskIds: z.array(z.string()).min(1).max(100),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.attachContextPacket), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "detach_context_packet",
    description:
      "Detach context that no longer applies to a task. The packet remains available to its other tasks.",
    shape: { packetId: z.string(), taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.detachContextPacket), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "delete_context_packet",
    description:
      "Permanently retire a list context packet and detach it from every task. Use only when the source itself is obsolete, not when it merely stops applying to one task.",
    shape: { packetId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteContextPacket), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_decisions_for_task",
    description:
      "Read every operating decision that affected a task, including superseded versions, rationale, linked context, and the task's pending/no-change/rework-required/resolved assessment. Pending or rework-required impacts block execution.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listDecisionsForTask), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "create_decision",
    description:
      "Record a new immutable operating decision for a list and mark the named tasks as needing impact review. key is a stable machine-readable name such as launch.region. Optionally link a context packet: it is attached to impacted tasks and version-bumped so prior agent acknowledgements become stale.",
    shape: {
      listId: z.string(),
      key: z.string().max(80),
      title: z.string().max(160),
      statement: z.string().max(5000),
      rationale: z.string().max(5000),
      contextPacketId: z.string().optional(),
      taskIds: z.array(z.string()).max(100),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createDecision), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "supersede_decision",
    description:
      "Replace the current active decision with an immutable next version. The previous wording remains auditable; every previously impacted task plus optional new taskIds returns to pending review, and linked context becomes stale.",
    shape: {
      decisionId: z.string(),
      title: z.string().max(160).optional(),
      statement: z.string().max(5000),
      rationale: z.string().max(5000),
      taskIds: z.array(z.string()).max(100).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.supersedeDecision), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "assess_decision_impact",
    description:
      "Assess how one decision version affects one task. no_change clears the gate; rework_required keeps execution blocked and requires a note; resolved clears a prior rework requirement after the task has been updated.",
    shape: {
      impactId: z.string(),
      status: z.enum(["no_change", "rework_required", "resolved"]),
      note: z.string().max(2000).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.assessDecisionImpact), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "create_task",
    description:
      "Create a task. assigneeIds may mix human ids and agent ids (from list_members). requiredCapabilities is an explicit execution contract; an agent missing any requirement cannot be assigned or claim it. checklist seeds acceptance criteria.",
    shape: {
      listId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      statusId: z.string().optional(),
      priority: priorityArg.optional(),
      startDate: dateArg.optional(),
      dueDate: dateArg.optional(),
      assigneeIds: z.array(z.string()).optional(),
      requiredCapabilities: z.array(z.string().max(40)).max(10).optional(),
      parentTaskId: z.string().optional().describe("makes this a subtask"),
      recurrence: z.enum(["daily", "weekly", "monthly"]).optional(),
      sprintId: z.string().optional(),
      checklist: checklistArg.optional(),
      requiresApproval: z
        .boolean()
        .optional()
        .describe("gate completion behind human approval"),
      estimatePoints: z
        .number()
        .optional()
        .describe("story points / sizing for sprint planning"),
      milestone: z
        .boolean()
        .optional()
        .describe("flag as a milestone on the Gantt/roadmap"),
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
    name: "create_tasks",
    description:
      "Create up to 50 tasks in ONE call — a whole plan-slice with inline subtasks and dependencies, instead of N create_task round-trips. Give specs a `ref` (any short handle); later specs nest under one with parentRef, and any spec can block on others with dependsOn (refs from this batch or existing task ids). Counts as one action against your budget.",
    shape: {
      listId: z.string(),
      tasks: z
        .array(
          z.object({
            ref: z
              .string()
              .optional()
              .describe("handle other specs reference; unique in the batch"),
            title: z.string(),
            description: z.string().optional(),
            statusId: z.string().optional(),
            priority: priorityArg.optional(),
            startDate: dateArg.optional(),
            dueDate: dateArg.optional(),
            assigneeIds: z.array(z.string()).optional(),
            requiredCapabilities: z
              .array(z.string().max(40))
              .max(10)
              .optional(),
            parentRef: z
              .string()
              .optional()
              .describe("ref of an EARLIER spec — makes this its subtask"),
            parentTaskId: z
              .string()
              .optional()
              .describe("existing task id to nest under"),
            dependsOn: z
              .array(z.string())
              .optional()
              .describe("refs from this batch or existing task ids"),
            sprintId: z.string().optional(),
            checklist: checklistArg.optional(),
            requiresApproval: z.boolean().optional(),
            estimatePoints: z.number().optional(),
            milestone: z.boolean().optional(),
          }),
        )
        .max(50),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createTasks), {
        apiKey: k,
        listId: a.listId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by zod above
        tasks: a.tasks.map((t: any) => ({
          ...t,
          startDate: ms(t.startDate) ?? undefined,
          dueDate: ms(t.dueDate) ?? undefined,
        })),
      }),
  },
  {
    name: "reorder_tasks",
    description:
      "Set the manual order of a list's top-level tasks ('do these in this order' without abusing dependencies). Pass the full desired order of task ids; position round-trips through list_tasks/get_task.",
    shape: { listId: z.string(), orderedIds: z.array(z.string()) },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reorderTasks), { apiKey: k, ...a }),
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
      requiredCapabilities: z.array(z.string().max(40)).max(10).optional(),
      recurrence: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
      sprintId: z.string().nullable().optional(),
      blockedByTaskIds: z.array(z.string()).optional(),
      checklist: checklistArg.optional(),
      requiresApproval: z
        .boolean()
        .optional()
        .describe(
          "true = gate completion behind human approval (only a human can set false)",
        ),
      estimatePoints: z
        .number()
        .nullable()
        .optional()
        .describe("story points / sizing; null clears it"),
      milestone: z.boolean().optional(),
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
    name: "set_estimate",
    description:
      "Set (or clear with null) a task's estimatePoints. Thin shortcut over update_task for the common case of sizing during planning.",
    shape: { taskId: z.string(), points: z.number().nullable() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setEstimate), { apiKey: k, ...a }),
  },
  {
    name: "complete_task",
    description:
      "Mark a task complete (moves it to the list's Complete status, releases my claim, triggers recurrence/automations). Fails if blockers are open or attached context changed since I acknowledged it.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.completeTask), { apiKey: k, ...a }),
  },
  {
    name: "request_approval",
    description:
      "My work on a gated task is done, ask a human to sign off. Requires the task's current context to be acknowledged, raises the approval gate if needed, emits task.approval_requested, and emails a responsible human. Wait for the task.approved event (or poll get_task) before complete_task.",
    shape: {
      taskId: z.string(),
      note: z.string().optional().describe("what to review / where to look"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.requestApproval), { apiKey: k, ...a }),
  },
  {
    name: "delete_task",
    description:
      "Delete a task (and its subtasks). Prefer completing over deleting.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.deleteTask), { apiKey: k, ...a }),
  },
  {
    name: "claim_task",
    description:
      "Claim a task before working on it so other agents don't duplicate the work. Fails if another actor holds a fresh claim or attached context is unread/stale; call get_task then acknowledge_task_context first. Claims expire after 60 min.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.claimTask), { apiKey: k, ...a }),
  },
  {
    name: "release_task",
    description:
      "Release my claim on a task (e.g. when handing off or pausing).",
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
      "Comments/chat under a task, space, workspace, or channel (workspace = team chat). Returns the newest 100.",
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
      "Everyone in my scope, humans and agents, with ids usable in assigneeIds/mentionIds. Agents include lastSeenAt, lastConnectedAt, and lastHeartbeatAt as separate live signals, plus role, capabilities, concurrency ceiling, and current task for safe routing.",
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
    description:
      "All sprints in my workspace, newest first (each row's id field is sprintId). Requires a workspace-scoped agent — personal-space agents have no workspace to hold sprints.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listSprints), { apiKey: k }),
  },
  {
    name: "list_sprint_templates",
    description:
      "Built-in sprint playbooks: each carries a length, a goal template, ceremonies, and starter tasks with estimates and acceptance criteria. Returns the catalog plus its category/complexity/use-case facets. Workspace-scoped agents only.",
    shape: {},
    run: (c, k) =>
      c.query(asQuery(api.agentApi.listSprintTemplates), { apiKey: k }),
  },
  {
    name: "apply_sprint_template",
    description:
      "Create a sprint from a template slug (list_sprint_templates). endDate is derived from the template's length. Pass listId to also materialize its ceremonies and starter tasks into that list, already attached to the sprint and with due dates clamped to the sprint window; omit it to get the timebox alone and place the work yourself. Optional name overrides the template's. Workspace-scoped agents only; the destination list must be one you're allowed to touch.",
    shape: {
      slug: z.string(),
      startDate: dateArg,
      listId: z.string().optional(),
      name: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.applySprintTemplate), {
        apiKey: k,
        ...a,
        startDate: ms(a.startDate),
      }),
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
  {
    name: "set_sprint_capacity",
    description:
      "Set (or clear with null) a sprint's capacityPoints, the team's committed-points ceiling for planning.",
    shape: { sprintId: z.string(), points: z.number().nullable() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setSprintCapacity), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "set_sprint_retrospective",
    description:
      "Write (or overwrite) a sprint's retrospective notes. Do this after the sprint completes.",
    shape: { sprintId: z.string(), text: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.setSprintRetrospective), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "get_sprint_board",
    description:
      "Board view of one sprint: every task in it with list, status, assignees, estimatePoints, milestone flag, and open-blocker count. Use to render or reason about a Kanban-style sprint board.",
    shape: { sprintId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getSprintBoard), { apiKey: k, ...a }),
  },
  {
    name: "get_sprint_planning",
    description:
      "Planning view for one sprint: the sprint itself (capacityPoints, retrospective, goal, dates, status), what's already committed (with a points total and an unestimated count), and up to 100 open backlog tasks not yet in the sprint. Use to propose what to pull in and flag over/under-capacity.",
    shape: { sprintId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getSprintPlanning), { apiKey: k, ...a }),
  },

  // ── Roadmaps ─────────────────────────────────────────────────────
  {
    name: "get_execution_policy",
    description:
      "Read the owner-controlled workspace execution policy. Returns supervised or bounded_autonomous mode, the active policy version, autonomous plan-size ceiling, per-wave task ceiling, and rolling 24-hour dispatch limit. Call before compiling or dispatching a plan; agents cannot change this policy.",
    shape: {},
    run: (c, k) =>
      c.query(asQuery(api.agentApi.getExecutionPolicy), { apiKey: k }),
  },
  {
    name: "create_execution_plan",
    description:
      "Atomically compile one conversation/brief into an auditable execution system inside one Space: a phased roadmap, 1-12 workstreams materialized as Lists, up to 100 tasks/subtasks, cross-workstream dependencies, assignments, and a versioned operating brief attached to every task. The input field remains projects for backward compatibility, but each entry is a workstream that creates one List—not another container. The immutable manifest preserves source context, success criteria, assumptions, open questions, every generated id, and its authorization source. Supervised workspaces start plans pending owner/admin review. Bounded-autonomous workspaces may policy-authorize plans only when they fit the plan-size ceiling, contain no open questions, and contain no approval-gated tasks. Reuse the same idempotencyKey to retry safely; changing the plan requires a new key. All refs are local handles: dependencies within a workstream use task refs; cross-workstream dependencies use workstreamRef.taskRef. The entire call commits or rolls back together.",
    shape: {
      idempotencyKey: z
        .string()
        .max(120)
        .describe(
          "stable caller-generated key for this exact plan, e.g. conversation id + revision",
        ),
      spaceId: z
        .string()
        .describe("workspace Space that will own the generated Lists"),
      name: z.string().max(120),
      objective: z.string().max(1000),
      sourceContext: z
        .string()
        .max(35000)
        .describe(
          "confirmed conversation/brief source; preserve facts and decisions, do not invent missing details",
        ),
      successCriteria: z.array(z.string().max(500)).min(1).max(25),
      assumptions: z
        .array(z.string().max(500))
        .max(25)
        .optional()
        .describe(
          "explicitly labeled assumptions; never hide guesses in tasks",
        ),
      openQuestions: z
        .array(z.string().max(500))
        .max(25)
        .optional()
        .describe(
          "unresolved decisions preserved in every workstream's context",
        ),
      phases: z
        .array(
          z.object({
            ref: z.string().max(64),
            name: z.string().max(120),
            targetDate: dateArg.optional(),
          }),
        )
        .min(1)
        .max(12),
      projects: z
        .array(
          z.object({
            ref: z.string().max(64),
            name: z.string().max(120),
            description: z.string().max(1000).optional(),
            phaseRef: z.string().max(64),
            projectStatus: z
              .enum(["on_track", "at_risk", "off_track", "paused"])
              .optional(),
            ownerActorId: z
              .string()
              .optional()
              .describe("human or agent id from list_members"),
            targetDate: dateArg.optional(),
            tasks: z
              .array(
                z.object({
                  ref: z.string().max(64),
                  title: z.string().max(500),
                  description: z.string().optional(),
                  priority: priorityArg.optional(),
                  startDate: dateArg.optional(),
                  dueDate: dateArg.optional(),
                  assigneeIds: z
                    .array(z.string())
                    .optional()
                    .describe("human/agent ids from list_members"),
                  requiredCapabilities: z
                    .array(z.string().max(40))
                    .max(10)
                    .optional()
                    .describe(
                      "capability slugs every assigned agent must advertise",
                    ),
                  parentRef: z
                    .string()
                    .optional()
                    .describe(
                      "earlier task ref in this workstream; creates a subtask",
                    ),
                  dependsOn: z
                    .array(z.string())
                    .optional()
                    .describe(
                      "same-workstream task refs or workstreamRef.taskRef for cross-workstream blockers",
                    ),
                  checklist: checklistArg.optional(),
                  requiresApproval: z.boolean().optional(),
                  estimatePoints: z.number().optional(),
                  milestone: z.boolean().optional(),
                }),
              )
              .min(1)
              .max(50),
          }),
        )
        .min(1)
        .max(12),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createExecutionPlan), {
        apiKey: k,
        ...a,
        phases: a.phases.map(
          (phase: {
            ref: string;
            name: string;
            targetDate?: number | string;
          }) => ({
            ...phase,
            targetDate: ms(phase.targetDate) ?? undefined,
          }),
        ),
        projects: a.projects.map(
          (project: {
            targetDate?: number | string;
            tasks: Array<{
              startDate?: number | string;
              dueDate?: number | string;
            }>;
          }) => ({
            ...project,
            targetDate: ms(project.targetDate) ?? undefined,
            tasks: project.tasks.map((task) => ({
              ...task,
              startDate: ms(task.startDate) ?? undefined,
              dueDate: ms(task.dueDate) ?? undefined,
            })),
          }),
        ),
      }),
  },
  {
    name: "revise_execution_plan_context",
    description:
      "Append confirmed new source context to an existing execution plan without rewriting its original manifest. Atomically versions every workstream context packet, making prior agent acknowledgements stale, records an append-only revision receipt, and returns dispatch to owner/admin review. Use for factual or decision updates that do not change the plan's structure; create a new plan when workstreams, dependencies, or success criteria materially change. Reuse the same idempotencyKey to retry safely.",
    shape: {
      planId: z.string(),
      idempotencyKey: z
        .string()
        .max(120)
        .describe("stable key for this exact context revision"),
      changeSummary: z
        .string()
        .max(1000)
        .describe("concise explanation of what changed and why"),
      sourceAddendum: z
        .string()
        .max(15000)
        .describe("confirmed source facts or decisions to append verbatim"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reviseExecutionPlanContext), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_execution_plans",
    description:
      "List the 20 most recent immutable execution-plan manifests in this workspace, with roadmap, workstream/task counts, unresolved-question counts, and review status.",
    shape: {},
    run: (c, k) =>
      c.query(asQuery(api.agentApi.listExecutionPlans), { apiKey: k }),
  },
  {
    name: "get_execution_plan",
    description:
      "Read the full provenance manifest for a committed execution plan: original source context, append-only context revisions, success criteria, explicit assumptions/open questions, review status, and every generated roadmap/workstream List/task id.",
    shape: { planId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getExecutionPlan), { apiKey: k, ...a }),
  },
  {
    name: "get_outcome_assurance",
    description:
      "Read plan-level outcome assurance. Every original success criterion is tracked separately as pending, evidence submitted, independently passed, or failed. A plan is verified only when every criterion passes.",
    shape: { planId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getOutcomeAssurance), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "submit_outcome_evidence",
    description:
      "Submit concrete evidence against one original plan success criterion. Requires at least one http(s) artifact URL and moves the criterion into independent review; submitting work does not verify it.",
    shape: {
      planId: z.string(),
      criterionIndex: z.number().int().min(0),
      evidenceSummary: z.string().min(1).max(2000),
      evidenceLinks: z.array(z.string().url()).min(1).max(20),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.submitOutcomeEvidence), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "review_outcome_criterion",
    description:
      "Independently pass or fail submitted evidence for one plan success criterion. An agent cannot review its own submission. Record a concrete review note; failed criteria can receive corrected evidence and be reviewed again.",
    shape: {
      planId: z.string(),
      criterionIndex: z.number().int().min(0),
      verdict: z.enum(["passed", "failed"]),
      reviewNote: z.string().min(1).max(2000),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reviewOutcomeCriterion), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "get_execution_readiness",
    description:
      "Preview the next safe parallel wave for an execution plan without changing anything. Returns dispatchAuthorized, authorization source/reason, active execution policy and version, rolling 24-hour policy capacity, ready recommendations with exact context-packet versions, fingerprints, and estimated token load, dependency/claim/lease/capability/capacity/policy skips, each agent's advertised capabilities and free slots, open-question gates, and recent waves. Pass agentIds to constrain routing to a deliberate fleet subset.",
    shape: {
      planId: z.string(),
      agentIds: z.array(z.string()).optional(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getExecutionReadiness), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "get_execution_control",
    description:
      "Read the execution ledger for a committed plan. Returns every recent dispatch attempt with its task, agent, requested delivery mode, durable wake delivery and authenticated consumption receipts, attempt evidence, claimed/running/stale/terminal lifecycle, run linkage, heartbeat freshness, evidence links, errors, retryability, context load at dispatch, current context load, version fingerprints, context drift, and truthful status totals. Active receipts with no execution heartbeat for 30 minutes are surfaced as stale even before reconciliation.",
    shape: {
      planId: z.string(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getExecutionControl), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "reconcile_execution_plan",
    description:
      "Recover a stalled execution plan without erasing history. Atomically marks active attempts abandoned after 30 minutes without an execution heartbeat, preserves the original recorded state and timeout reason, and releases only claims still held by those stale attempts. Safe to retry; returns recovered attempts, released claim count, and scan bounds. Call before retrying stale work; dispatch_execution_wave also performs this reconciliation automatically.",
    shape: {
      planId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.reconcileExecutionPlan), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "dispatch_execution_wave",
    description:
      "Atomically reconcile stale attempts, then release the next dependency-ready, capability-matched work wave to active writable agents without exceeding their concurrency ceilings or the workspace's per-wave and rolling 24-hour limits. A plan must have valid human approval or a current bounded-autonomy policy authorization; policy-authorized plans stop dispatching when that policy version changes. Pending or rejected plans cannot dispatch. Assignments snapshot context-packet count, estimated token load, and a version fingerprint so later drift is visible; agents must still fetch and acknowledge current packets before work. Configured notify URLs receive a signed task.ready through durable bounded retries whose pending/delivered/failed evidence appears in get_execution_control; otherwise a poll_required receipt is placed in list_wake_inbox. Both channels require authenticated consumption acknowledgement. A 30-minute lease prevents duplicate wake storms; expired work is preserved as abandoned before a retry receipt is created. If the plan preserves open questions, openQuestionDisposition is required so uncertainty is never silently ignored. Exact retries are idempotent.",
    shape: {
      idempotencyKey: z.string().max(120),
      planId: z.string(),
      maxTasks: z.number().int().min(1).max(25).optional(),
      agentIds: z
        .array(z.string())
        .optional()
        .describe("optional deliberate subset of workspace agent ids"),
      openQuestionDisposition: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "required when the plan has open questions; explain what was resolved, deferred, or bounded",
        ),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.dispatchExecutionWave), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "get_roadmaps",
    description:
      "The workspace's roadmaps: ordered phases (Now/Next/Later style) with the Lists in each and their done/total. Workspace-scoped agents only.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.getRoadmaps), { apiKey: k }),
  },
  {
    name: "create_roadmap",
    description:
      "Create a roadmap in my workspace. Pass explicit phases (e.g. milestones M1..M4 with targetDate) to lay out the timeline in one call — omit phases to get the Now/Next/Later defaults.",
    shape: {
      name: z.string(),
      description: z.string().optional(),
      phases: z
        .array(
          z.object({
            name: z.string(),
            targetDate: z
              .number()
              .optional()
              .describe("epoch ms the phase should land by"),
          }),
        )
        .optional()
        .describe("explicit ordered phases; skips the Now/Next/Later defaults"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createRoadmap), { apiKey: k, ...a }),
  },
  {
    name: "add_roadmap_phase",
    description: "Append a phase (with optional targetDate) to a roadmap.",
    shape: {
      roadmapId: z.string(),
      name: z.string(),
      targetDate: z.number().optional().describe("epoch ms"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.addRoadmapPhase), { apiKey: k, ...a }),
  },
  {
    name: "update_roadmap_phase",
    description:
      "Rename a roadmap phase or change its target date (null clears the date).",
    shape: {
      roadmapId: z.string(),
      phaseId: z.string().describe("phase id from get_roadmaps"),
      name: z.string().optional(),
      targetDate: z.number().nullable().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.updateRoadmapPhase), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "remove_roadmap_phase",
    description:
      "Remove a phase from a roadmap. Lists in that phase fall back to Not on roadmap — nothing is deleted.",
    shape: { roadmapId: z.string(), phaseId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.removeRoadmapPhase), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "assign_project_to_phase",
    description:
      "Put a Project into a roadmap phase, or pull it out with roadmapId null. This is what mechanically connects a roadmap to the workstreams under it — without it the roadmap and the projects describe the same work while referencing nothing. create_project can do this in one step via roadmapId/phaseId.",
    shape: {
      projectId: z.string(),
      roadmapId: z
        .string()
        .nullable()
        .describe("null removes the project from its roadmap"),
      phaseId: z
        .string()
        .optional()
        .describe("phase id from get_roadmaps; defaults to the first phase"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.assignProjectToPhase), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "assign_list_to_phase",
    description:
      "Deprecated: roadmaps sequence Projects, not Lists. Use assign_project_to_phase with a projectId.",
    shape: {
      projectId: z.string(),
      roadmapId: z.string().nullable(),
      phaseId: z.string().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.assignProjectToPhase), {
        apiKey: k,
        ...a,
      }),
  },


  // ── Scheduled recurring tasks ────────────────────────────────────
  {
    name: "create_scheduled_task",
    description:
      "Time-based recurring task: 'hourly create a health check' or 'every Monday 09:00 UTC create X in list Y'. cadence hourly/daily/weekly/monthly; hourUtc is ignored for hourly; dayOfWeek 0-6 (weekly), dayOfMonth 1-28 (monthly); dueInDays sets the created task's due date. Assigned agents receive the materialized task through signed push or their durable wake inbox.",
    shape: {
      listId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      priority: priorityArg.optional(),
      assigneeIds: z.array(z.string()).optional(),
      cadence: z.enum(["hourly", "daily", "weekly", "monthly"]),
      dayOfWeek: z.number().min(0).max(6).optional(),
      dayOfMonth: z.number().min(1).max(28).optional(),
      hourUtc: z.number().min(0).max(23).optional(),
      dueInDays: z.number().optional(),
      blueprintId: z
        .string()
        .optional()
        .describe(
          "optional reusable SOP from list_blueprints; supplies the materialized task's full controlled shape",
        ),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createScheduledTask), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_scheduled_tasks",
    description:
      "Recurring task definitions on a list (each row's id field is scheduledTaskId), including last run, next run, consecutive failures, and the last isolated materialization error. Three consecutive failures pause only that definition; healthy schedules continue.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listScheduledTasks), { apiKey: k, ...a }),
  },
  {
    name: "set_scheduled_task_enabled",
    description:
      "Pause or resume a recurring task definition. Resuming clears its recorded failure state and schedules a fresh future attempt.",
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
      "Activity log for my scope (task/comment/sprint/agent events), newest first. limit defaults to 200 (also the max). Events are retained 90 days. Poll with sinceCreatedAt = the newest createdAt you've seen for a cursor. Prefer register_webhook for push.",
    shape: {
      sinceCreatedAt: z.number().optional(),
      limit: z.number().optional().describe("default 200, max 200"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listEvents), { apiKey: k, ...a }),
  },
  {
    name: "register_webhook",
    description:
      "Push events to my runtime instead of polling: POSTs each matching event to url, HMAC-SHA256 signed (X-Webhook-Signature: sha256=<hex of body with the returned secret>). eventTypes empty = all (task.*, comment.*, mention.*, sprint.*, agent.*, goal.*). Optional listId filter.",
    shape: {
      url: z.string().describe("https:// endpoint on my runtime"),
      eventTypes: z.array(z.string()).optional(),
      listId: z.string().optional(),
      secret: z
        .string()
        .optional()
        .describe("supply your own or one is generated"),
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
    description:
      "Webhooks I've registered (each row's id field is subscriptionId; secrets not included).",
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

  // ── Task blueprints ──────────────────────────────────────────────
  {
    name: "list_blueprints",
    description:
      "Reusable task blueprints in my scope (standardized ops work: title, checklist, priority, SOP, approval gate). Instantiate one with instantiate_blueprint.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listBlueprints), { apiKey: k }),
  },
  {
    name: "create_blueprint",
    description:
      "Standardize a proven operation as a reusable task blueprint in my scope. Captures its task title, SOP description, checklist, priority, estimate, optional skill slug, due offset, and approval gate. Use the returned blueprintId with instantiate_blueprint or create_scheduled_task.",
    shape: {
      name: z.string().describe("human-readable blueprint name"),
      title: z.string().describe("title of each materialized task"),
      description: z.string().optional(),
      priority: priorityArg.optional(),
      checklist: z.array(z.string()).optional(),
      estimatePoints: z.number().nonnegative().optional(),
      sopSlug: z.string().optional(),
      dueInDays: z.number().nonnegative().optional(),
      requiresApproval: z.boolean().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createBlueprint), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "instantiate_blueprint",
    description:
      "Create a real task from a blueprint in a list. The full shape applies (checklist, priority, estimate, due-in-days, approval gate) and the list's assignment routing fills in an assignee if none is given.",
    shape: {
      blueprintId: z.string(),
      listId: z.string(),
      assigneeIds: z.array(z.string()).optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.instantiateBlueprint), {
        apiKey: k,
        ...a,
      }),
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
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getDoc), { apiKey: k, ...a }),
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
      "Start a structured work session ('run') humans can see on my detail page. Task runs require a fresh claim and current context acknowledgement, and automatically move a dispatched assignment into running. Pair with finish_run; only one active run per agent/task is allowed.",
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
      "Finish a run exactly once with its outcome and optional evidence. Exact terminal retries are safe; conflicting rewrites are rejected. A succeeded task run requires current context acknowledgement. The linked dispatch receipt becomes succeeded, failed, or abandoned; failures become recoverable and emit agent.error.",
    shape: {
      runId: z.string(),
      status: z.enum(["succeeded", "failed", "abandoned"]),
      summary: z.string().optional(),
      error: z.string().optional(),
      links: z
        .array(z.string())
        .optional()
        .describe("artifacts produced: PR/doc/deploy URLs (max 20)"),
      tokensUsed: z.number().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
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
    description:
      "Log time spent on a task (shows up in reports and the task's Time section).",
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
    description:
      "Goals/OKRs in my scope with target and current progress (each row's id field is goalId).",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listGoals), { apiKey: k }),
  },
  {
    name: "create_goal",
    description:
      "Create a goal (number / money / boolean target). Pass sourceListId to link a number goal to a List for auto-rollup: progress then derives live from that list's completed tasks (no manual set_goal_progress).",
    shape: {
      title: z.string(),
      description: z.string().optional(),
      targetType: z.enum(["number", "money", "boolean"]),
      targetValue: z.number(),
      unit: z.string().optional().describe("e.g. USD"),
      dueDate: dateArg.optional(),
      sourceListId: z
        .string()
        .optional()
        .describe("list to auto-track (number goals only)"),
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
    description:
      "Automation rules on a list (trigger → action; each row's id field is automationId).",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listAutomationsForList), {
        apiKey: k,
        ...a,
      }),
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
      c.mutation(asMutation(api.agentApi.deleteAutomation), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Templates ────────────────────────────────────────────────────
  {
    name: "list_templates",
    description:
      "Browse the Template Center: ready-made lists, tasks, docs, whiteboards, and saved views, each with what it creates (statuses/fields/task counts and sample lines). Filter by entityType, category, useCase, complexity, or a free-text search; the response also returns the facet vocabulary so you can narrow down without guessing. Read a slug in full with get_template, then create it with apply_template.",
    shape: {
      entityType: z
        .enum(["list", "task", "doc", "whiteboard", "view"])
        .optional(),
      category: z.string().optional(),
      useCase: z.string().optional(),
      complexity: z.enum(["beginner", "intermediate", "advanced"]).optional(),
      search: z.string().optional().describe("matches name, description, slug"),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listCatalogTemplates), { apiKey: k, ...a }),
  },
  {
    name: "get_template",
    description:
      "The full payload of one Template Center template — every status, field, task, checklist, doc section, or board frame it will create — plus the destinationType apply_template expects for it. Read this before applying anything you haven't used before.",
    shape: { slug: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getCatalogTemplate), { apiKey: k, ...a }),
  },
  {
    name: "apply_template",
    description:
      "Create real work from a Template Center template. destinationType depends on the entity type (get_template tells you): a list template goes into a space or project, a task or view template onto a list, a doc or whiteboard template into a space. Optional name overrides the template's own. Returns { entityType, id, name }. Creates structure, so list-restricted agents can't call it.",
    shape: {
      slug: z.string(),
      name: z.string().optional(),
      destinationType: z.enum(["space", "project", "list"]),
      destinationId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.applyCatalogTemplate), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "list_starter_templates",
    description:
      "The four built-in starter list presets (software sprint, marketing campaign, personal to-do, sales pipeline) that seed statuses + fields + sample tasks. For the richer catalog across five entity types, use list_templates.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.listTemplates), { apiKey: k }),
  },
  {
    name: "apply_starter_template",
    description:
      "Create a new list from one of the four starter presets inside a space or project. templateId comes from list_starter_templates.",
    shape: {
      templateId: z.string(),
      name: z.string(),
      parentType: z.enum(["space", "project"]),
      parentId: z.string(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.applyTemplate), { apiKey: k, ...a }),
  },

  // ── Custom fields ────────────────────────────────────────────────
  {
    name: "list_custom_fields",
    description:
      "Custom field definitions on a list: type, options, and the per-type config (currency, precision, min/max, ratingMax, relationListId, formula, rollup) plus a writeHint naming the exact argument set_task_field wants. Read this before writing any field value. Fields marked computed:true (rollup, formula) are derived and can't be written.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listCustomFields), { apiKey: k, ...a }),
  },
  {
    name: "get_task_fields",
    description:
      "Every custom field on one task with its resolved value — option labels, money amount + currency, people ids, linked task ids, files, vote counts, and the computed rollup/formula results that have no stored value. The read that pairs with set_task_field.",
    shape: { taskId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getTaskFields), { apiKey: k, ...a }),
  },
  {
    name: "set_task_field",
    description:
      "Set a custom field value on a task. Send the argument that matches the field's type (list_custom_fields returns a writeHint per field): text/long_text/email/phone/url → textValue; number/rating/progress → numberValue; money → numberValue (+ optional currency); checkbox → booleanValue; date → dateValue; dropdown → textValue holding the option id; labels → optionIds; people → actorIds (clerkIds or agent ids from list_members); relationship → taskIds; files → files; location → location; voting → booleanValue (true adds YOUR vote, false removes it). Values are validated server-side against the field's config — an empty value clears the field. rollup and formula fields are computed and refuse writes.",
    shape: {
      taskId: z.string(),
      fieldId: z.string(),
      textValue: z.string().optional(),
      numberValue: z.number().optional(),
      booleanValue: z.boolean().optional(),
      dateValue: dateArg.optional(),
      currency: z
        .string()
        .optional()
        .describe("money only: 3-letter ISO code, e.g. USD"),
      optionIds: z
        .array(z.string())
        .optional()
        .describe("labels only: the option ids to apply"),
      actorIds: z
        .array(z.string())
        .optional()
        .describe("people only: clerkIds or agent ids"),
      taskIds: z
        .array(z.string())
        .optional()
        .describe("relationship only: linked task ids"),
      location: z
        .object({
          label: z.string(),
          lat: z.number().optional(),
          lng: z.number().optional(),
        })
        .optional(),
      files: z
        .array(
          z.object({
            storageId: z.string(),
            name: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number(),
          }),
        )
        .optional()
        .describe("files only: Convex storage ids with their metadata"),
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
    description:
      "Clear a custom field value on a task. On a voting field this removes only your own vote.",
    shape: { taskId: z.string(), fieldId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.clearTaskFieldValue), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Checklist templates ──────────────────────────────────────────
  {
    name: "list_checklist_templates",
    description:
      "Reusable checklist playbooks ('Definition of done', 'Release steps') in my scope. Apply one to a task with apply_checklist_template.",
    shape: {},
    run: (c, k) =>
      c.query(asQuery(api.agentApi.listChecklistTemplates), { apiKey: k }),
  },
  {
    name: "apply_checklist_template",
    description:
      "Append a checklist template's items onto a task's existing checklist (doesn't replace it).",
    shape: { taskId: z.string(), templateId: z.string() },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.applyChecklistTemplate), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "create_checklist_template",
    description:
      "Author a new checklist template in my scope so it can be applied to tasks going forward.",
    shape: { name: z.string(), items: z.array(z.string()) },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.createChecklistTemplate), {
        apiKey: k,
        ...a,
      }),
  },

  // ── Portfolio & dependency network ───────────────────────────────
  {
    name: "get_portfolio",
    description:
      "Every List in my scope, skipping archived Spaces: name, Space, health, targetDate, and task totals (total/done/inProgress). Use for a cross-list status rollup.",
    shape: {},
    run: (c, k) => c.query(asQuery(api.agentApi.getPortfolio), { apiKey: k }),
  },
  {
    name: "get_task_network",
    description:
      "A list's tasks with their blocked-by edges and status categories, so I can reason about dependency order (what's ready to start, what's gating what) without fetching every task individually.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getTaskNetwork), { apiKey: k, ...a }),
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
      "Returns an x402 payment challenge (network, asset, amount, payTo) to purchase `credits` credits — the standard 402 body, with `accepts[0]` carrying the scheme, network, asset, payTo address, and maxAmountRequired (atomic units). Requires an external EIP-3009-capable wallet/signer to produce the X-PAYMENT authorization — if you don't have signing capability, ask a human to top up the wallet from the Billing tab. Then call settle_payment.",
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
      xPayment: z.string().describe("base64-encoded X-PAYMENT header value"),
      credits: z
        .number()
        .int()
        .positive()
        .describe("must match the credits from buy_credits"),
    },
    run: (c, k, a) =>
      c.action(asAction(api.x402Actions.settleTopup), { apiKey: k, ...a }),
  },
  // ── Revisions and project context ──────────────────────────────────────
  // Open revisions and pinned context already ride get_task's reply; these
  // cover what that read has no room for — project-level asks, the full text
  // of a long brief, and writing back.
  {
    name: "list_open_revisions",
    description:
      "Corrections still outstanding on my work: someone asked for a change and it has not been addressed yet. Covers whole-project asks as well as per-task ones. Read these before picking up new work — an open revision on a task you already 'finished' means it is not finished. Optional listId narrows to one project.",
    shape: {
      listId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listOpenRevisions), { apiKey: k, ...a }),
  },
  {
    name: "address_revision",
    description:
      "Report a revision as addressed, with a note saying what actually changed. This does NOT close it — a human accepts or reopens it, the same way approval gates work. Do the work first, then call this.",
    shape: {
      revisionId: z.string(),
      note: z
        .string()
        .optional()
        .describe("What you changed. Be specific; a person reads this."),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.addressRevision), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "request_revision",
    description:
      "Ask for a change on a task or a project — the same object a human uses, pointed the other way. Use it when work handed to you is wrong or underspecified and you need a person (or another agent) to fix it, instead of guessing.",
    shape: {
      parentType: z.enum(["task", "list"]),
      parentId: z.string(),
      body: z.string().describe("What needs to change, and why"),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.requestRevision), {
        apiKey: k,
        ...a,
      }),
  },
  {
    name: "get_project_updates",
    description:
      "What changed in MY projects since I last looked — the projects I hold work in, not the whole account. Returns a per-project digest: recent activity by other people and agents (never my own), revisions still open on me, and gated tasks waiting on a human. Pass the `cursor` from the previous reply as `since` to get only what is new. Poll this instead of list_events when you want to know what needs doing.",
    shape: {
      since: z
        .number()
        .optional()
        .describe("The `cursor` from your previous call. Omit on first call."),
      limit: z.number().int().min(1).max(100).optional(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.getProjectUpdates), { apiKey: k, ...a }),
  },
  {
    name: "list_project_docs",
    description:
      "The context documents attached to a project: the brief, decisions, constraints, references — everything a task description has no room for. Pinned docs are the canonical ones. Read these before planning work in an unfamiliar project.",
    shape: { listId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listProjectDocs), { apiKey: k, ...a }),
  },
  {
    name: "write_project_doc",
    description:
      "Create or update a project context document. Plain text in, one paragraph per line; it opens and edits like any doc a person wrote. Pass docId to update an existing one. Set pinnedContext to mark it as canonical, so it travels automatically with every get_task on that project.",
    shape: {
      listId: z.string(),
      title: z.string(),
      text: z.string(),
      docId: z.string().optional(),
      pinnedContext: z.boolean().optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.writeProjectDoc), {
        apiKey: k,
        ...a,
      }),
  },
  // ── Pages ──────────────────────────────────────────────────────────────
  {
    name: "list_pages",
    description:
      "The long-form documents in my scope: briefs, specs, decision records, runbooks. This is where the reasoning lives that a task description has no room for. Search covers titles and body text.",
    shape: {
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.listPages), { apiKey: k, ...a }),
  },
  {
    name: "read_page",
    description:
      "The full markdown of one page, exactly as stored — not a rendering of it. Read the pages attached to a project before planning work in it; they are the brief.",
    shape: { pageId: z.string() },
    run: (c, k, a) =>
      c.query(asQuery(api.agentApi.readPage), { apiKey: k, ...a }),
  },
  {
    name: "write_page",
    description:
      "Create or update a page, in markdown. Omit pageId to create, pass it to rewrite in place. Use this for anything worth keeping that outlives a comment: an investigation writeup, a design you settled on, a runbook. Pass attachTo to pin it where the work is, so people and other agents find it without searching. Link pages to each other with [[Page title]].",
    shape: {
      pageId: z.string().optional(),
      title: z.string().optional(),
      markdown: z.string(),
      attachTo: z
        .object({
          targetType: z.enum([
            "workspace",
            "space",
            "project",
            "list",
            "task",
            "agent",
            "goal",
            "sprint",
          ]),
          targetId: z.string(),
        })
        .optional(),
    },
    run: (c, k, a) =>
      c.mutation(asMutation(api.agentApi.writePage), { apiKey: k, ...a }),
  },
];

// Renamed tools, kept reachable under their old names.
//
// Folders became Projects — the same layer with the meaning it always should
// have had. An agent mid-run holds a tool list from before the rename, and
// having its next call fail with "unknown tool" is a worse outcome than
// answering it. These delegate to the canonical implementation and are hidden
// from tools/list, so new agents only ever learn the current name.
const DEPRECATED_TOOL_ALIASES: Record<string, string> = {
  create_folder: "create_project",
  rename_folder: "rename_project",
  delete_folder: "delete_project",
  reorder_folders: "reorder_projects",
};

const ALIAS_TOOLS = Object.entries(DEPRECATED_TOOL_ALIASES).flatMap(
  ([legacy, canonical]) => {
    const target = TOOLS.find((t) => t.name === canonical);
    if (!target) return [];
    return [{ ...target, name: legacy, deprecatedAliasOf: canonical }];
  },
);

// Legacy names inherit the canonical tool's read-only / idempotent
// classification, so the request guard treats an alias call exactly like the
// call it forwards to.
for (const [legacy, canonical] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
  if (READ_TOOLS.has(canonical)) READ_TOOLS.add(legacy);
  if (IDEMPOTENT_TOOLS.has(canonical)) IDEMPOTENT_TOOLS.add(legacy);
}

function createOperateMcpHandler(profile: AnnotationProfile) {
  return createMcpHandler(
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

      for (const tool of [...TOOLS, ...ALIAS_TOOLS].filter((candidate) =>
        toolAvailableForProfile(candidate.name, profile),
      )) {
        server.registerTool(
          tool.name,
          {
            description: toolDescriptionForProfile(
              tool.name,
              tool.description,
              profile,
            ),
            inputSchema: tool.shape,
            // A stable envelope lets modern clients consume structured results
            // without pretending every heterogeneous Operate response has the
            // same domain shape. Compact text remains for older MCP clients.
            outputSchema: {
              result: z.unknown().describe("The tool's JSON-compatible result"),
            },
            annotations: annotationsFor(tool.name, profile),
          },
          async (args, extra) => {
            const apiKey = extra.authInfo?.token;
            if (!apiKey) {
              return {
                content: [
                  { type: "text" as const, text: "Error: missing API key" },
                ],
                isError: true,
              };
            }
            try {
              const result = await tool.run(convexClient(), apiKey, args);
              const normalizedResult = result ?? { ok: true };
              return {
                content: [
                  {
                    type: "text" as const,
                    // Compact on purpose: pretty-printing roughly doubles the
                    // token cost of every list-shaped response.
                    text: JSON.stringify(normalizedResult),
                  },
                ],
                structuredContent: { result: normalizedResult },
              };
            } catch (err) {
              // ConvexError.data survives production redaction (plain Error
              // messages become "Server Error" on the wire) — surface it so
              // refusal messages and the x402 challenge reach the agent intact.
              let message: string;
              if (err instanceof ConvexError) {
                message =
                  typeof err.data === "string"
                    ? err.data
                    : JSON.stringify(err.data);
              } else {
                message = err instanceof Error ? err.message : String(err);
              }
              return {
                content: [{ type: "text" as const, text: `Error: ${message}` }],
                isError: true,
              };
            }
          },
        );
      }
    },
    {
      serverInfo: { name: "operate-agents", version: "1.0.0" },
      instructions:
        "You are an agent teammate in operate.to. The hierarchy is Workspace → Space → Project → List → Task → Subtask. A Project is the unit of work people name; a List is one board of tasks inside it. A List may also sit straight in a Space when it needs no project around it. A roadmap sequences existing Projects into phases; it is not another container. First: call whoami, then get_execution_policy, then fetch the collaboration-protocol skill with get_skill and follow it. Find work with next_task; call get_task, read every attached context packet, acknowledge_task_context with exact versions, and assess every pending operating-decision impact before claim_task. Never bury a policy change in a comment: use create_decision or supersede_decision so affected tasks are revalidated. Start a run for claimed work, heartbeat while working, finish the run with evidence, and complete_task when done. Turning a whole confirmed conversation or brief into a multi-workstream roadmap? Prefer create_execution_plan: choose one Space, preserve the source, treat each projects input entry as a workstream that materializes as a Project with its lists, label assumptions and open questions, use real ids and advertised capabilities from list_members, and commit the complete dependency graph atomically. If confirmed source facts change without changing structure, use revise_execution_plan_context so every workstream advances together and stale acknowledgements are invalidated; use a new plan for structural changes. Supervised plans require owner/admin approval. A bounded-autonomous policy may authorize only plans within its task ceiling with no open questions or approval-gated tasks; agents must never claim or change authorization. Before parallel execution, inspect get_execution_readiness and release only a currently authorized, capability-matched, capacity-safe, policy-bounded dispatch_execution_wave; use get_execution_control to monitor claims, runs, evidence, failures, and retryable attempts. A stale receipt is not active work: call reconcile_execution_plan before manually retrying it; dispatch also reconciles transactionally and preserves the timed-out attempt. Completed tasks do not prove the objective: submit artifacts against each original success criterion with submit_outcome_evidence, then have a different agent or human independently review every criterion; get_outcome_assurance is the source of truth and the plan is verified only when all criteria pass. Coming back after a break, or idle? Call get_project_updates (pass the previous cursor as since) to see what changed in your projects, which revisions are open on you, and what is waiting on a human — act on that before looking for new work. An open revision on a task you already finished means it is not finished. Writing something down that outlives a comment — an investigation, a design decision, a runbook? Use write_page and pin it to the project or task with attachTo; read_page and list_pages are how you pick up context somebody (human or agent) already wrote. Use create_tasks for smaller additions to an existing List. All ids are opaque strings returned by tools; dates accept ISO 8601 or epoch ms.",
    },
    {
      basePath: "/api",
      disableSse: true,
      maxDuration: 60,
    },
  );
}

const handler = createOperateMcpHandler("openai");
const chatgptHandler = createOperateMcpHandler("chatgpt");
const anthropicHandler = createOperateMcpHandler("anthropic");

// Bearer-token auth: the token IS the agent API key. Verified upstream by
// asking Convex who it belongs to; tools then pass it through on each call
// (Convex re-validates every function).
const authHandler = withMcpAuth(
  handler,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      const me = await convexClient().mutation(
        asMutation(api.agentApi.connect),
        {
          apiKey: bearerToken,
        },
      );
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
const anthropicAuthHandler = withMcpAuth(
  anthropicHandler,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      const me = await convexClient().mutation(
        asMutation(api.agentApi.connect),
        {
          apiKey: bearerToken,
        },
      );
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
const chatgptAuthHandler = withMcpAuth(
  chatgptHandler,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      const me = await convexClient().mutation(
        asMutation(api.agentApi.connect),
        {
          apiKey: bearerToken,
        },
      );
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
const MCP_BROWSER_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://claude.ai",
  "https://claude.com",
]);

function withCors(req: Request, response: Response) {
  const origin = req.headers.get("origin");
  if (!origin || !MCP_BROWSER_ORIGINS.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  );
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function guarded(req: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  if (pathname !== "/api/mcp") {
    return new Response("Not found", { status: 404 });
  }
  // Streamable HTTP formally asks clients to advertise both response types.
  // A large share of first connections are hand-written curl commands,
  // though, and older examples only sent Content-Type. Normalize that narrow
  // case at our boundary so a valid JSON-RPC request does not authenticate,
  // turn the agent green, and then confusingly fail with HTTP 406.
  let transportRequest = req;
  if (req.method === "POST") {
    const accept = req.headers.get("accept") ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    ) {
      const headers = new Headers(req.headers);
      headers.set("Accept", "application/json, text/event-stream");
      // NextRequest carries framework-private state and cannot safely be used
      // as the Request constructor's input in the production edge wrapper.
      // Rebuild a plain standards Request from the public URL/body instead.
      transportRequest = new Request(req.url, {
        method: req.method,
        headers,
        body: await req.arrayBuffer(),
      });
    }
  }
  const profile = searchParams.get("profile");
  const selectedHandler =
    profile === "claude"
      ? anthropicAuthHandler
      : profile === "chatgpt"
        ? chatgptAuthHandler
        : authHandler;
  const response = await selectedHandler(transportRequest);
  if (response.status !== 401) return withCors(req, response);
  const headers = new Headers(response.headers);
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    new URL(req.url).origin;
  headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  );
  return withCors(
    req,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

function options(req: Request) {
  return withCors(req, new Response(null, { status: 204 }));
}

export {
  guarded as GET,
  guarded as POST,
  guarded as DELETE,
  options as OPTIONS,
};

// Vercel function config, and the reason first reads were returning 502.
//
// The `maxDuration: 60` passed to createMcpHandler above only governs
// mcp-handler's own SSE keepalive — it does NOT raise the platform's function
// timeout. Without this export the route ran on the account default (10-15s),
// so a cold start plus a broad first read (get_tree over a whole workspace,
// whoami against a sleeping Convex deployment) was killed mid-flight and the
// caller saw an upstream 502 rather than a tool error. Tool-level failures are
// already caught and returned as isError; only the timeout escaped.
export const maxDuration = 60;
// Node, not edge: the Convex client and mcp-handler both assume it.
export const runtime = "nodejs";
// Never cached or statically evaluated — every request carries a bearer key.
export const dynamic = "force-dynamic";
