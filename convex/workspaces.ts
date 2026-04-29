import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const baseSlug = slugify(name) || "workspace";
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
      name,
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

    return workspaceId;
  },
});

export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();

    const workspaces = await Promise.all(
      memberships.map((m) => ctx.db.get(m.workspaceId)),
    );

    return workspaces
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .map((w, i) => ({ ...w, role: memberships[i].role }));
  },
});
