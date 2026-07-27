import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireProjectAccess,
  requireListAccess,
  requireSpaceAccess,
} from "./_authz";
import { seedDefaultStatuses } from "./listStatuses";
import { createTaskCore } from "./tasks";
import { userActor } from "./events";
import type { Actor } from "./_agentAuth";
import {
  boardSnapshot,
  docContent,
  findTemplate,
  templateCenterCatalog,
  type CatalogField,
  type CatalogSeedTask,
  type CatalogStatus,
} from "./templateCatalog";

// Hardcoded list templates. Each one is just "what to insert when applied"
// — list config, status set, custom fields, and seed tasks. We keep this
// as code (not data) so templates ship with the app and don't need a CMS.

type TemplateStatus = {
  name: string;
  color: string;
  category: "open" | "in_progress" | "complete" | "closed";
};

type TemplateField =
  | {
      name: string;
      type: "text" | "number" | "date" | "checkbox";
    }
  | {
      name: string;
      type: "dropdown";
      options: { label: string; color?: string }[];
    };

type TemplateTask = {
  title: string;
  description?: string;
  // Position in the list of statuses (0 = first). Defaults to 0.
  statusIndex?: number;
};

type ListTemplate = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  color?: string;
  // If undefined, falls back to the four default statuses.
  statuses?: TemplateStatus[];
  fields?: TemplateField[];
  tasks?: TemplateTask[];
};

const LIST_TEMPLATES: ListTemplate[] = [
  {
    id: "software-sprint",
    name: "Software sprint",
    emoji: "",
    color: "#c6bcf2",
    description:
      "Backlog → In Progress → Review → Done with story points and sprint tags.",
    statuses: [
      { name: "Backlog", color: "#c9ccd4", category: "open" },
      { name: "In Progress", color: "#a9c6f2", category: "in_progress" },
      { name: "Review", color: "#f2d491", category: "in_progress" },
      { name: "Done", color: "#a9dcbd", category: "complete" },
    ],
    fields: [
      { name: "Story Points", type: "number" },
      {
        name: "Sprint",
        type: "dropdown",
        options: [
          { label: "Sprint 1", color: "#c6bcf2" },
          { label: "Sprint 2", color: "#a9dcbd" },
          { label: "Sprint 3", color: "#f2d491" },
        ],
      },
    ],
    tasks: [
      { title: "Set up CI", statusIndex: 0 },
      { title: "Wire up auth", statusIndex: 0 },
      { title: "First deploy", statusIndex: 1 },
    ],
  },
  {
    id: "marketing-campaign",
    name: "Marketing campaign",
    emoji: "",
    color: "#f2c291",
    description:
      "Brief → Drafting → Review → Published, with a Channel dropdown.",
    statuses: [
      { name: "Brief", color: "#c9ccd4", category: "open" },
      { name: "Drafting", color: "#a9c6f2", category: "in_progress" },
      { name: "Review", color: "#f2d491", category: "in_progress" },
      { name: "Published", color: "#a9dcbd", category: "complete" },
    ],
    fields: [
      {
        name: "Channel",
        type: "dropdown",
        options: [
          { label: "Email", color: "#a9c6f2" },
          { label: "Social", color: "#a9dcbd" },
          { label: "Blog", color: "#f2d491" },
        ],
      },
    ],
    tasks: [
      { title: "Define audience and messaging" },
      { title: "Draft hero copy" },
      { title: "Schedule launch posts" },
    ],
  },
  {
    id: "personal-todo",
    name: "Personal to-do",
    emoji: "",
    color: "#a9dcbd",
    description: "A simple personal list with starter tasks.",
    tasks: [
      { title: "Take a walk" },
      { title: "Read for 20 minutes" },
      { title: "Plan the week" },
    ],
  },
  {
    id: "sales-pipeline",
    name: "Sales pipeline",
    emoji: "",
    color: "#a9c6f2",
    description:
      "Leads → Qualified → Proposal → Closed Won / Lost with Deal Value.",
    statuses: [
      { name: "Leads", color: "#c9ccd4", category: "open" },
      { name: "Qualified", color: "#a9c6f2", category: "in_progress" },
      { name: "Proposal", color: "#f2d491", category: "in_progress" },
      { name: "Closed Won", color: "#a9dcbd", category: "complete" },
      { name: "Closed Lost", color: "#c2c2ca", category: "closed" },
    ],
    fields: [
      { name: "Deal Value", type: "number" },
      { name: "Close date", type: "date" },
    ],
  },
];

export const list = query({
  args: {},
  handler: async () => {
    return LIST_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
      description: t.description,
    }));
  },
});

const parentTypeValidator = v.union(
  v.literal("space"),
  v.literal("project"),
);

