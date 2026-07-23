import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Favorites (pinning) + the all-projects directory: the scale-navigation
// surfaces for accounts with many projects. Both must resolve every read
// through the same access boundary as everything else — a favorite never
// grants access, and the directory never leaks a project from a space the
// viewer can't open.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const CREATOR = { subject: "user_creator", email: "creator@team.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@team.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: u.subject,
        role: u === OWNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    // CREATOR's personal space, so favorites/toggle round-trip tests don't
    // need a whole workspace to exercise a plain accessible list.
    const personalSpaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: CREATOR.subject,
      position: 0,
      createdAt: Date.now(),
    });
    return { workspaceId, personalSpaceId };
  });
}

describe("favorites", () => {
  it("toggles a favorite on and off for a list the user can access", async () => {
    const t = convexTest(schema, modules);
    const { personalSpaceId } = await seed(t);
    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Inbox zero",
      parentType: "space",
      parentId: personalSpaceId,
    });

    expect(
      await t.withIdentity(CREATOR).query(api.favorites.isFavorite, {
        entityType: "list",
        entityId: listId,
      }),
    ).toBe(false);

    const on = await t.withIdentity(CREATOR).mutation(api.favorites.toggle, {
      entityType: "list",
      entityId: listId,
    });
    expect(on).toEqual({ favorited: true });
    expect(
      await t.withIdentity(CREATOR).query(api.favorites.isFavorite, {
        entityType: "list",
        entityId: listId,
      }),
    ).toBe(true);

    const listed = await t
      .withIdentity(CREATOR)
      .query(api.favorites.listForCurrentUser, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      entityType: "list",
      entityId: listId,
      name: "Inbox zero",
      href: `/dashboard/l/${listId}`,
    });

    const off = await t.withIdentity(CREATOR).mutation(api.favorites.toggle, {
      entityType: "list",
      entityId: listId,
    });
    expect(off).toEqual({ favorited: false });
    expect(
      await t.withIdentity(CREATOR).query(api.favorites.isFavorite, {
        entityType: "list",
        entityId: listId,
      }),
    ).toBe(false);
  });

  it("refuses to favorite a list in a private space the caller can't access", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await seed(t);
    const spaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
    });
    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Hidden work",
      parentType: "space",
      parentId: spaceId,
    });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.favorites.toggle, {
        entityType: "list",
        entityId: listId,
      }),
    ).rejects.toThrow();

    // Never actually pinned for the outsider.
    expect(
      await t.withIdentity(OUTSIDER).query(api.favorites.isFavorite, {
        entityType: "list",
        entityId: listId,
      }),
    ).toBe(false);
    expect(
      await t.withIdentity(OUTSIDER).query(api.favorites.listForCurrentUser, {}),
    ).toEqual([]);

    // The creator (who has access) can still favorite it.
    const on = await t.withIdentity(CREATOR).mutation(api.favorites.toggle, {
      entityType: "list",
      entityId: listId,
    });
    expect(on).toEqual({ favorited: true });
  });

  it("listForCurrentUser silently skips a favorite whose entity is gone", async () => {
    const t = convexTest(schema, modules);
    const { personalSpaceId } = await seed(t);
    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Temporary",
      parentType: "space",
      parentId: personalSpaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.favorites.toggle, {
      entityType: "list",
      entityId: listId,
    });

    // Delete the list directly (bypassing lists.remove) to simulate the
    // entity having disappeared out from under a stale favorites row.
    await t.run(async (ctx) => {
      await ctx.db.delete(listId as Id<"lists">);
    });

    const listed = await t
      .withIdentity(CREATOR)
      .query(api.favorites.listForCurrentUser, {});
    expect(listed).toEqual([]);
  });
});

describe("projectsDirectory", () => {
  it("excludes a private space's list from a non-member's directory", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await seed(t);

    const openSpaceId = await t
      .withIdentity(CREATOR)
      .mutation(api.spaces.create, {
        name: "Open",
        parentType: "workspace",
        parentId: workspaceId,
      });
    const openListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Public roadmap",
      parentType: "space",
      parentId: openSpaceId,
    });

    const secretSpaceId = await t
      .withIdentity(CREATOR)
      .mutation(api.spaces.create, {
        name: "Secret",
        parentType: "workspace",
        parentId: workspaceId,
      });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: secretSpaceId,
      private: true,
    });
    const secretListId = await t
      .withIdentity(CREATOR)
      .mutation(api.lists.create, {
        name: "Secret launch plan",
        parentType: "space",
        parentId: secretSpaceId,
      });

    const outsiderDirectory = await t
      .withIdentity(OUTSIDER)
      .query(api.projectsDirectory.list, {});
    const outsiderIds = outsiderDirectory.rows.map((r) => r.listId);
    expect(outsiderIds).toContain(openListId);
    expect(outsiderIds).not.toContain(secretListId);

    const creatorDirectory = await t
      .withIdentity(CREATOR)
      .query(api.projectsDirectory.list, {});
    const creatorIds = creatorDirectory.rows.map((r) => r.listId);
    expect(creatorIds).toContain(openListId);
    expect(creatorIds).toContain(secretListId);
  });

  it("filters by search text and project status", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await seed(t);
    const spaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Growth",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const listId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Q3 launch",
      parentType: "space",
      parentId: spaceId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(listId as Id<"lists">, { projectStatus: "at_risk" });
    });

    const bySearch = await t.withIdentity(CREATOR).query(api.projectsDirectory.list, {
      search: "q3",
    });
    expect(bySearch.rows.map((r) => r.listId)).toContain(listId);

    const byStatus = await t.withIdentity(CREATOR).query(api.projectsDirectory.list, {
      status: "at_risk",
    });
    expect(byStatus.rows.map((r) => r.listId)).toContain(listId);

    const wrongStatus = await t
      .withIdentity(CREATOR)
      .query(api.projectsDirectory.list, { status: "paused" });
    expect(wrongStatus.rows.map((r) => r.listId)).not.toContain(listId);
  });
});
