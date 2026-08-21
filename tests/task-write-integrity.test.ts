import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  completionStatePatch,
  isDoneCategory,
} from "../convex/_taskCompletion";

// Task/list write integrity: `completedAt` must stay in lockstep with a
// status category (routing, reports, ops overview and sprint burndown
// treat that stamp as "is this open?"), subtasks must stay on the same
// list as their parent (delete-parent cascades), and completing a
// recurring task must not strip the next instance's checklist / fields.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
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
    name: "Ops",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await owner.mutation(api.lists.create, {
    name: "Pipeline",
    parentType: "space",
    parentId: spaceId,
  });
  const otherListId = await owner.mutation(api.lists.create, {
    name: "Elsewhere",
    parentType: "space",
    parentId: spaceId,
  });
  const statuses = await owner.query(api.listStatuses.listForList, { listId });
  const byCategory = (category: string) =>
    statuses.find((s: { category: string }) => s.category === category)!;
  return {
    t,
    owner,
    spaceId,
    listId,
    otherListId,
    todo: byCategory("open")._id as Id<"listStatuses">,
    inProgress: byCategory("in_progress")._id as Id<"listStatuses">,
    complete: byCategory("complete")._id as Id<"listStatuses">,
    closed: byCategory("closed")._id as Id<"listStatuses">,
  };
}

describe("completionStatePatch", () => {
  it("keeps an existing stamp when staying in the done bucket", () => {
    expect(isDoneCategory("complete")).toBe(true);
    expect(isDoneCategory("closed")).toBe(true);
    expect(isDoneCategory("open")).toBe(false);
    const stamp = 1_700_000_000_000;
    expect(
      completionStatePatch({ completedAt: stamp }, true).completedAt,
    ).toBe(stamp);
  });

  it("clears the stamp and revokes approval when leaving the done bucket", () => {
    const patch = completionStatePatch(
      { completedAt: 1, requiresApproval: true },
      false,
    );
    expect(patch.completedAt).toBeUndefined();
    expect(patch.approvedAt).toBeUndefined();
    expect(patch.approvedByClerkId).toBeUndefined();
  });
});

describe("completedAt stays aligned with status category", () => {
  it("Complete → Closed keeps the original completedAt (does not stamp now)", async () => {
    const { t, owner, listId, complete, closed } = await seed();
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Done last week",
      statusId: complete,
    });
    const original = await t.run(async (ctx) => {
      const task = (await ctx.db.get(taskId))!;
      expect(task.completedAt).toBeDefined();
      // Pretend the completion landed two days ago — the bug stomped this
      // to Date.now() on any done→done status change.
      const completedAt = Date.now() - 2 * 86_400_000;
      await ctx.db.patch(taskId, { completedAt });
      return completedAt;
    });

    await owner.mutation(api.tasks.update, { taskId, statusId: closed });

    const after = await t.run(async (ctx) => (await ctx.db.get(taskId))!);
    expect(after.statusId).toBe(closed);
    expect(after.completedAt).toBe(original);
  });

  it("recategorizing a column to complete stamps completedAt on every task in it", async () => {
    const { t, owner, listId, todo, inProgress } = await seed();
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Still open",
      statusId: inProgress,
    });
    expect(
      (await t.run(async (ctx) => (await ctx.db.get(taskId))!.completedAt)) ??
        undefined,
    ).toBeUndefined();

    await owner.mutation(api.listStatuses.update, {
      statusId: inProgress,
      category: "complete",
    });

    const after = await t.run(async (ctx) => (await ctx.db.get(taskId))!);
    expect(after.statusId).toBe(inProgress);
    expect(after.completedAt).toBeDefined();
    // Sibling columns are untouched.
    const other = await owner.mutation(api.tasks.create, {
      listId,
      title: "Still to do",
      statusId: todo,
    });
    expect(
      (await t.run(async (ctx) => (await ctx.db.get(other))!.completedAt)) ??
        undefined,
    ).toBeUndefined();
  });

  it("recategorizing a column to open clears completedAt (no duplicate recurrence later)", async () => {
    const { t, owner, listId, complete } = await seed();
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Weekly report",
      statusId: complete,
      recurrence: "weekly",
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(taskId))!.completedAt),
    ).toBeDefined();

    await owner.mutation(api.listStatuses.update, {
      statusId: complete,
      category: "open",
    });

    const reopened = await t.run(async (ctx) => (await ctx.db.get(taskId))!);
    expect(reopened.completedAt).toBeUndefined();
  });

  it("deleting a status and reassigning across the done boundary syncs completedAt", async () => {
    const { t, owner, listId, todo, complete } = await seed();
    const openId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Open, about to be completed by a column delete",
      statusId: todo,
    });
    const doneId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Done, about to be reopened by a column delete",
      statusId: complete,
    });
    const originalDoneAt = await t.run(
      async (ctx) => (await ctx.db.get(doneId))!.completedAt,
    );
    expect(originalDoneAt).toBeDefined();

    await owner.mutation(api.listStatuses.remove, {
      statusId: todo,
      replaceWithId: complete,
    });
    const nowDone = await t.run(async (ctx) => (await ctx.db.get(openId))!);
    expect(nowDone.statusId).toBe(complete);
    expect(nowDone.completedAt).toBeDefined();

    await owner.mutation(api.listStatuses.remove, {
      statusId: complete,
      replaceWithId: (await owner.query(api.listStatuses.listForList, { listId }))
        .find((s: { category: string }) => s.category === "in_progress")!._id,
    });
    const nowOpen = await t.run(async (ctx) => (await ctx.db.get(doneId))!);
    expect(nowOpen.completedAt).toBeUndefined();
  });
});