// Shared with the agent API: creates the list + statuses + fields +
// seed tasks in one transaction. `creatorId` is a clerkId or agent id.
export async function applyListTemplateCore(
  ctx: MutationCtx,
  args: {
    templateId: string;
    name: string;
    parentType: "space" | "project";
    parentId: string;
  },
  creatorId: string,
): Promise<Id<"lists">> {
    const template = LIST_TEMPLATES.find((t) => t.id === args.templateId);
    if (!template) throw new ConvexError("Unknown template");

    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    const listId = await ctx.db.insert("lists", {
      name: args.name.trim() || template.name,
      color: template.color,
      parentType: args.parentType,
      parentId: args.parentId,
      position: siblings.length,
      createdAt: Date.now(),
    });

    // Statuses: either the template's set or the default 4 from
    // listStatuses.seedDefaultStatuses.
    let statusIds: Id<"listStatuses">[];
    if (template.statuses && template.statuses.length > 0) {
      statusIds = [];
      for (let i = 0; i < template.statuses.length; i++) {
        const s = template.statuses[i];
        const id = await ctx.db.insert("listStatuses", {
          listId,
          name: s.name,
          color: s.color,
          category: s.category,
          position: i,
          createdAt: Date.now(),
        });
        statusIds.push(id);
      }
    } else {
      statusIds = await seedDefaultStatuses(ctx, listId);
    }

    if (template.fields) {
      for (let i = 0; i < template.fields.length; i++) {
        const field = template.fields[i];
        const options =
          field.type === "dropdown"
            ? field.options.map((opt) => ({
                id: crypto.randomUUID(),
                label: opt.label,
                color: opt.color,
              }))
            : undefined;
        await ctx.db.insert("customFields", {
          listId,
          name: field.name,
          type: field.type,
          options,
          position: i,
          createdAt: Date.now(),
        });
      }
    }

    if (template.tasks) {
      for (let i = 0; i < template.tasks.length; i++) {
        const t = template.tasks[i];
        const idx = Math.min(t.statusIndex ?? 0, statusIds.length - 1);
        await ctx.db.insert("tasks", {
          listId,
          title: t.title,
          description: t.description,
          statusId: statusIds[idx],
          assigneeClerkIds: [],
          createdByClerkId: creatorId,
          position: i,
          createdAt: Date.now(),
        });
      }
    }

    return listId;
}

export const applyListTemplate = mutation({
  args: {
    templateId: v.string(),
    name: v.string(),
    parentType: parentTypeValidator,
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const { identity } =
      args.parentType === "space"
        ? await requireSpaceAccess(ctx, args.parentId as Id<"spaces">)
        : await requireProjectAccess(ctx, args.parentId as Id<"projects">);
    return await applyListTemplateCore(ctx, args, identity.subject);
  },
});

// Metadata for the agent API (no auth needed for the static catalog).
export function templateCatalog() {
  return LIST_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    description: t.description,
  }));
}

// ── Template Center ─────────────────────────────────────────────────────
//
// The catalog in `templateCatalog.ts` covers five entity types, not just
// lists. Each core below materialises one of them through the product's
// real write paths — `createTaskCore` for tasks (so automations, events,
// notifications and rollups fire exactly as they do for a hand-typed
// task), and the same row shapes `docs.create` / `whiteboards.create` /
// `savedViews.create` write for the rest. Nothing here is a private door
// into the database.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Applying a template must never silently overrun the per-list cap that
// savedViews.create enforces.
const MAX_VIEWS_PER_LIST = 20;

function checklistFor(items: string[] | undefined) {
  if (!items || items.length === 0) return undefined;
  return items.map((text) => ({
    id: crypto.randomUUID(),
    text,
    done: false,
  }));
}

function dueAt(dueInDays: number | undefined, now: number) {
  return dueInDays === undefined ? undefined : now + dueInDays * ONE_DAY_MS;
}

function statusRows(statuses: CatalogStatus[], listId: Id<"lists">, now: number) {
  return statuses.map((s, i) => ({
    listId,
    name: s.name,
    color: s.color,
    category: s.category,
    position: i,
    createdAt: now,
  }));
}

function fieldRow(field: CatalogField, listId: Id<"lists">, position: number, now: number) {
  return {
    listId,
    name: field.name,
    type: field.type,
    options:
      field.type === "dropdown"
        ? field.options.map((opt) => ({
            id: crypto.randomUUID(),
            label: opt.label,
            color: opt.color,
          }))
        : undefined,
    position,
    createdAt: now,
  };
}

async function seedTask(
  ctx: MutationCtx,
  listId: Id<"lists">,
  statusIds: Id<"listStatuses">[],
  task: CatalogSeedTask,
  actor: Actor,
  now: number,
): Promise<Id<"tasks">> {
  const idx = Math.min(
    Math.max(task.statusIndex ?? 0, 0),
    statusIds.length - 1,
  );
  return await createTaskCore(
    ctx,
    {
      listId,
      title: task.title,
      description: task.description,
      statusId: statusIds[idx],
      priority: task.priority,
      checklist: checklistFor(task.checklist),
      estimatePoints: task.estimatePoints,
      dueDate: dueAt(task.dueInDays, now),
    },
    actor,
  );
}

