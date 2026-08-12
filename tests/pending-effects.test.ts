import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";
import {
  describeBatch,
  groupByAgent,
  sortEffects,
} from "../src/lib/pending-effects";

// Deferred consent — an agent's finished work, kept instead of refused.
//
// The centre of this file is the FIRST test, and it is the one to keep working
// if the rest ever has to be rewritten: a deferred completion must not complete
// anything. Everything else here is convenience; that one is the guarantee, and
// "we made approvals more convenient" is precisely the sentence under which a
// gate stops gating.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

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
    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_scout";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { spaceId, listId, openStatus, doneStatus, agentId, apiKey };
  });

  return { t, alice, ...ids };
}

async function gatedTask(
  alice: ReturnType<typeof convexTest>["withIdentity"] extends (
    ...a: never[]
  ) => infer R
    ? R
    : never,
  listId: Id<"lists">,
  title = "Gated work",
) {
  return await alice.mutation(api.tasks.create, {
    listId,
    title,
    requiresApproval: true,
  });
}

describe("the gate still gates", () => {
  it("records the completion without completing anything", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);

    const result = await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Shipped the migration and ran the smoke test.",
    });

    // The agent is not refused...
    expect(result.pending).toBe(true);
    expect(result.applied).toBe(false);

    // ...and the task has not moved an inch.
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).not.toBe(doneStatus);
    expect(task?.completedAt ?? undefined).toBeUndefined();
    expect(task?.approvedAt ?? undefined).toBeUndefined();
  });

  it("still refuses at the core, so the deferral is not the only guard", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    // updateTask is the path that does NOT defer. It must behave exactly as it
    // did before any of this existed — belt and braces, because the branch that
    // decides to defer is ordinary code and can be wrong.
    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey,
        taskId,
        statusId: doneStatus,
      }),
    ).rejects.toThrow(/approval/i);
  });

  it("completes only when a human approves, credited to the agent", async () => {
    const { t, alice, listId, doneStatus, apiKey, agentId } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });

    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    expect(queue).toHaveLength(1);
    const r = await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "approve",
    });
    expect(r).toEqual({ applied: 1, rejected: 0, superseded: 0 });

    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).toBe(doneStatus);
    expect(task?.approvedAt).toBeGreaterThan(0);

    // The work was the agent's; the consent was the human's. The feed has to
    // say the first of those, or a fleet's whole afternoon gets attributed to
    // whoever happened to clear the queue.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("entityId"), taskId))
        .collect(),
    );
    const completion = events.find(
      (e) => e.type === "task.updated" || e.type === "task.completed",
    );
    expect(completion?.actorType).toBe("agent");
    expect(completion?.actorId).toBe(agentId);
  });
});

describe("proposing", () => {
  it("does not pile up when an agent retries", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);

    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "First attempt.",
    });
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Second, with more detail.",
    });

    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    expect(queue).toHaveLength(1);
    // The newer account replaces the older one — a retry is the more recent
    // description of the work, not a duplicate of it.
    expect(queue[0].reason).toBe("Second, with more detail.");
  });

  it("does not defer a task with no gate", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ordinary work",
    });
    const result = await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
    });
    expect(result.applied).toBe(true);
    expect(result.pending).toBe(false);
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).toBe(doneStatus);
    expect(
      await alice.query(api.pendingEffects.listForCurrentUser, {}),
    ).toEqual([]);
  });

  it("does not defer a gate a human already lifted", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await alice.mutation(api.tasks.approve, { taskId });
    const result = await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
    });
    expect(result.applied).toBe(true);
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).toBe(doneStatus);
  });
});

