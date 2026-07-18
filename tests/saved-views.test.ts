import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Saved views: named view+filter presets per list. Access is the list's
// access boundary (no separate ACL), names dedupe case-insensitively per
// list, and there's a hard cap per list.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
}

async function makePersonalList(t: ReturnType<typeof convexTest>) {
  const spaceId = await t.withIdentity(OWNER).mutation(api.spaces.create, {
    name: "Personal",
    parentType: "user",
    parentId: OWNER.subject,
  });
  return await t.withIdentity(OWNER).mutation(api.lists.create, {
    name: "My list",
    parentType: "space",
    parentId: spaceId,
  });
}

describe("saved views", () => {
  it("create requires list access; an outsider on a foreign personal list is rejected", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const listId = await makePersonalList(t);

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.savedViews.create, {
        listId,
        name: "Sneaky view",
        view: "board",
      }),
    ).rejects.toThrow(/forbidden/i);

    // The owner may.
    const id = await t.withIdentity(OWNER).mutation(api.savedViews.create, {
      listId,
      name: "My board",
      view: "board",
    });
    expect(id).toBeTruthy();
  });

  it("listForList returns [] for a list the caller can't access", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const listId = await makePersonalList(t);
    await t.withIdentity(OWNER).mutation(api.savedViews.create, {
      listId,
      name: "My board",
      view: "board",
    });

    const outsiderView = await t
      .withIdentity(OUTSIDER)
      .query(api.savedViews.listForList, { listId });
    expect(outsiderView).toEqual([]);

    const ownerView = await t
      .withIdentity(OWNER)
      .query(api.savedViews.listForList, { listId });
    expect(ownerView).toHaveLength(1);
  });

  it("dedupes view names case-insensitively per list", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const listId = await makePersonalList(t);
    await t.withIdentity(OWNER).mutation(api.savedViews.create, {
      listId,
      name: "Sprint board",
      view: "board",
    });
    await expect(
      t.withIdentity(OWNER).mutation(api.savedViews.create, {
        listId,
        name: "sprint BOARD",
        view: "list",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("caps a list at 20 saved views", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const listId = await makePersonalList(t);
    for (let i = 0; i < 20; i++) {
      await t.withIdentity(OWNER).mutation(api.savedViews.create, {
        listId,
        name: `View ${i}`,
        view: "list",
      });
    }
    await expect(
      t.withIdentity(OWNER).mutation(api.savedViews.create, {
        listId,
        name: "One too many",
        view: "list",
      }),
    ).rejects.toThrow(/maximum/i);
  });

  it("remove is access-checked", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const listId = await makePersonalList(t);
    const savedViewId = await t
      .withIdentity(OWNER)
      .mutation(api.savedViews.create, {
        listId,
        name: "My board",
        view: "board",
      });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.savedViews.remove, {
        savedViewId,
      }),
    ).rejects.toThrow(/forbidden/i);

    await t.withIdentity(OWNER).mutation(api.savedViews.remove, {
      savedViewId,
    });
    expect(
      await t
        .withIdentity(OWNER)
        .query(api.savedViews.listForList, { listId }),
    ).toEqual([]);
  });
});