export async function applyCatalogListTemplateCore(
  ctx: MutationCtx,
  args: {
    slug: string;
    name?: string;
    parentType: "space" | "project";
    parentId: string;
  },
  actor: Actor,
): Promise<Id<"lists">> {
  const template = findTemplate(args.slug);
  if (!template || template.entityType !== "list") {
    throw new ConvexError(`Unknown list template "${args.slug}"`);
  }
  const payload = template.list;
  const now = Date.now();

  const siblings = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", args.parentType).eq("parentId", args.parentId),
    )
    .collect();

  const listId = await ctx.db.insert("lists", {
    name: args.name?.trim() || template.name,
    color: payload.color,
    parentType: args.parentType,
    parentId: args.parentId,
    position: siblings.length,
    createdAt: now,
  });

  let statusIds: Id<"listStatuses">[];
  if (payload.statuses && payload.statuses.length > 0) {
    statusIds = [];
    for (const row of statusRows(payload.statuses, listId, now)) {
      statusIds.push(await ctx.db.insert("listStatuses", row));
    }
  } else {
    statusIds = await seedDefaultStatuses(ctx, listId);
  }

  const fields = payload.fields ?? [];
  for (let i = 0; i < fields.length; i++) {
    await ctx.db.insert("customFields", fieldRow(fields[i], listId, i, now));
  }

  for (const task of payload.tasks ?? []) {
    await seedTask(ctx, listId, statusIds, task, actor, now);
  }

  return listId;
}

export async function applyCatalogTaskTemplateCore(
  ctx: MutationCtx,
  args: { slug: string; name?: string; listId: Id<"lists"> },
  actor: Actor,
): Promise<Id<"tasks">> {
  const template = findTemplate(args.slug);
  if (!template || template.entityType !== "task") {
    throw new ConvexError(`Unknown task template "${args.slug}"`);
  }
  const payload = template.task;
  const now = Date.now();

  const taskId = await createTaskCore(
    ctx,
    {
      listId: args.listId,
      title: args.name?.trim() || payload.title,
      description: payload.description,
      priority: payload.priority,
      checklist: checklistFor(payload.checklist),
      estimatePoints: payload.estimatePoints,
      requiresApproval: payload.requiresApproval,
      dueDate: dueAt(payload.dueInDays, now),
    },
    actor,
  );

  for (const title of payload.subtasks ?? []) {
    await createTaskCore(
      ctx,
      { listId: args.listId, title, parentTaskId: taskId },
      actor,
    );
  }

  return taskId;
}

export async function applyCatalogDocTemplateCore(
  ctx: MutationCtx,
  args: {
    slug: string;
    name?: string;
    parentType: "user" | "workspace" | "space";
    parentId: string;
  },
  creatorId: string,
): Promise<Id<"docs">> {
  const template = findTemplate(args.slug);
  if (!template || template.entityType !== "doc") {
    throw new ConvexError(`Unknown doc template "${args.slug}"`);
  }
  const now = Date.now();
  const docId = await ctx.db.insert("docs", {
    parentType: args.parentType,
    parentId: args.parentId,
    title: args.name?.trim() || template.doc.title,
    content: docContent(template.doc.body),
    createdByClerkId: creatorId,
    updatedAt: now,
    createdAt: now,
  });
  // Same follow-up docs.create schedules, so a templated doc is searchable
  // by the AI Brain the moment it exists.
  await ctx.scheduler.runAfter(0, internal.ai.indexDocument, { docId });
  return docId;
}

export async function applyCatalogWhiteboardTemplateCore(
  ctx: MutationCtx,
  args: {
    slug: string;
    name?: string;
    parentType: "user" | "workspace" | "space";
    parentId: string;
  },
  creatorId: string,
): Promise<Id<"whiteboards">> {
  const template = findTemplate(args.slug);
  if (!template || template.entityType !== "whiteboard") {
    throw new ConvexError(`Unknown whiteboard template "${args.slug}"`);
  }
  const now = Date.now();
  return await ctx.db.insert("whiteboards", {
    parentType: args.parentType,
    parentId: args.parentId,
    title: args.name?.trim() || template.whiteboard.title,
    snapshot: boardSnapshot(template.whiteboard.frames),
    createdByClerkId: creatorId,
    updatedAt: now,
    createdAt: now,
  });
}