describe("parentTaskId is a same-list pointer", () => {
  it("refuses a parent on a different list", async () => {
    const { owner, listId, otherListId } = await seed();
    const parentId = await owner.mutation(api.tasks.create, {
      listId: otherListId,
      title: "Parent elsewhere",
    });
    await expect(
      owner.mutation(api.tasks.create, {
        listId,
        title: "Illegal child",
        parentTaskId: parentId,
      }),
    ).rejects.toThrow(/same list as its parent/i);
  });

  it("refuses a parent that does not exist", async () => {
    const { t, owner, listId } = await seed();
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("tasks", {
        listId,
        title: "Ghost",
        statusId: (
          await ctx.db
            .query("listStatuses")
            .withIndex("by_list", (q) => q.eq("listId", listId))
            .first()
        )!._id,
        assigneeClerkIds: [],
        createdByClerkId: OWNER.subject,
        position: 0,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      owner.mutation(api.tasks.create, {
        listId,
        title: "Orphan child",
        parentTaskId: ghost,
      }),
    ).rejects.toThrow(/parent task not found/i);
  });

  it("accepts a parent on the same list", async () => {
    const { owner, listId } = await seed();
    const parentId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Parent",
    });
    const childId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Child",
      parentTaskId: parentId,
    });
    const child = await owner.query(api.tasks.get, { taskId: childId });
    expect(child?.parentTaskId).toBe(parentId);
  });
});

describe("recurrence keeps the next instance's shape", () => {
  it("copies checklist (ticks reset), estimate, approval and custom fields", async () => {
    const { t, owner, listId, complete } = await seed();
    const fieldId = await owner.mutation(api.customFields.create, {
      listId,
      name: "Week",
      type: "number",
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Weekly report",
      recurrence: "weekly",
      dueDate: Date.now(),
      estimatePoints: 5,
      requiresApproval: true,
    });
    await owner.mutation(api.tasks.update, {
      taskId,
      checklist: [
        { id: "a", text: "Pull numbers", done: true },
        { id: "b", text: "Send the note", done: false },
      ],
    });
    await owner.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId,
      numberValue: 12,
    });

    await owner.mutation(api.tasks.update, { taskId, statusId: complete });

    const spawned = await t.run(async (ctx) => {
      const all = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect();
      const next = all.find((row) => row._id !== taskId);
      expect(next).toBeDefined();
      const values = await ctx.db
        .query("taskFieldValues")
        .withIndex("by_task", (q) => q.eq("taskId", next!._id))
        .collect();
      return { next: next!, values };
    });

    expect(spawned.next.title).toBe("Weekly report");
    expect(spawned.next.recurrence).toBe("weekly");
    expect(spawned.next.estimatePoints).toBe(5);
    expect(spawned.next.requiresApproval).toBe(true);
    expect(spawned.next.completedAt ?? undefined).toBeUndefined();
    expect(spawned.next.checklist).toEqual([
      { id: "a", text: "Pull numbers", done: false },
      { id: "b", text: "Send the note", done: false },
    ]);
    expect(spawned.values).toHaveLength(1);
    expect(spawned.values[0].numberValue).toBe(12);
  });
});
