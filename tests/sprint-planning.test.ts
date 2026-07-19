import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Sprint planning: commit/uncommit is just a `tasks.sprintId` patch routed
// through updateTaskCore, setEstimate is the same for `estimatePoints`, and
// velocityPoints sums estimatePoints for tasks that were actually done
// when a sprint completed. These tests exercise convex/sprintPlanning.ts
// against convex-test's in-memory backend.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@team.com" };

async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(OWNER);

  const ids = await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
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
    const spaceId = await ctx.db.insert("spaces", {
      name: "Space",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Sprint work",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const openStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const doneStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, listId, openStatus, doneStatus };
  });

  return { t, owner, ...ids };
}

describe("commit / uncommit", () => {
  it("sets and clears tasks.sprintId through updateTaskCore", async () => {
    const { t, owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Ship the thing",
    });

    await owner.mutation(api.sprintPlanning.commit, { sprintId, taskId });
    let task = await owner.query(api.tasks.get, { taskId });
    expect(task?.sprintId).toBe(sprintId);

    await owner.mutation(api.sprintPlanning.uncommit, { taskId });
    task = await owner.query(api.tasks.get, { taskId });
    expect(task?.sprintId).toBeUndefined();
  });

  it("surfaces backlog vs. committed tasks with point totals via `planning`", async () => {
    const { owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86_400_000,
    });
    const committedTaskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Committed work",
      estimatePoints: 5,
    });
    const backlogTaskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Backlog work",
    });
    await owner.mutation(api.sprintPlanning.commit, {
      sprintId,
      taskId: committedTaskId,
    });

    const planning = await owner.query(api.sprintPlanning.planning, {
      sprintId,
    });
    expect(planning?.committed.map((r) => r.taskId)).toEqual([
      committedTaskId,
    ]);
    expect(planning?.backlog.map((r) => r.taskId)).toEqual([backlogTaskId]);
    expect(planning?.committedPoints).toBe(5);
    expect(planning?.committedUnestimated).toBe(0);
  });
});

describe("setEstimate", () => {
  it("stores and clears estimatePoints", async () => {
    const { owner, listId } = await setup();
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Estimate me",
    });

    await owner.mutation(api.sprintPlanning.setEstimate, {
      taskId,
      points: 8,
    });
    let task = await owner.query(api.tasks.get, { taskId });
    expect(task?.estimatePoints).toBe(8);

    await owner.mutation(api.sprintPlanning.setEstimate, {
      taskId,
      points: null,
    });
    task = await owner.query(api.tasks.get, { taskId });
    expect(task?.estimatePoints).toBeUndefined();
  });
});

describe("velocityPoints", () => {
  it("sums estimatePoints only for tasks done when the sprint completed", async () => {
    const { owner, workspaceId, listId, doneStatus } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const doneTaskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Finished",
      estimatePoints: 3,
    });
    const openTaskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Unfinished",
      estimatePoints: 5,
    });
    await owner.mutation(api.sprintPlanning.commit, {
      sprintId,
      taskId: doneTaskId,
    });
    await owner.mutation(api.sprintPlanning.commit, {
      sprintId,
      taskId: openTaskId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: doneTaskId,
      statusId: doneStatus,
    });
    await owner.mutation(api.sprints.update, {
      sprintId,
      status: "active",
    });
    await owner.mutation(api.sprints.update, {
      sprintId,
      status: "complete",
    });

    const velocity = await owner.query(api.sprintPlanning.velocityPoints, {
      workspaceId,
    });
    expect(velocity).toEqual([
      {
        sprintId,
        name: "Sprint 1",
        completedPoints: 3,
        completedCount: 1,
      },
    ]);
  });
});

describe("access control", () => {
  it("planning returns null for a non-member", async () => {
    const { t, owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86_400_000,
    });
    await owner.mutation(api.tasks.create, { listId, title: "Some work" });

    const outsider = t.withIdentity(OUTSIDER);
    expect(
      await outsider.query(api.sprintPlanning.planning, { sprintId }),
    ).toBeNull();
  });

  it("commit/uncommit/setEstimate refuse a non-member", async () => {
    const { t, owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Guarded",
    });

    const outsider = t.withIdentity(OUTSIDER);
    await expect(
      outsider.mutation(api.sprintPlanning.commit, { sprintId, taskId }),
    ).rejects.toThrow();
    await expect(
      outsider.mutation(api.sprintPlanning.setEstimate, {
        taskId,
        points: 2,
      }),
    ).rejects.toThrow();
  });
});