export async function applyCatalogViewTemplateCore(
  ctx: MutationCtx,
  args: { slug: string; name?: string; listId: Id<"lists"> },
  creatorId: string,
): Promise<Id<"savedViews">> {
  const template = findTemplate(args.slug);
  if (!template || template.entityType !== "view") {
    throw new ConvexError(`Unknown view template "${args.slug}"`);
  }
  const payload = template.view;
  const name = (args.name?.trim() || payload.name).slice(0, 60);

  const existing = await ctx.db
    .query("savedViews")
    .withIndex("by_list", (q) => q.eq("listId", args.listId))
    .collect();
  if (existing.length >= MAX_VIEWS_PER_LIST) {
    throw new ConvexError(
      "This list already has the maximum number of saved views",
    );
  }
  if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new ConvexError("A view with that name already exists on this list");
  }

  return await ctx.db.insert("savedViews", {
    listId: args.listId,
    name,
    view: payload.view,
    flags: payload.flags,
    priority: payload.priority,
    createdByClerkId: creatorId,
    createdAt: Date.now(),
  });
}

// Everything the Template Center's filter row needs, derived from the
// catalog so a new entry can never leave a facet behind. Static content —
// no auth needed, and no data leaks through it.
export const catalog = query({
  args: {},
  handler: async () => templateCenterCatalog(),
});

const destinationValidator = v.union(
  v.literal("space"),
  v.literal("project"),
  v.literal("list"),
);

export type ApplyCatalogResult = {
  entityType: "list" | "task" | "doc" | "whiteboard" | "view";
  name: string;
  /** Where to send the person who just applied it. */
  href: string;
};

export const applyCatalogTemplate = mutation({
  args: {
    slug: v.string(),
    name: v.optional(v.string()),
    destinationType: destinationValidator,
    destinationId: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyCatalogResult> => {
    const template = findTemplate(args.slug);
    if (!template) {
      throw new ConvexError(
        `Unknown template "${args.slug}". Read templates.catalog for the available slugs.`,
      );
    }

    // Each entity type has exactly one shape of destination. Checking it
    // here keeps every core below able to trust its arguments.
    const allowed: Record<string, ("space" | "project" | "list")[]> = {
      list: ["space", "project"],
      task: ["list"],
      doc: ["space"],
      whiteboard: ["space"],
      view: ["list"],
    };
    if (!allowed[template.entityType].includes(args.destinationType)) {
      throw new ConvexError(
        `A ${template.entityType} template can't be applied to a ${args.destinationType}`,
      );
    }

    // Authorization resolves up the hierarchy exactly as every other write
    // path does — the picker in the UI is convenience, this is the boundary.
    const { identity } =
      args.destinationType === "space"
        ? await requireSpaceAccess(ctx, args.destinationId as Id<"spaces">)
        : args.destinationType === "project"
          ? await requireProjectAccess(ctx, args.destinationId as Id<"projects">)
          : await requireListAccess(ctx, args.destinationId as Id<"lists">);

    const actor = await userActor(ctx, identity.subject);

    if (template.entityType === "list") {
      const listId = await applyCatalogListTemplateCore(
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
        name: args.name?.trim() || template.name,
        href: `/dashboard/l/${listId}`,
      };
    }

    if (template.entityType === "task") {
      const listId = args.destinationId as Id<"lists">;
      const taskId = await applyCatalogTaskTemplateCore(
        ctx,
        { slug: args.slug, name: args.name, listId },
        actor,
      );
      return {
        entityType: "task",
        name: args.name?.trim() || template.task.title,
        href: `/dashboard/l/${listId}/t/${taskId}`,
      };
    }

    if (template.entityType === "doc") {
      const docId = await applyCatalogDocTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          parentType: "space",
          parentId: args.destinationId,
        },
        identity.subject,
      );
      return {
        entityType: "doc",
        name: args.name?.trim() || template.doc.title,
        href: `/dashboard/d/${docId}`,
      };
    }

    if (template.entityType === "whiteboard") {
      const whiteboardId = await applyCatalogWhiteboardTemplateCore(
        ctx,
        {
          slug: args.slug,
          name: args.name,
          parentType: "space",
          parentId: args.destinationId,
        },
        identity.subject,
      );
      return {
        entityType: "whiteboard",
        name: args.name?.trim() || template.whiteboard.title,
        href: `/dashboard/wb/${whiteboardId}`,
      };
    }

    const listId = args.destinationId as Id<"lists">;
    await applyCatalogViewTemplateCore(
      ctx,
      { slug: args.slug, name: args.name, listId },
      identity.subject,
    );
    const params = new URLSearchParams();
    params.set("view", template.view.view);
    if (template.view.flags) params.set("f", template.view.flags);
    if (template.view.priority) params.set("pri", template.view.priority);
    return {
      entityType: "view",
      name: args.name?.trim() || template.view.name,
      href: `/dashboard/l/${listId}?${params.toString()}`,
    };
  },
});
