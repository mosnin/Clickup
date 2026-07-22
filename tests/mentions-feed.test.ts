import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// mentions.feedForCurrent must never leave a card permanently dead: rows
// whose parent is a "space" (no dedicated chat page) or a personal-scoped
// ("user") channel must fall back to /dashboard/inbox rather than
// href: null, mirroring convex/messages.ts's mentionHref fallback.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_me", email: "me@acme.com" };

describe("mentions.feedForCurrent href fallback", () => {
  it("falls back to /dashboard/inbox for a space-parented mention", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
      const spaceId = await ctx.db.insert("spaces", {
        name: "Personal",
        parentType: "user",
        parentId: ME.subject,
        position: 0,
        createdAt: Date.now(),
      });
      const messageId = await ctx.db.insert("messages", {
        parentType: "space",
        parentId: spaceId,
        authorClerkId: "user_other",
        body: `hey @[Me](${ME.subject})`,
        createdAt: Date.now(),
      });
      await ctx.db.insert("mentions", {
        messageId,
        mentionedClerkId: ME.subject,
        parentType: "space",
        parentId: spaceId,
        createdAt: Date.now(),
      });
    });

    const feed = await t.withIdentity(ME).query(api.mentions.feedForCurrent, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].href).toBe("/dashboard/inbox");
  });

  it("falls back to /dashboard/inbox for a personal-scoped ('user') channel mention", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
      const channelId = await ctx.db.insert("channels", {
        scopeType: "user",
        scopeId: ME.subject,
        name: "general",
        createdByActorId: "agent_scout",
        createdAt: Date.now(),
      });
      const messageId = await ctx.db.insert("messages", {
        parentType: "channel",
        parentId: channelId,
        authorClerkId: "agent_scout",
        body: `status update for @[Me](${ME.subject})`,
        createdAt: Date.now(),
      });
      await ctx.db.insert("mentions", {
        messageId,
        mentionedClerkId: ME.subject,
        parentType: "channel",
        parentId: channelId,
        createdAt: Date.now(),
      });
    });

    const feed = await t.withIdentity(ME).query(api.mentions.feedForCurrent, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].href).toBe("/dashboard/inbox");
  });

  it("still deep-links workspace-scoped channel mentions to the workspace chat", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
      const wsId = await ctx.db.insert("workspaces", {
        name: "Acme",
        slug: "acme",
        ownerClerkId: ME.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: wsId,
        userClerkId: ME.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      const channelId = await ctx.db.insert("channels", {
        scopeType: "workspace",
        scopeId: wsId,
        name: "general",
        createdByActorId: "agent_scout",
        createdAt: Date.now(),
      });
      const messageId = await ctx.db.insert("messages", {
        parentType: "channel",
        parentId: channelId,
        authorClerkId: "agent_scout",
        body: `status update for @[Me](${ME.subject})`,
        createdAt: Date.now(),
      });
      await ctx.db.insert("mentions", {
        messageId,
        mentionedClerkId: ME.subject,
        parentType: "channel",
        parentId: channelId,
        createdAt: Date.now(),
      });
      return wsId;
    });

    const feed = await t.withIdentity(ME).query(api.mentions.feedForCurrent, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].href).toMatch(new RegExp(`^/dashboard/w/${workspaceId}\\?tab=chat&channel=`));
  });
});
