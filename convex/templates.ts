import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  requireFolderAccess,
  requireSpaceAccess,
} from "./_authz";
import { seedDefaultStatuses } from "./listStatuses";

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
  v.literal("folder"),
);

// Shared with the agent API: creates the list + statuses + fields +
// seed tasks in one transaction. `creatorId` is a clerkId or agent id.
export async function applyListTemplateCore(
  ctx: MutationCtx,
  args: {
    templateId: string;
    name: string;
    parentType: "space" | "folder";
    parentId: string;
  },
  creatorId: string,
): Promise<Id<"lists">> {
    const template = LIST_TEMPLATES.find((t) => t.id === args.templateId);
    if (!template) throw new Error("Unknown template");

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
        : await requireFolderAccess(ctx, args.parentId as Id<"folders">);
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
