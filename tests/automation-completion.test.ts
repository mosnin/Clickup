import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

// Completion automations used to patch the row and then walk away: no
// assignment ping, no task.assigned event, and spawnRecurringInstance
// copied the pre-automation snapshot. The create path already re-reads;
// these tests lock the same contract onto status_changed_to_complete.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);

  const ids = await t.run(async (ctx) => {
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Tasks",
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
    const reviewerId = await ctx.db.insert("agents", {
      name: "Reviewer",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_reviewer";
    await ctx.db.insert("agentKeys", {
      agentId: reviewerId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return {
      spaceId,
      listId,
      openStatus,
      doneStatus,
      reviewerId,
      apiKey,
    };
  });

  return { t, alice, ...ids };
}

describe("completion automations", () => {
  it("wakes an agent assigned by status_changed_to_complete", async () => {
    const { t, alice, listId, doneStatus, reviewerId } = await setup();

    await alice.mutation(api.listAutomations.create, {
      listId,
      trigger: "status_changed_to_complete",
      action: { kind: "assign_user", clerkId: reviewerId },
    });

    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship the review",
    });
    await alice.mutation(api.tasks.update, {
      taskId,
      statusId: doneStatus,
    });

    const completed = await alice.query(api.tasks.get, { taskId });
    expect(completed?.assigneeClerkIds).toEqual([reviewerId]);

    const assignedEvents = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter(
        (e) => e.type === "task.assigned" && e.entityId === taskId,
      ),
    );
    expect(assignedEvents).toHaveLength(1);
    expect(assignedEvents[0]?.payload).toEqual({
      assigneeIds: [reviewerId],
    });

    const inbox = await t.query(api.agentApi.listWakeInbox, {
      apiKey: "cua_test_key_reviewer",
    });
    expect(inbox).toEqual([
      expect.objectContaining({
        type: "task.assigned",
        taskId,
      }),
    ]);
  });

  it("spawns the next recurring instance from the post-automation task", async () => {
    const { t, alice, listId, doneStatus, reviewerId } = await setup();

    await alice.mutation(api.listAutomations.create, {
      listId,
      trigger: "status_changed_to_complete",
      action: { kind: "assign_user", clerkId: reviewerId },
    });

    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Weekly review",
      recurrence: "weekly",
    });
    await alice.mutation(api.tasks.update, {
      taskId,
      statusId: doneStatus,
    });

    const tasks = await alice.query(api.tasks.listForList, { listId });
    const next = tasks.find((row) => row._id !== taskId);
    expect(next).toBeDefined();
    expect(next?.title).toBe("Weekly review");
    expect(next?.recurrence).toBe("weekly");
    expect(next?.assigneeClerkIds).toEqual([reviewerId]);
    expect(next?.completedAt).toBeUndefined();
  });

  it("still notifies on create-time assign_user (the path that already worked)", async () => {
    const { t, alice, listId, reviewerId } = await setup();

    await alice.mutation(api.listAutomations.create, {
      listId,
      trigger: "task_created",
      action: { kind: "assign_user", clerkId: reviewerId },
    });

    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Created already assigned",
    });

    const created = await alice.query(api.tasks.get, { taskId });
    expect(created?.assigneeClerkIds).toEqual([reviewerId]);

    const inbox = await t.query(api.agentApi.listWakeInbox, {
      apiKey: "cua_test_key_reviewer",
    });
    expect(inbox).toEqual([
      expect.objectContaining({
        type: "task.assigned",
        taskId,
      }),
    ]);
  });
});
