import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "spaces_owner" };
const MEMBER = { subject: "spaces_member" };

describe("spaces directory", () => {
  it("returns accessible spaces as containers with their contents summarized", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        name: "Acme",
        slug: "acme-spaces",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: MEMBER.subject,
        role: "member",
        joinedAt: Date.now(),
      });
      const visibleSpaceId = await ctx.db.insert("spaces", {
        name: "Launch",
        description: "The launch operating space",
        parentType: "workspace",
        parentId: workspaceId,
        position: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("spaces", {
        name: "Private finance",
        parentType: "workspace",
        parentId: workspaceId,
        position: 1,
        private: true,
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      const listId = await ctx.db.insert("lists", {
        name: "Release work",
        parentType: "space",
        parentId: visibleSpaceId,
        position: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("listRollups", {
        listId,
        total: 4,
        done: 3,
        inProgress: 1,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("docs", {
        parentType: "space",
        parentId: visibleSpaceId,
        title: "Brief",
        content: "",
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { visibleSpaceId };
    });

    const result = await t
      .withIdentity(MEMBER)
      .query(api.spacesDirectory.list, {});
    expect(result.totalCount).toBe(1);
    expect(result.rows).toEqual([
      expect.objectContaining({
        spaceId: ids.visibleSpaceId,
        name: "Launch",
        workspaceName: "Acme",
        listCount: 1,
        docCount: 1,
        totalTasks: 4,
        completedTasks: 3,
      }),
    ]);
  });
});
