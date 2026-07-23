import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Regression coverage for the W2 fixes:
//   2. A completed sprint's committed work must be locked: commit/uncommit
//      (sprintPlanning.ts) and moveTask (scrumBoard.ts) must refuse once
//      the sprint's status is "complete".
//   6. sprints.update must treat capacityPoints: 0 as a real, storable
//      capacity — only null/negative should clear it.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };

async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(OWNER);
  const { workspaceId, listId } = await t.run(async (ctx) => {
    await ctx.db.insert("users", { clerkId: OWNER.subject, email: OWNER.email });
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
      name: "Work",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "In Progress",
      color: "#0af",
      category: "in_progress",
      position: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 2,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Closed",
      color: "#999",
      category: "closed",
      position: 3,
      createdAt: Date.now(),
    });
    return { workspaceId, listId };
  });
  return { t, owner, workspaceId, listId };
}

describe("completed sprints are locked", () => {
  it("commit refuses once the target sprint is complete", async () => {
    const { owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Late arrival",
    });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, { sprintId, status: "complete" });

    await expect(
      owner.mutation(api.sprintPlanning.commit, { sprintId, taskId }),
    ).rejects.toThrow(/complete/);
  });

  it("uncommit refuses once the task's current sprint is complete", async () => {
    const { owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Committed work",
    });
    await owner.mutation(api.sprintPlanning.commit, { sprintId, taskId });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, { sprintId, status: "complete" });

    await expect(
      owner.mutation(api.sprintPlanning.uncommit, { taskId }),
    ).rejects.toThrow(/complete/);
  });

  it("uncommit still works normally once the sprint is reopened", async () => {
    const { owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Committed work",
    });
    await owner.mutation(api.sprintPlanning.commit, { sprintId, taskId });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, { sprintId, status: "complete" });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });

    await owner.mutation(api.sprintPlanning.uncommit, { taskId });
    const task = await owner.query(api.tasks.get, { taskId });
    expect(task?.sprintId).toBeUndefined();
  });

  it("scrumBoard.moveTask refuses once the task's sprint is complete", async () => {
    const { owner, workspaceId, listId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Board card",
      sprintId,
    });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, { sprintId, status: "complete" });

    await expect(
      owner.mutation(api.scrumBoard.moveTask, {
        taskId,
        category: "in_progress",
      }),
    ).rejects.toThrow(/complete/);
  });
});

describe("sprints.update capacityPoints", () => {
  it("stores an explicit 0 as a real capacity rather than clearing it", async () => {
    const { owner, workspaceId } = await setup();
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86_400_000,
      capacityPoints: 20,
    });

    await owner.mutation(api.sprints.update, { sprintId, capacityPoints: 0 });
    const sprints = await owner.query(api.sprints.listForWorkspace, {
      workspaceId,
    });
    const sprint = sprints.find((s) => s._id === sprintId)!;
    expect(sprint.capacityPoints).toBe(0);

    // null still clears it.
    await owner.mutation(api.sprints.update, {
      sprintId,
      capacityPoints: null,
    });
    const sprintsAfter = await owner.query(api.sprints.listForWorkspace, {
      workspaceId,
    });
    expect(sprintsAfter.find((s) => s._id === sprintId)!.capacityPoints).toBe(
      undefined,
    );
  });
});
