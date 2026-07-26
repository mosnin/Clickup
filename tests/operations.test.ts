import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Phase L operations layer: assignment routing (fixed / round-robin /
// least-loaded, explicit assignees always win), task blueprints
// (instantiation shape + scope guard + schedule materialization), and
// goal auto-rollup (derived progress, manual logging refused).

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const MATE = { subject: "user_mate", email: "mate@team.com" };

async function seed(t: ReturnType<typeof convexTest>) {
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
    await ctx.db.insert("users", {
      clerkId: MATE.subject,
      email: MATE.email,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: MATE.subject,
      role: "member",
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
  return { owner, workspaceId, spaceId, listId };
}

async function assigneesOf(
  t: ReturnType<typeof convexTest>,
  taskId: Id<"tasks">,
): Promise<string[]> {
  return await t.run(async (ctx) => (await ctx.db.get(taskId))!.assigneeClerkIds);
}

describe("assignment routing", () => {
  it("fixed mode assigns every listed assignee; explicit assignees always win", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId } = await seed(t);
    await owner.mutation(api.lists.setRouting, {
      listId,
      routing: { mode: "fixed", assigneeIds: [OWNER.subject, MATE.subject] },
    });

    const routed = await owner.mutation(api.tasks.create, {
      listId,
      title: "Unassigned in a routed list",
    });
    expect(await assigneesOf(t, routed)).toEqual([OWNER.subject, MATE.subject]);

    const explicit = await owner.mutation(api.tasks.create, {
      listId,
      title: "Explicitly assigned",
      assigneeClerkIds: ["human_c"],
    });
    expect(await assigneesOf(t, explicit)).toEqual(["human_c"]);
  });

  it("round_robin rotates through the roster", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId } = await seed(t);
    await owner.mutation(api.lists.setRouting, {
      listId,
      routing: { mode: "round_robin", assigneeIds: [OWNER.subject, MATE.subject] },
    });
    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await owner.mutation(api.tasks.create, {
        listId,
        title: `T${i}`,
      });
      got.push(...(await assigneesOf(t, id)));
    }
    expect(got).toEqual([OWNER.subject, MATE.subject, OWNER.subject]);
  });

  it("least_loaded picks whoever has the fewest open tasks on the list", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId } = await seed(t);
    // a1 already carries an open task.
    await owner.mutation(api.tasks.create, {
      listId,
      title: "Busy",
      assigneeClerkIds: [OWNER.subject],
    });
    await owner.mutation(api.lists.setRouting, {
      listId,
      routing: { mode: "least_loaded", assigneeIds: [OWNER.subject, MATE.subject] },
    });
    const id = await owner.mutation(api.tasks.create, { listId, title: "New" });
    expect(await assigneesOf(t, id)).toEqual([MATE.subject]);
  });

  it("rejects rosters with principals outside the scope", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId } = await seed(t);
    await expect(
      owner.mutation(api.lists.setRouting, {
        listId,
        routing: { mode: "fixed", assigneeIds: ["user_stranger"] },
      }),
    ).rejects.toThrow(/members of this workspace/i);
  });

  it("a task born in a Done column gets completedAt and skips routing", async () => {
    const t = convexTest(schema, modules);
    const { owner, listId } = await seed(t);
    await owner.mutation(api.lists.setRouting, {
      listId,
      routing: { mode: "round_robin", assigneeIds: [MATE.subject] },
    });
    const statuses = await owner.query(api.listStatuses.listForList, {
      listId,
    });
    const doneStatus = statuses.find(
      (s: { category: string }) => s.category === "complete",
    )!;
    const id = await owner.mutation(api.tasks.create, {
      listId,
      title: "Already done",
      statusId: doneStatus._id,
    });
    const task = await t.run(async (ctx) => (await ctx.db.get(id))!);
    expect(task.completedAt).toBeDefined();
    expect(task.assigneeClerkIds).toEqual([]);
  });
});

