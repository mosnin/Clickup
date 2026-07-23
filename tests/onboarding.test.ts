import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// onboarding.completeSetup must be safe to call twice for the same user —
// a reload or back-button navigation re-fires the client effect that calls
// it. The second call should short-circuit to the existing workspace
// rather than inserting a duplicate workspace/space/list/agent.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_me", email: "me@acme.com" };

describe("onboarding.completeSetup idempotency", () => {
  it("returns the same ids on a second call instead of creating duplicates", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
    });

    const first = await t.withIdentity(ME).mutation(api.onboarding.completeSetup, {
      workspaceName: "Acme",
      agentName: "Scout",
    });
    const second = await t
      .withIdentity(ME)
      .mutation(api.onboarding.completeSetup, {
        workspaceName: "Acme",
        agentName: "Scout",
      });

    expect(second).toEqual(first);

    const workspaces = await t.run(async (ctx) =>
      ctx.db
        .query("workspaces")
        .withIndex("by_owner", (q) => q.eq("ownerClerkId", ME.subject))
        .collect(),
    );
    expect(workspaces).toHaveLength(1);

    const agents = await t.run(async (ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", first.workspaceId),
        )
        .collect(),
    );
    expect(agents).toHaveLength(1);

    const lists = await t.run(async (ctx) =>
      ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", first.spaceId),
        )
        .collect(),
    );
    expect(lists).toHaveLength(1);
  });
});
