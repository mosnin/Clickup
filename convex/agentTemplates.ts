import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { emitEvent, userActor } from "./events";

// Agent templates — one-click, pre-governed agent configs for the agentic
// company. Like list templates (convex/templates.ts), these live in code:
// a template presets the name, persona, permission role, and daily action
// budget so a team can stand up a whole fleet without hand-tuning each
// agent's governance. The plaintext key is still minted separately (once,
// client-side) exactly like a hand-created agent.

export type AgentTemplate = {
  slug: string;
  name: string;
  emoji: string;
  tagline: string;
  description: string;
  role: "member" | "readonly";
  dailyActionLimit: number;
  // Built-in skill slugs worth importing for this persona (informational).
  recommendedSkills: string[];
};

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    slug: "triage",
    name: "Triage",
    emoji: "",
    tagline: "Keeps the backlog clean",
    description:
      "Sorts new tasks into the right lists, sets priorities, and flags stale or duplicate work so humans start each day on a tidy board.",
    role: "member",
    dailyActionLimit: 1500,
    recommendedSkills: ["collaboration-protocol"],
  },
  {
    slug: "sprint-planner",
    name: "Sprint Planner",
    emoji: "",
    tagline: "Plans and runs the sprint",
    description:
      "Proposes sprint scope from the backlog, opens the sprint, keeps the rollup honest, and closes it with a summary at the end of the timebox.",
    role: "member",
    dailyActionLimit: 1000,
    recommendedSkills: ["collaboration-protocol", "sprint-planner"],
  },
  {
    slug: "qa-reviewer",
    name: "QA Reviewer",
    emoji: "",
    tagline: "Reviews completed work",
    description:
      "Checks acceptance criteria on finished tasks, comments with what's missing, and re-opens anything that doesn't meet the checklist.",
    role: "member",
    dailyActionLimit: 1500,
    recommendedSkills: ["collaboration-protocol"],
  },
  {
    slug: "docs-writer",
    name: "Docs Writer",
    emoji: "",
    tagline: "Drafts and maintains docs",
    description:
      "Turns completed work into changelogs and docs, keeps the knowledge tree current, and drafts the weekly digest from the activity feed.",
    role: "member",
    dailyActionLimit: 800,
    recommendedSkills: ["collaboration-protocol"],
  },
  {
    slug: "research-analyst",
    name: "Research Analyst",
    emoji: "",
    tagline: "Searches and summarizes",
    description:
      "Runs semantic search across tasks and docs to answer questions, then writes findings into a linked doc with sources.",
    role: "member",
    dailyActionLimit: 600,
    recommendedSkills: ["collaboration-protocol"],
  },
  {
    slug: "watchtower",
    name: "Watchtower",
    emoji: "",
    tagline: "Read-only monitor",
    description:
      "A safe, read-only observer: polls the event stream, watches for overdue work and stalled agents, and reports, but never writes.",
    role: "readonly",
    dailyActionLimit: 2000,
    recommendedSkills: ["collaboration-protocol"],
  },
];

export const listTemplates = query({
  args: {},
  handler: async () => AGENT_TEMPLATES,
});

// Create an agent from a template with its preset governance. Access is
// the same as agents.create (own personal space or a member workspace).
export const createFromTemplate = mutation({
  args: {
    slug: v.string(),
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    nameOverride: v.optional(v.string()),
  },
  handler: async (ctx, { slug, parentType, parentId, nameOverride }) => {
    const identity = await requireIdentity(ctx);
    // Scope check: personal space must be the caller's; workspace requires
    // membership.
    if (parentType === "user") {
      if (parentId !== identity.subject) throw new Error("Forbidden");
    } else {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("workspaceId", parentId as Id<"workspaces">),
        )
        .unique();
      if (!membership) throw new Error("Forbidden");
    }

    const tpl = AGENT_TEMPLATES.find((t) => t.slug === slug);
    if (!tpl) throw new Error("Unknown template");

    const agentId = await ctx.db.insert("agents", {
      name: (nameOverride ?? tpl.name).trim() || tpl.name,
      description: tpl.description,
      parentType,
      parentId,
      status: "active",
      role: tpl.role,
      dailyActionLimit: tpl.dailyActionLimit,
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });

    await emitEvent(ctx, {
      scopeType: parentType,
      scopeId: parentId,
      type: "agent.created",
      actor: await userActor(ctx, identity.subject),
      entityType: "agent",
      entityId: agentId,
      entityTitle: tpl.name,
      payload: { template: slug },
    });

    return agentId;
  },
});