describe("task blueprints", () => {
  it("instantiate applies the full shape and routes through the core", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, listId } = await seed(t);
    await owner.mutation(api.lists.setRouting, {
      listId,
      routing: { mode: "round_robin", assigneeIds: [MATE.subject] },
    });
    const blueprintId = await owner.mutation(api.taskBlueprints.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "Weekly outreach",
      title: "Run the outreach checklist",
      description: "Follow the SOP.",
      priority: "high",
      checklist: ["Pull the lead list", "Send batch", "Log replies"],
      estimatePoints: 3,
      requiresApproval: true,
      dueInDays: 2,
    });
    const taskId = await owner.mutation(api.taskBlueprints.instantiate, {
      blueprintId,
      listId,
    });
    const task = await t.run(async (ctx) => (await ctx.db.get(taskId))!);
    expect(task.title).toBe("Run the outreach checklist");
    expect(task.priority).toBe("high");
    expect(task.estimatePoints).toBe(3);
    expect(task.requiresApproval).toBe(true);
    expect(task.dueDate).toBeGreaterThan(Date.now());
    expect(task.checklist?.map((c) => c.text)).toEqual([
      "Pull the lead list",
      "Send batch",
      "Log replies",
    ]);
    expect(task.checklist?.every((c) => !c.done)).toBe(true);
    // No explicit assignee → the list's routing filled it in.
    expect(task.assigneeClerkIds).toEqual([MATE.subject]);
  });

  it("refuses to instantiate into a different scope", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seed(t);
    const blueprintId = await owner.mutation(api.taskBlueprints.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "BP",
      title: "T",
    });
    // A list in a second workspace owned by the same user.
    const otherWs = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: id,
        userClerkId: OWNER.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      return id;
    });
    const otherSpace = await owner.mutation(api.spaces.create, {
      name: "Elsewhere",
      parentType: "workspace",
      parentId: otherWs,
    });
    const otherList = await owner.mutation(api.lists.create, {
      name: "Foreign",
      parentType: "space",
      parentId: otherSpace,
    });
    await expect(
      owner.mutation(api.taskBlueprints.instantiate, {
        blueprintId,
        listId: otherList,
      }),
    ).rejects.toThrow(/different scope/i);
  });

  it("a due schedule with a blueprint materializes the full task shape", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, listId } = await seed(t);
    const blueprintId = await owner.mutation(api.taskBlueprints.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "Daily standup prep",
      title: "Prep the standup",
      checklist: ["Collect updates", "Post summary"],
      priority: "normal",
    });
    const scheduleId = await owner.mutation(api.scheduledTasks.create, {
      listId,
      title: "fallback title",
      cadence: "daily",
      hourUtc: 9,
      blueprintId,
    });
    // Force the schedule due, then run the cron worker.
    await t.run(async (ctx) => {
      await ctx.db.patch(scheduleId, { nextRunAt: Date.now() - 1000 });
    });
    await t.mutation(internal.scheduledTasks.materializeDue, {});
    const tasks = await owner.query(api.tasks.listForList, { listId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Prep the standup");
    const full = await t.run(async (ctx) => (await ctx.db.get(tasks[0]._id))!);
    expect(full.checklist?.map((c) => c.text)).toEqual([
      "Collect updates",
      "Post summary",
    ]);
  });
});

describe("goal auto-rollup", () => {
  it("derives progress and status from the linked list; manual logging refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, listId } = await seed(t);
    const a = await owner.mutation(api.tasks.create, { listId, title: "A" });
    const b = await owner.mutation(api.tasks.create, { listId, title: "B" });

    const goalId = await owner.mutation(api.goals.create, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Ship both",
      targetType: "number",
      targetValue: 2,
      sourceListId: listId,
    });

    let goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.currentValue).toBe(0);
    expect(goal?.status).toBe("open");
    expect(goal?.linked).toBe(true);

    await owner.mutation(api.tasks.toggleComplete, { taskId: a });
    goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.currentValue).toBe(1);
    expect(goal?.status).toBe("open");

    await owner.mutation(api.tasks.toggleComplete, { taskId: b });
    goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.currentValue).toBe(2);
    expect(goal?.status).toBe("complete");

    await expect(
      owner.mutation(api.goals.setProgress, { goalId, currentValue: 5 }),
    ).rejects.toThrow(/automatically/i);

    // Reopening a task drops the goal back to open — the chip can never
    // contradict the number.
    await owner.mutation(api.tasks.toggleComplete, { taskId: b });
    goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.currentValue).toBe(1);
    expect(goal?.status).toBe("open");
  });

  it("deleting the linked list freezes the goal instead of zeroing it", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, listId } = await seed(t);
    const a = await owner.mutation(api.tasks.create, { listId, title: "A" });
    await owner.mutation(api.tasks.create, { listId, title: "B" });
    const goalId = await owner.mutation(api.goals.create, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Ship it",
      targetType: "number",
      targetValue: 2,
      sourceListId: listId,
    });
    await owner.mutation(api.tasks.toggleComplete, { taskId: a });

    await owner.mutation(api.lists.remove, { listId });
    const goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.linked).toBe(false);
    expect(goal?.currentValue).toBe(1); // frozen, not zeroed
    expect(goal?.status).toBe("open");
  });

  it("refuses linking non-number goals and private-space projects", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId, listId } = await seed(t);
    await expect(
      owner.mutation(api.goals.create, {
        parentType: "workspace",
        parentId: workspaceId,
        title: "Bool",
        targetType: "boolean",
        targetValue: 1,
        sourceListId: listId,
      }),
    ).rejects.toThrow(/number goals/i);

    await owner.mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
    });
    await expect(
      owner.mutation(api.goals.create, {
        parentType: "workspace",
        parentId: workspaceId,
        title: "Secret",
        targetType: "number",
        targetValue: 2,
        sourceListId: listId,
      }),
    ).rejects.toThrow(/private/i);
  });
});
