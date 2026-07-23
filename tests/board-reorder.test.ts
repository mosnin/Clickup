import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Board drag-drop reorder: `position` is a LIST-WIDE ordinal (the List /
// Table / Workload views sort every top-level task by it), while the Board
// sends only ONE status column's new order. tasks.reorder must rebuild the
// global sequence — replacing the dragged bucket's slots in place — rather
// than renumbering the bucket 0..N, which would collide with every other
// column's positions and scramble the flat ordering after a single drag.
// It must also validate status-change refusals (blockers) BEFORE writing
// anything, so a refused drop leaves positions untouched.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };

async function seedList(t: ReturnType<typeof convexTest>) {
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
    name: "Engineering",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await owner.mutation(api.lists.create, {
    name: "Backend",
    parentType: "space",
    parentId: spaceId,
  });
  const statuses = await owner.query(api.listStatuses.listForList, { listId });
  const byCategory = (category: string) =>
    statuses.find((s: { category: string }) => s.category === category)!;
  return {
    owner,
    listId,
    todo: byCategory("open")._id as Id<"listStatuses">,
    inProgress: byCategory("in_progress")._id as Id<"listStatuses">,
    complete: byCategory("complete")._id as Id<"listStatuses">,
  };
}

async function positionsByTitle(
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  listId: Id<"lists">,
): Promise<Record<string, number>> {
  const tasks = await owner.query(api.tasks.listForList, { listId });
  return Object.fromEntries(
    tasks.map((t: { title: string; position: number }) => [
      t.title,
      t.position,
    ]),
  );
}

describe("tasks.reorder (board drag-drop)", () => {
  it("rebuilds the GLOBAL order — other columns' positions survive a bucket drag", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId, todo, inProgress } = await seedList(t);

    // A..E created in order → global positions 0..4, all in To Do.
    const ids: Record<string, Id<"tasks">> = {};
    for (const title of ["A", "B", "C", "D", "E"]) {
      ids[title] = await owner.mutation(api.tasks.create, { listId, title });
    }
    // Move B and D to In Progress; positions stay A=0 B=1 C=2 D=3 E=4,
    // so the To Do bucket [A, C, E] occupies NON-contiguous global slots
    // 0, 2, 4 — exactly the shape a bucket-local 0..N renumber corrupts.
    await owner.mutation(api.tasks.update, {
      taskId: ids.B,
      statusId: inProgress,
    });
    await owner.mutation(api.tasks.update, {
      taskId: ids.D,
      statusId: inProgress,
    });

    // Drag E to the front of the To Do column: bucket order [E, A, C].
    await owner.mutation(api.tasks.reorder, {
      listId,
      orderedIds: [ids.E, ids.A, ids.C],
      statusId: todo,
    });

    // The bucket's members refill their own slots (0, 2, 4) in the new
    // order; B and D keep their slots. Global sequence: E B A D C.
    const pos = await positionsByTitle(owner, listId);
    expect(pos).toEqual({ E: 0, B: 1, A: 2, D: 3, C: 4 });

    // Sanity: positions are still a collision-free 0..N sequence (the old
    // bucket-local renumber produced E=0/B=1/A=1/C=2/D=3 style clashes).
    const values = Object.values(pos).sort((a, b) => a - b);
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it("applies a cross-column drop's status change through the core and keeps global order coherent", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId, todo, inProgress } = await seedList(t);

    const ids: Record<string, Id<"tasks">> = {};
    for (const title of ["A", "B", "C"]) {
      ids[title] = await owner.mutation(api.tasks.create, { listId, title });
    }
    await owner.mutation(api.tasks.update, {
      taskId: ids.C,
      statusId: inProgress,
    });

    // Drag C from In Progress into To Do between A and B.
    await owner.mutation(api.tasks.reorder, {
      listId,
      orderedIds: [ids.A, ids.C, ids.B],
      statusId: todo,
    });

    const tasks = await owner.query(api.tasks.listForList, { listId });
    const c = tasks.find((x: { title: string }) => x.title === "C")!;
    expect(c.statusId).toBe(todo);
    const pos = await positionsByTitle(owner, listId);
    expect(pos).toEqual({ A: 0, C: 1, B: 2 });
  });

  it("a refused drop (open blocker) aborts before writing — positions untouched", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId, complete } = await seedList(t);

    const blocker = await owner.mutation(api.tasks.create, {
      listId,
      title: "Blocker",
    });
    const blocked = await owner.mutation(api.tasks.create, {
      listId,
      title: "Blocked",
    });
    await owner.mutation(api.tasks.create, { listId, title: "Other" });
    await owner.mutation(api.tasks.update, {
      taskId: blocked,
      blockedByTaskIds: [blocker],
    });

    const before = await positionsByTitle(owner, listId);
    expect(before).toEqual({ Blocker: 0, Blocked: 1, Other: 2 });

    // Drag "Blocked" into the Complete column while its blocker is open.
    await expect(
      owner.mutation(api.tasks.reorder, {
        listId,
        orderedIds: [blocked],
        statusId: complete,
      }),
    ).rejects.toThrow(/blocked by incomplete/i);

    // Nothing moved, nothing renumbered, status unchanged.
    const after = await positionsByTitle(owner, listId);
    expect(after).toEqual(before);
    const tasks = await owner.query(api.tasks.listForList, { listId });
    const blockedTask = tasks.find(
      (x: { title: string }) => x.title === "Blocked",
    )!;
    expect(blockedTask.statusId).not.toBe(complete);
    expect(blockedTask.completedAt).toBeUndefined();
  });

  it("subtasks are excluded from the global renumber", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId, todo } = await seedList(t);

    const a = await owner.mutation(api.tasks.create, { listId, title: "A" });
    const sub = await owner.mutation(api.tasks.create, {
      listId,
      title: "A sub",
      parentTaskId: a,
    });
    const b = await owner.mutation(api.tasks.create, { listId, title: "B" });

    const subBefore = await owner.query(api.tasks.get, { taskId: sub });

    // Swap A and B within To Do (the subtask shares their status but is
    // not a board card).
    await owner.mutation(api.tasks.reorder, {
      listId,
      orderedIds: [b, a],
      statusId: todo,
    });

    const pos = await positionsByTitle(owner, listId);
    // The top-level sequence is renumbered 0..N (subtasks live in their
    // own ordering world under their parent); the subtask's position is
    // untouched by a board drag.
    expect(pos.B).toBe(0);
    expect(pos.A).toBe(1);
    expect(pos["A sub"]).toBe(subBefore!.position);
  });
});
