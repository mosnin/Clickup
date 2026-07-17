import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertNotSuspended } from "./_authz";
import type { Id } from "./_generated/dataModel";
import { seedDefaultStatuses } from "./listStatuses";
import { createTaskCore } from "./tasks";
import { userActor } from "./events";

// First-run setup: one transaction that builds the new user's world —
// workspace, HQ space, a "Getting started" list with real, teaching
// tasks, and their first agent. Tasks go through createTaskCore so the
// activity feed has life in it from the very first render. The agent's
// API key is minted separately by the client (agentKeys.createKey needs
// the Node CSPRNG).

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const completeSetup = mutation({
  args: {
    workspaceName: v.string(),
    agentName: v.string(),
    agentEmoji: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await assertNotSuspended(ctx, identity.subject);
    const workspaceName = args.workspaceName.trim();
    const agentName = args.agentName.trim() || "Scout";
    if (!workspaceName) throw new Error("Workspace name is required");

    // Workspace + owner membership (same shape as workspaces.create).
    const baseSlug = slugify(workspaceName) || "workspace";
    let slug = baseSlug;
    let suffix = 1;
    while (
      await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    ) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: workspaceName,
      slug,
      ownerClerkId: identity.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: identity.subject,
      role: "owner",
      joinedAt: Date.now(),
    });

    // HQ space + Getting started list.
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      color: "#a9c6f2",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Getting started",
      color: "#a9dcbd",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await seedDefaultStatuses(ctx, listId);

    // The first agent.
    const agentId = await ctx.db.insert("agents", {
      name: agentName,
      description: "Your first agent. Connect it over MCP and hand it work.",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });

    // Teaching tasks — each one demonstrates a real capability. Routed
    // through createTaskCore so events/automations behave like any task.
    const actor = await userActor(ctx, identity.subject);

    await createTaskCore(
      ctx,
      {
        listId,
        title: `Connect ${agentName} to your runtime`,
        description: [
          `${agentName} lives here; its brain runs wherever you run agents (Claude Code, a cron job, anything MCP-capable).`,
          ``,
          `1. Copy the API key you were shown during setup (or mint a new one on the Agents page).`,
          `2. Point your runtime at  <your app URL>/api/mcp  with header  Authorization: Bearer <key>.`,
          `3. Tell it to call get_skill("collaboration-protocol") first.`,
          ``,
          `The moment it heartbeats, its dot on the Agents page turns green.`,
        ].join("\n"),
        priority: "high",
        checklist: [
          { id: "c1", text: "Copy the API key", done: false },
          { id: "c2", text: "Add the MCP server to your agent runtime", done: false },
          { id: "c3", text: `Watch ${agentName} come online`, done: false },
        ],
      },
      actor,
    );

    await createTaskCore(
      ctx,
      {
        listId,
        title: `${agentName}'s first task, watch it work`,
        description: [
          `This task is already assigned to ${agentName}. Once connected, it will find this via next_task, claim it, heartbeat while working, and complete it.`,
          ``,
          `Watch it happen live on the Agents page activity feed.`,
        ].join("\n"),
        assigneeIds: [agentId],
        priority: "normal",
        checklist: [
          { id: "c1", text: "Claim this task", done: false },
          { id: "c2", text: "Post a comment saying hello", done: false },
          { id: "c3", text: "Complete the task", done: false },
        ],
      },
      actor,
    );

    await createTaskCore(
      ctx,
      {
        listId,
        title: "Try the approval gate",
        description: [
          `This task is gated: ${agentName} can do the work but can't complete it until you approve.`,
          ``,
          `When it finishes, it will request your approval. Check your Inbox for the "Waiting on your approval" queue and click Approve.`,
        ].join("\n"),
        assigneeIds: [agentId],
        requiresApproval: true,
        checklist: [
          { id: "c1", text: `${agentName} does the work`, done: false },
          { id: "c2", text: "You approve from the Inbox", done: false },
        ],
      },
      actor,
    );

    await createTaskCore(
      ctx,
      {
        listId,
        title: "Invite your team: humans and agents",
        description:
          "Teammates see everything agents do and can assign, approve, and course-correct. Add more agents from the Agents page, each gets its own key, role, and budget.",
        priority: "low",
      },
      actor,
    );

    return { workspaceId, spaceId, listId, agentId };
  },
});
