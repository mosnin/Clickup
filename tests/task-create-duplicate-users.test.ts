import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Login race: Clerk webhook and users.ensureCurrent can both insert a
// users row for the same clerkId. Convex indexes are not unique
// constraints, so users.by_clerk_id can return two rows.
//
// tasks.create always calls events.userActor before createTaskCore.
// userActor used .unique() on that index, so the mutation threw and the
// insert never committed — the list stayed empty after "Add".
//
// Home/workspace .unique() leftovers are PR #52. This file is only the
// write half of login → workspace → create a task.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };

async function seedWorkspaceList() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      name: "Ada",
    });
    // Second row: the webhook / ensureCurrent race.
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      name: "Ada",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    return workspaceId;
  });
  const owner = t.withIdentity(OWNER);
  const spaceId = await owner.mutation(api.spaces.create, {
    name: "Engineering",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await owner.mutation(api.lists.create, {
    name: "Backend",
    parentType: "space",
    parentId: spaceId,
  });
  return { t, owner, listId };
}

describe("task create after the first-login users-row race", () => {
  it("persists the task and the list query can read it back", async () => {
    const { owner, listId } = await seedWorkspaceList();

    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Ship the deck",
    });

    const listed = await owner.query(api.tasks.listForList, { listId });
    expect(listed.map((row) => row._id)).toContain(taskId);
    expect(listed.find((row) => row._id === taskId)?.title).toBe(
      "Ship the deck",
    );

    const fetched = await owner.query(api.tasks.get, { taskId });
    expect(fetched?.title).toBe("Ship the deck");
    expect(fetched?.listId).toBe(listId);
  });
});
