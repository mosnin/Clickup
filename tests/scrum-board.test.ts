import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Sprint scrum board: tasks committed to a sprint can come from any list in
// the sprint's workspace, and different lists can name their workflow
// stages differently. moveTask must resolve the requested category
// ("in_progress", etc.) onto the CARD'S OWN LIST's matching status, not
// some other list's statusId — otherwise a cross-list drag would either
// crash or silently move the task onto a status it doesn't own.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const MEMBER = { subject: "user_member", email: "member@team.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@team.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, MEMBER, OUTSIDER]) {
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
    return workspaceId;
  });
}

describe("scrum board", () => {
  it("moveTask maps a category onto the task's own list status, not another list's", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const owner = t.withIdentity(OWNER);

    const spaceId = await owner.mutation(api.spaces.create, {
      name: "Engineering",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const listA = await owner.mutation(api.lists.create, {
      name: "Backend",
      parentType: "space",
      parentId: spaceId,
    });
    const listB = await owner.mutation(api.lists.create, {
      name: "Frontend",
      parentType: "space",
      parentId: spaceId,
    });

    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 14 * 86_400_000,
    });

    const taskA = await owner.mutation(api.tasks.create, {
      listId: listA,
      title: "Backend task",
      sprintId,
    });
    const taskB = await owner.mutation(api.tasks.create, {
      listId: listB,
      title: "Frontend task",
      sprintId,
    });

    await owner.mutation(api.scrumBoard.moveTask, {
      taskId: taskA,
      category: "in_progress",
    });
    await owner.mutation(api.scrumBoard.moveTask, {
      taskId: taskB,
      category: "in_progress",
    });

    const [statusesA, statusesB] = await Promise.all([
      owner.query(api.listStatuses.listForList, { listId: listA }),
      owner.query(api.listStatuses.listForList, { listId: listB }),
    ]);
    const inProgressA = statusesA.find(
      (s: { category: string }) => s.category === "in_progress",
    )!;
    const inProgressB = statusesB.find(
      (s: { category: string }) => s.category === "in_progress",
    )!;
    // The two lists seeded independent status rows for "In Progress" —
    // confirm they really are different documents, otherwise this test
    // wouldn't be able to distinguish a correct per-list resolution from
    // an accidental shared-status bug.
    expect(inProgressA._id).not.toBe(inProgressB._id);

    const finalA = await owner.query(api.tasks.get, { taskId: taskA });
    const finalB = await owner.query(api.tasks.get, { taskId: taskB });
    expect(finalA?.statusId).toBe(inProgressA._id);
    expect(finalB?.statusId).toBe(inProgressB._id);

    const board = await owner.query(api.scrumBoard.board, { sprintId });
    const boardTaskA = board?.tasks.find(
      (bt: { _id: Id<"tasks"> }) => bt._id === taskA,
    );
    const boardTaskB = board?.tasks.find(
      (bt: { _id: Id<"tasks"> }) => bt._id === taskB,
    );
    expect(boardTaskA?.statusCategory).toBe("in_progress");
    expect(boardTaskA?.listName).toBe("Backend");
    expect(boardTaskB?.statusCategory).toBe("in_progress");
    expect(boardTaskB?.listName).toBe("Frontend");
  });

  it("moveTask refuses a category the task's list has no status for", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
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
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 14 * 86_400_000,
    });
    const taskId = await owner.mutation(api.tasks.create, {
      listId,
      title: "Task",
      sprintId,
    });

    const statuses = await owner.query(api.listStatuses.listForList, {
      listId,
    });
    const closed = statuses.find(
      (s: { category: string }) => s.category === "closed",
    )!;
    await owner.mutation(api.listStatuses.remove, {
      statusId: closed._id,
      replaceWithId: statuses.find(
        (s: { category: string }) => s.category === "complete",
      )!._id,
    });

    await expect(
      owner.mutation(api.scrumBoard.moveTask, {
        taskId,
        category: "closed",
      }),
    ).rejects.toThrow(/no "closed" status configured/);
  });

  it("returns null for a non-member and a real board for a member", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
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
    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 14 * 86_400_000,
    });
    await owner.mutation(api.tasks.create, {
      listId,
      title: "Task",
      sprintId,
      estimatePoints: 3,
    });

    expect(
      await t.withIdentity(OUTSIDER).query(api.scrumBoard.board, { sprintId }),
    ).toBeNull();

    const board = await t
      .withIdentity(MEMBER)
      .query(api.scrumBoard.board, { sprintId });
    expect(board?.sprint._id).toBe(sprintId);
    expect(board?.tasks).toHaveLength(1);
    expect(board?.tasks[0].estimatePoints).toBe(3);
    expect(board?.tasks[0].statusCategory).toBe("open");
    expect(
      board?.members.some((m: { id: string }) => m.id === OWNER.subject),
    ).toBe(true);
  });
});

describe("private-space privacy", () => {
  it("board hides tasks from a private space the viewer can't access", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const owner = t.withIdentity(OWNER);

    // Private space created by a third party; OWNER still sees it via the
    // workspace-owner bypass, plain MEMBER must not.
    const { privateListId, publicListId } = await t.run(async (ctx) => {
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
        await ctx.db.insert("listStatuses", {
          listId,
          name: "To Do",
          color: "#aaa",
          category: "open",
          position: 0,
          createdAt: Date.now(),
        });
        return listId;
      };
      return {
        privateListId: await mkList(privateSpaceId, "Secret list"),
        publicListId: await mkList(publicSpaceId, "Open list"),
      };
    });

    const sprintId = await owner.mutation(api.sprints.create, {
      workspaceId,
      name: "Sprint 1",
      startDate: Date.now(),
      endDate: Date.now() + 14 * 86_400_000,
    });
    await owner.mutation(api.tasks.create, {
      listId: privateListId,
      title: "Secret work",
      sprintId,
    });
    await owner.mutation(api.tasks.create, {
      listId: publicListId,
      title: "Open work",
      sprintId,
    });

    const ownerBoard = await owner.query(api.scrumBoard.board, { sprintId });
    expect(ownerBoard?.tasks.map((x) => x.title).sort()).toEqual([
      "Open work",
      "Secret work",
    ]);

    const member = t.withIdentity(MEMBER);
    const memberBoard = await member.query(api.scrumBoard.board, { sprintId });
    expect(memberBoard?.tasks.map((x) => x.title)).toEqual(["Open work"]);
  });
});