describe("deciding", () => {
  it("rejecting leaves the task alone and tells the agent", async () => {
    const { t, alice, listId, doneStatus, apiKey, agentId } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    const r = await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "reject",
      note: "The tests were not run.",
    });
    expect(r.rejected).toBe(1);

    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).not.toBe(doneStatus);

    // A rejection the agent never hears about is a silent failure — it will
    // simply wait for an approval that is never coming.
    const notices = await t.run(async (ctx) =>
      ctx.db
        .query("agentPingDeliveries")
        .withIndex("by_agent", (q) => q.eq("agentId", agentId))
        .collect(),
    );
    const decided = notices.find((n) => n.sourceKind === "effect_decided");
    expect(decided).toBeDefined();
    expect(decided?.payload.outcome).toBe("rejected");
    expect(decided?.payload.note).toBe("The tests were not run.");
  });

  it("does not apply a proposal the world moved under", async () => {
    const { t, alice, listId, openStatus, doneStatus, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });

    // Somebody moves the task after the proposal was made. Approving now would
    // be consenting to a description of the task that is no longer true.
    const other = await t.run(async (ctx) =>
      ctx.db.insert("listStatuses", {
        listId,
        name: "In review",
        color: "#00f",
        category: "in_progress",
        position: 2,
        createdAt: Date.now(),
      }),
    );
    await alice.mutation(api.tasks.update, { taskId, statusId: other });

    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    expect(queue[0].stale).toBe(true);
    const r = await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "approve",
    });
    expect(r).toEqual({ applied: 0, rejected: 0, superseded: 1 });

    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.statusId).toBe(other);
    expect(task?.statusId).not.toBe(doneStatus);
    expect(openStatus).toBeDefined();
  });

  it("applies a batch in one call and reports each outcome", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const a = await gatedTask(alice, listId, "One");
    const b = await gatedTask(alice, listId, "Two");
    const c = await gatedTask(alice, listId, "Three");
    for (const taskId of [a, b, c]) {
      await t.mutation(api.agentApi.completeTask, {
        apiKey,
        taskId,
        note: "Done.",
      });
    }
    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    expect(queue).toHaveLength(3);
    const r = await alice.mutation(api.pendingEffects.decide, {
      ids: queue.map((x) => x.id),
      decision: "approve",
    });
    expect(r.applied).toBe(3);
    expect(
      await alice.query(api.pendingEffects.listForCurrentUser, {}),
    ).toEqual([]);
  });

  it("is safe to decide twice", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "approve",
    });
    // Two people clearing the same queue is the expected case, not an error —
    // failing the whole batch because one row was handled a second ago would
    // make the bulk button unusable on a team.
    const again = await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "approve",
    });
    expect(again).toEqual({ applied: 0, rejected: 0, superseded: 0 });
  });
});

describe("visibility", () => {
  it("never shows one person another person's handbacks", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });

    const bob = t.withIdentity(BOB);
    expect(
      await bob.query(api.pendingEffects.listForCurrentUser, {}),
    ).toEqual([]);
    expect(await bob.query(api.pendingEffects.countForCurrentUser, {})).toBe(0);
    // And cannot decide one by id — the scope range only narrows the search,
    // the task check is the boundary.
    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    await expect(
      bob.mutation(api.pendingEffects.decide, {
        ids: [queue[0].id],
        decision: "approve",
      }),
    ).rejects.toThrow();
  });

  it("does not list the same task twice under two different verbs", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });

    const queue = await alice.query(api.obligations.forCurrentUser, {});
    // The task is gated AND has a completion waiting, which used to produce
    // two rows about one thing. That is not merely untidy: the two rows had
    // DIFFERENT buttons, and the approval one lifts the gate without applying
    // the agent's completion — so a person clicking it believes they have
    // approved the work while the finished completion sits unapplied.
    //
    // The handback wins because it is strictly the better row: it carries the
    // agent's account of what it did, and its Approve actually completes.
    expect(queue.filter((r) => r.kind === "approval")).toEqual([]);
    expect(queue.filter((r) => r.kind === "handback")).toHaveLength(1);
    expect(await alice.query(api.obligations.countForCurrentUser, {})).toBe(1);
  });

  it("shows the gate again if the handback is sent back", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const queue = await alice.query(api.pendingEffects.listForCurrentUser, {});
    await alice.mutation(api.pendingEffects.decide, {
      ids: [queue[0].id],
      decision: "reject",
      note: "Not yet.",
    });

    // Suppression is about the pending row, not a permanent silencing. Once
    // the handback is resolved the task is an ordinary gated task again and
    // has to reappear, or rejecting one would quietly hide the gate forever.
    const after = await alice.query(api.obligations.forCurrentUser, {});
    expect(after.filter((r) => r.kind === "approval").map((r) => r.id)).toEqual(
      [taskId],
    );
  });

  it("joins the one queue rather than starting a fifth", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const queue = await alice.query(api.obligations.forCurrentUser, {});
    const handback = queue.find((r) => r.kind === "handback");
    expect(handback).toBeDefined();
    expect(handback?.raisedBy).toBe("Scout finished this");
    expect(
      await alice.query(api.obligations.countForCurrentUser, {}),
    ).toBeGreaterThan(0);
  });
});

