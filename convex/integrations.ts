import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./_authz";

const kindValidator = v.literal("slack");

async function requireWorkspaceAdmin(
  ctx: Parameters<typeof requireIdentity>[0],
  workspaceId: import("./_generated/dataModel").Id<"workspaces">,
) {
  const identity = await requireIdentity(ctx);
  const m = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!m) throw new Error("Forbidden");
  if (m.role !== "owner" && m.role !== "admin") {
    throw new Error("Only workspace owners or admins can manage integrations");
  }
  return identity;
}

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!m) return [];
    return await ctx.db
      .query("integrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

export const upsertSlack = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    webhookUrl: v.string(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireWorkspaceAdmin(ctx, args.workspaceId);
    if (!/^https:\/\/hooks\.slack\.com\//.test(args.webhookUrl)) {
      throw new Error(
        "Slack webhook URLs must start with https://hooks.slack.com/",
      );
    }
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_workspace_and_kind", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("kind", "slack"),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        config: { webhookUrl: args.webhookUrl },
        enabled: args.enabled ?? existing.enabled,
      });
      return existing._id;
    }
    return await ctx.db.insert("integrations", {
      workspaceId: args.workspaceId,
      kind: "slack",
      enabled: args.enabled ?? true,
      config: { webhookUrl: args.webhookUrl },
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const setEnabled = mutation({
  args: { integrationId: v.id("integrations"), enabled: v.boolean() },
  handler: async (ctx, { integrationId, enabled }) => {
    const integration = await ctx.db.get(integrationId);
    if (!integration) throw new Error("Integration not found");
    await requireWorkspaceAdmin(ctx, integration.workspaceId);
    await ctx.db.patch(integrationId, { enabled });
  },
});

export const remove = mutation({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, { integrationId }) => {
    const integration = await ctx.db.get(integrationId);
    if (!integration) return;
    await requireWorkspaceAdmin(ctx, integration.workspaceId);
    await ctx.db.delete(integrationId);
  },
});

// Used by tasks.ts to look up the slack webhook for a given workspace
// before scheduling the post.
export { kindValidator };
