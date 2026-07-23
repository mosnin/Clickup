import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// ClickUp-style Spaces: privacy is a real access boundary (not a UI
// filter), archives hide from the tree, and space-level default statuses
// are inherited by new lists.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const CREATOR = { subject: "user_creator", email: "creator@team.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@team.com" };
const INVITED = { subject: "user_invited", email: "invited@team.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, CREATOR, OUTSIDER, INVITED]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, CREATOR, OUTSIDER, INVITED]) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: u.subject,
        role: u === OWNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    return workspaceId;
  });
}

describe("spaces privacy", () => {
  it("private spaces lock out non-members but keep creator, invitees, and the workspace owner", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);

    const spaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
      memberClerkIds: [INVITED.subject],
    });

    // Outsider (ordinary workspace member): no space, no overview, and a
    // list inside is invisible by ID.
    expect(
      await t.withIdentity(OUTSIDER).query(api.spaces.get, { spaceId }),
    ).toBeNull();
    expect(
      await t.withIdentity(OUTSIDER).query(api.spaces.overview, { spaceId }),
    ).toBeNull();

    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Hidden work",
      parentType: "space",
      parentId: spaceId,
    });
    expect(
      await t.withIdentity(OUTSIDER).query(api.lists.get, { listId }),
    ).toBeNull();

    // Creator, invited member, and workspace owner all still see it.
    for (const u of [CREATOR, INVITED, OWNER]) {
      const space = await t.withIdentity(u).query(api.spaces.get, { spaceId });
      expect(space?._id).toBe(spaceId);
    }
  });

  it("only the creator or workspace owner can change privacy", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const spaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Team space",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.spaces.updateMeta, {
        spaceId,
        private: true,
      }),
    ).rejects.toThrow(/creator or workspace owner/i);
    // Owner may.
    await t.withIdentity(OWNER).mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
    });
    // The enabling actor is always kept inside.
    const space = await t.withIdentity(OWNER).query(api.spaces.get, { spaceId });
    expect(space?.memberClerkIds).toContain(OWNER.subject);
  });

  it("archived spaces leave the sidebar tree; private ones filter per viewer", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const visibleId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Open",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const secretId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: secretId,
      private: true,
    });
    const archivedId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Old",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: archivedId,
      archived: true,
    });

    const treeFor = async (u: { subject: string }) => {
      const tree = await t.withIdentity(u).query(api.sidebar.tree, {});
      return tree!.workspaces[0].spaces.map((s: { _id: Id<"spaces"> }) => s._id);
    };
    const outsiderTree = await treeFor(OUTSIDER);
    expect(outsiderTree).toContain(visibleId);
    expect(outsiderTree).not.toContain(secretId);
    expect(outsiderTree).not.toContain(archivedId);

    const creatorTree = await treeFor(CREATOR);
    expect(creatorTree).toContain(secretId);
    expect(creatorTree).not.toContain(archivedId);
  });

  it("new lists inherit the space's default statuses", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const spaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Pipeline",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId,
      defaultStatuses: [
        { name: "Backlog", color: "#c9ccd4", category: "open" },
        { name: "Doing", color: "#a9c6f2", category: "in_progress" },
        { name: "Shipped", color: "#c9e8b8", category: "complete" },
      ],
    });
    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Q3",
      parentType: "space",
      parentId: spaceId,
    });
    const statuses = await t
      .withIdentity(CREATOR)
      .query(api.listStatuses.listForList, { listId });
    expect(statuses.map((s: { name: string }) => s.name)).toEqual([
      "Backlog",
      "Doing",
      "Shipped",
    ]);
  });
});