describe("the fleet does not re-do it", () => {
  it("keeps work awaiting approval out of the dispatcher", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId, "Finished, waiting");

    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    // The claim is what protects it for the first hour; this asserts the
    // protection that outlives the claim, so release it first.
    await alice.mutation(api.tasks.releaseClaim, { taskId }).catch(() => {});

    const dispatch = await t.query(api.agentApi.nextTask, { apiKey });
    expect(dispatch.tasks.map((x: { taskId: string }) => x.taskId)).not.toContain(
      taskId,
    );
    // And says WHY, so an agent can tell "nothing to do" from "it is all
    // sitting on a person".
    expect(dispatch.dispatch.skipped.awaitingApproval).toBe(1);
  });

  it("tells an agent re-reading the task that it is already handed back", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Migrated and smoke-tested.",
    });
    const view = await t.query(api.agentApi.getTask, { apiKey, taskId });
    expect(view.pendingCompletion).not.toBeNull();
    expect(view.pendingCompletion?.proposedBy).toBe("Scout");
    expect(view.pendingCompletion?.reason).toBe("Migrated and smoke-tested.");
  });
});

describe("the task's own page", () => {
  it("reports the waiting completion, with the agent's account", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Migrated the table and ran the smoke test.",
    });
    const row = await alice.query(api.pendingEffects.forTask, { taskId });
    expect(row?.agentName).toBe("Scout");
    // The point of recording the attempt rather than refusing it was to keep
    // this. Without it a reviewer has to re-do the work to find out what
    // happened before they can consent to it.
    expect(row?.reason).toBe("Migrated the table and ran the smoke test.");
    expect(row?.stale).toBe(false);
  });

  it("says nothing when there is nothing waiting", async () => {
    const { alice, listId } = await setup();
    const taskId = await gatedTask(alice, listId);
    expect(await alice.query(api.pendingEffects.forTask, { taskId })).toBeNull();
  });

  it("flags a proposal the task has moved out from under", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const other = await t.run(async (ctx) =>
      ctx.db.insert("listStatuses", {
        listId,
        name: "In review",
        color: "#00f",
        category: "in_progress",
        position: 2,
        createdAt: Date.now(),
      }),
    );
    await alice.mutation(api.tasks.update, { taskId, statusId: other });
    // Shown before the button is pressed, not discovered after: approving a
    // stale proposal supersedes it, and a person deserves to know that is what
    // the click will do.
    expect((await alice.query(api.pendingEffects.forTask, { taskId }))?.stale)
      .toBe(true);
  });

  it("tells an outsider nothing", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await gatedTask(alice, listId);
    await t.mutation(api.agentApi.completeTask, {
      apiKey,
      taskId,
      note: "Done.",
    });
    const bob = t.withIdentity(BOB);
    expect(await bob.query(api.pendingEffects.forTask, { taskId })).toBeNull();
  });
});

describe("the pure helpers", () => {
  it("sorts oldest first", () => {
    const rows = [{ createdAt: 30 }, { createdAt: 10 }, { createdAt: 20 }];
    expect(sortEffects(rows).map((r) => r.createdAt)).toEqual([10, 20, 30]);
  });

  it("groups by agent, oldest group first", () => {
    const rows = [
      { agentId: "b", agentName: "Bee", createdAt: 50 },
      { agentId: "a", agentName: "Ay", createdAt: 10 },
      { agentId: "b", agentName: "Bee", createdAt: 20 },
    ];
    const groups = groupByAgent(rows);
    // "a" waited from 10, "b" from 20 — so "a" leads, even though grouping by
    // name alphabetically would give the same answer here by luck. The order
    // that matters is the wait.
    expect(groups.map((g) => g.agentId)).toEqual(["a", "b"]);
    expect(groups[1].items.map((i) => i.createdAt)).toEqual([20, 50]);
  });

  it("says the consequence, and gets singular right", () => {
    expect(describeBatch([])).toBe("Nothing selected");
    expect(describeBatch([{ kind: "task.complete" }])).toBe("Complete 1 task");
    expect(
      describeBatch([{ kind: "task.complete" }, { kind: "task.complete" }]),
    ).toBe("Complete 2 tasks");
  });
});
