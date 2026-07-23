import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Regression coverage for the W2 fix (finding 1): sprints.burndown,
// sprints.velocity, and sprintPlanning.velocityPoints must apply the same
// per-viewer private-space gate that sprintSummaryCore / planning /
// scrumBoard.board already use — a plain workspace member must not have a
// private space's task counts (total/done/points) folded into these
// analytics, even though they can see the sprint itself.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const MEMBER = { subject: "user_member", email: "member@team.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, MEMBER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, MEMBER]) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: u.subject,
        role: u === OWNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    // Private space created by a third party — OWNER sees it via the
    // workspace-owner bypass, plain MEMBER must not.
    const privateSpaceId = await ctx.db.insert("spaces", {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
      private: true,
      createdByClerkId: "user_third",
      memberClerkIds: ["user_third"],
    });
    const publicSpaceId = await ctx.db.insert("spaces", {
      name: "Open",
      parentType: "workspace",
      parentId: workspaceId,
      position: 1,
      createdAt: Date.now(),
    });
    const mkList = async (spaceId: Id<"spaces">, name: string) => {
      const listId = await ctx.db.insert("lists", {
        name,
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
      return { listId, openStatus, doneStatus };
    };
    const privateList = await mkList(privateSpaceId, "Secret list");
    const publicList = await mkList(publicSpaceId, "Open list");
    return { workspaceId, privateList, publicList };
  });
}

describe("sprint analytics private-space privacy", () => {
  it("burndown excludes a private-space task's totals for a plain member", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, privateList, publicList } = await seed(t);
    const owner = t.withIdentity(OWNER);

    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 86_400_000,
      endDate: Date.now() + 6 * 86_400_000,
    });

    // One done + one open task in the private space, one open task in the
    // public space — all committed to the same sprint.
    const secretDone = await owner.mutation(api.tasks.create, {
      listId: privateList.listId,
      title: "Secret done",
      sprintId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: secretDone,
      statusId: privateList.doneStatus,
    });
    await owner.mutation(api.tasks.create, {
      listId: privateList.listId,
      title: "Secret open",
      sprintId,
    });
    await owner.mutation(api.tasks.create, {
      listId: publicList.listId,
      title: "Public open",
      sprintId,
    });

    // Owner sees all 3 tasks, 1 done.
    const ownerView = await owner.query(api.sprints.burndown, { sprintId });
    expect(ownerView?.totalTasks).toBe(3);
    expect(ownerView?.doneTasks).toBe(1);

    // Plain member must see only the public task — no trace of the
    // private space's counts.
    const member = t.withIdentity(MEMBER);
    const memberView = await member.query(api.sprints.burndown, { sprintId });
    expect(memberView?.totalTasks).toBe(1);
    expect(memberView?.doneTasks).toBe(0);
  });

  it("velocity excludes private-space completions for a plain member", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, privateList, publicList } = await seed(t);
    const owner = t.withIdentity(OWNER);

    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const secretDone = await owner.mutation(api.tasks.create, {
      listId: privateList.listId,
      title: "Secret done",
      sprintId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: secretDone,
      statusId: privateList.doneStatus,
    });
    const publicDone = await owner.mutation(api.tasks.create, {
      listId: publicList.listId,
      title: "Public done",
      sprintId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: publicDone,
      statusId: publicList.doneStatus,
    });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, {
      sprintId,
      status: "complete",
    });

    const ownerVelocity = await owner.query(api.sprints.velocity, {
      workspaceId,
    });
    expect(ownerVelocity).toEqual([
      { sprintId, name: "Sprint 1", completed: 2 },
    ]);

    const member = t.withIdentity(MEMBER);
    const memberVelocity = await member.query(api.sprints.velocity, {
      workspaceId,
    });
    expect(memberVelocity).toEqual([
      { sprintId, name: "Sprint 1", completed: 1 },
    ]);
  });

  it("velocityPoints excludes private-space points/count for a plain member", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, privateList, publicList } = await seed(t);
    const owner = t.withIdentity(OWNER);

    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now() - 14 * 86_400_000,
      endDate: Date.now() - 7 * 86_400_000,
    });
    const secretDone = await owner.mutation(api.tasks.create, {
      listId: privateList.listId,
      title: "Secret done",
      estimatePoints: 8,
      sprintId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: secretDone,
      statusId: privateList.doneStatus,
    });
    const publicDone = await owner.mutation(api.tasks.create, {
      listId: publicList.listId,
      title: "Public done",
      estimatePoints: 3,
      sprintId,
    });
    await owner.mutation(api.tasks.update, {
      taskId: publicDone,
      statusId: publicList.doneStatus,
    });
    await owner.mutation(api.sprints.update, { sprintId, status: "active" });
    await owner.mutation(api.sprints.update, {
      sprintId,
      status: "complete",
    });

    const ownerVelocity = await owner.query(api.sprintPlanning.velocityPoints, {
      workspaceId,
    });
    expect(ownerVelocity).toEqual([
      {
        sprintId,
        name: "Sprint 1",
        completedPoints: 11,
        completedCount: 2,
      },
    ]);

    const member = t.withIdentity(MEMBER);
    const memberVelocity = await member.query(
      api.sprintPlanning.velocityPoints,
      { workspaceId },
    );
    expect(memberVelocity).toEqual([
      {
        sprintId,
        name: "Sprint 1",
        completedPoints: 3,
        completedCount: 1,
      },
    ]);
  });
});
