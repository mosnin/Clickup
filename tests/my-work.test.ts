import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// "My Work": every open (not complete/closed) task assigned to the caller,
// across both their personal space and every workspace they belong to,
// sorted soonest-due first with undated tasks last.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_me", email: "me@acme.com" };
const OTHER = { subject: "user_other", email: "other@acme.com" };

const DAY = 24 * 60 * 60 * 1000;

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [ME, OTHER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ME.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ME.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    return workspaceId;
  });
}

describe("my work", () => {
  it("returns only my open tasks, spanning personal + workspace lists, soonest-due first with undated last", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);

    // Personal space list.
    const personalSpaceId = await t
      .withIdentity(ME)
      .mutation(api.spaces.create, {
        name: "Personal",
        parentType: "user",
        parentId: ME.subject,
      });
    const personalListId = await t
      .withIdentity(ME)
      .mutation(api.lists.create, {
        name: "Personal list",
        parentType: "space",
        parentId: personalSpaceId,
      });
    const personalStatuses = await t
      .withIdentity(ME)
      .query(api.listStatuses.listForList, { listId: personalListId });
    const completeStatusId = personalStatuses.find(
      (s: { name: string }) => s.name === "Complete",
    )!._id;

    // Workspace list.
    const wsSpaceId = await t.withIdentity(ME).mutation(api.spaces.create, {
      name: "Team space",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const wsListId = await t.withIdentity(ME).mutation(api.lists.create, {
      name: "Team list",
      parentType: "space",
      parentId: wsSpaceId,
    });

    const now = Date.now();

    // T1: personal, assigned to me, due in 5 days.
    await t.withIdentity(ME).mutation(api.tasks.create, {
      listId: personalListId,
      title: "Later task",
      assigneeClerkIds: [ME.subject],
      dueDate: now + 5 * DAY,
    });

    // T2: personal, assigned to me, but already complete -> excluded.
    await t.withIdentity(ME).mutation(api.tasks.create, {
      listId: personalListId,
      title: "Done task",
      assigneeClerkIds: [ME.subject],
      statusId: completeStatusId,
    });

    // T3: personal, not assigned to me -> excluded.
    await t.withIdentity(ME).mutation(api.tasks.create, {
      listId: personalListId,
      title: "Someone else's task",
      assigneeClerkIds: [OTHER.subject],
    });

    // T4: workspace, assigned to me, due tomorrow (soonest).
    await t.withIdentity(ME).mutation(api.tasks.create, {
      listId: wsListId,
      title: "Urgent task",
      assigneeClerkIds: [ME.subject],
      dueDate: now + 1 * DAY,
    });

    // T5: personal, assigned to me, no due date -> sorts last.
    await t.withIdentity(ME).mutation(api.tasks.create, {
      listId: personalListId,
      title: "Someday task",
      assigneeClerkIds: [ME.subject],
    });

    const myWork = await t
      .withIdentity(ME)
      .query(api.myWork.listForCurrent, {});
    expect(myWork).not.toBeNull();
    expect(myWork!.map((t: { title: string }) => t.title)).toEqual([
      "Urgent task",
      "Later task",
      "Someday task",
    ]);
    // Spans both the personal and the workspace list.
    const listIds = new Set(myWork!.map((t: { listId: string }) => t.listId));
    expect(listIds.has(personalListId)).toBe(true);
    expect(listIds.has(wsListId)).toBe(true);
  });

  it("returns an empty array (not null) for a signed-in user with no assigned work", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const myWork = await t
      .withIdentity(OTHER)
      .query(api.myWork.listForCurrent, {});
    expect(myWork).toEqual([]);
  });
});
