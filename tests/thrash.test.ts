import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  THRASH_THRESHOLD,
  THRASH_WINDOW_MS,
  describeThrash,
  detectThrash,
  type ThrashRun,
} from "../convex/_thrash";

// Thrash detection — the only check in the product that looks for repetition.
//
// The pure half is where the value is, and the property that matters most is
// the one about NOT firing: the watchdog runs every fifteen minutes over a
// six-hour window, so every failure is seen by roughly two dozen passes. A
// detector that reported a standing condition each time would file the same row
// ninety times a day, and a queue full of one row is a queue people stop
// reading — which is the exact failure the queue was built to fix.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };
const NOW = 1_700_000_000_000;

function run(over: Partial<ThrashRun> & { id: string }): ThrashRun {
  return {
    taskId: "task_1",
    agentId: "agent_1",
    status: "failed",
    finishedAt: NOW - 60_000,
    ...over,
  };
}

describe("detecting a loop", () => {
  it("says nothing below the threshold", () => {
    const runs = Array.from({ length: THRASH_THRESHOLD - 1 }, (_, i) =>
      run({ id: `r${i}` }),
    );
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("fires at the threshold, naming the count and the agents", () => {
    const runs = [
      run({ id: "r1", agentId: "a" }),
      run({ id: "r2", agentId: "b" }),
      run({ id: "r3", agentId: "a" }),
    ];
    const [finding] = detectThrash(runs, NOW);
    expect(finding.taskId).toBe("task_1");
    expect(finding.failures).toBe(3);
    // Deduped and stable, because it is rendered.
    expect(finding.agentIds).toEqual(["a", "b"]);
  });

  it("ignores failures that fell out of the window", () => {
    const stale = NOW - THRASH_WINDOW_MS - 1;
    const runs = [
      run({ id: "r1", finishedAt: stale }),
      run({ id: "r2", finishedAt: stale }),
      run({ id: "r3" }),
    ];
    // A task that failed twice long ago and once today is a hard task with a
    // history, not a live loop. The signal has to decay on its own or nobody
    // can ever get a clean slate without an administrator.
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("ignores runs that have not finished", () => {
    const runs = [
      run({ id: "r1" }),
      run({ id: "r2" }),
      run({ id: "r3", finishedAt: undefined, status: "running" }),
    ];
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("counts abandoned runs as failures", () => {
    // Claim, hang, get reaped by the stalled-agent pass, claim again is the
    // single most common loop there is. Counting only `failed` would make it
    // invisible to the one check built to see loops.
    const runs = [
      run({ id: "r1", status: "abandoned" }),
      run({ id: "r2", status: "abandoned" }),
      run({ id: "r3", status: "abandoned" }),
    ];
    expect(detectThrash(runs, NOW)).toHaveLength(1);
  });

  it("does not count succeeded runs", () => {
    const runs = [
      run({ id: "r1" }),
      run({ id: "r2", status: "succeeded" }),
      run({ id: "r3", status: "succeeded" }),
    ];
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("counts a run once however many times it is handed over", () => {
    // The caller reads overlapping windows on every pass. A detector whose
    // answer depends on how many times it was asked is not a detector.
    const runs = [run({ id: "r1" }), run({ id: "r1" }), run({ id: "r1" })];
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("keeps tasks separate", () => {
    const runs = [
      run({ id: "r1", taskId: "a" }),
      run({ id: "r2", taskId: "a" }),
      run({ id: "r3", taskId: "b" }),
      run({ id: "r4", taskId: "b" }),
    ];
    expect(detectThrash(runs, NOW)).toEqual([]);
  });

  it("puts the worst first", () => {
    const runs = [
      ...[1, 2, 3].map((i) => run({ id: `a${i}`, taskId: "a" })),
      ...[1, 2, 3, 4, 5].map((i) => run({ id: `b${i}`, taskId: "b" })),
    ];
    expect(detectThrash(runs, NOW).map((f) => f.taskId)).toEqual(["b", "a"]);
  });
});

describe("not saying it twice", () => {
  const runs = [run({ id: "r1" }), run({ id: "r2" }), run({ id: "r3" })];

  it("stays quiet when nothing has happened since the last notice", () => {
    const [first] = detectThrash(runs, NOW);
    expect(first).toBeDefined();
    // Same evidence, already reported. Every subsequent watchdog pass for the
    // next six hours sees exactly this, ~24 times.
    expect(detectThrash(runs, NOW, { task_1: first.latestAt })).toEqual([]);
  });

  it("speaks up again when the loop gets worse", () => {
    const [first] = detectThrash(runs, NOW);
    const worse = [...runs, run({ id: "r4", finishedAt: NOW - 1_000 })];
    const [second] = detectThrash(worse, NOW, { task_1: first.latestAt });
    // A loop that is still going after somebody was told is news again — but
    // only because a NEW failure landed, not because the condition still holds.
    expect(second.failures).toBe(4);
  });

  it("reports a task it has never seen", () => {
    expect(detectThrash(runs, NOW, { some_other_task: NOW })).toHaveLength(1);
  });
});

describe("what a person is told", () => {
  it("names one agent, or counts several", () => {
    const f = { taskId: "t", failures: 4, agentIds: ["a"], latestAt: NOW };
    // One agent versus three decides what to do next: probably the agent, or
    // probably the task.
    expect(describeThrash(f, ["Scout"])).toBe(
      "4 failed attempts by Scout in the last few hours",
    );
    expect(describeThrash({ ...f, agentIds: ["a", "b", "c"] }, ["A", "B", "C"]))
      .toBe("4 failed attempts by 3 agents in the last few hours");
    // A deleted agent must not produce "undefined".
    expect(describeThrash(f, [])).toBe(
      "4 failed attempts by an agent in the last few hours",
    );
  });
});

// ── The watchdog end to end ──

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
    return { listId, agentId, apiKey };
  });
  return { t, alice, ...ids };
}

async function failRuns(
  t: Awaited<ReturnType<typeof setup>>["t"],
  agentId: string,
  taskId: string,
  n: number,
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("agentRuns", {
        agentId: agentId as never,
        taskId: taskId as never,
        title: `Attempt ${i + 1}`,
        status: "failed",
        error: "boom",
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 1_000,
      });
    }
  });
}

describe("the watchdog pass", () => {
  it("holds the task, tells a person, and stops the dispatcher handing it back", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "The one it cannot do",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);

    // Before: ordinary dispatchable work.
    const before = await t.query(api.agentApi.nextTask, { apiKey });
    expect(before.tasks.map((x: { taskId: string }) => x.taskId)).toContain(
      taskId,
    );

    await t.mutation(internal.maintenance.watchdog, {});

    const held = await alice.query(api.tasks.get, { taskId });
    expect(held?.thrashHeldAt).toBeGreaterThan(0);
    expect(held?.thrashFailures).toBe(THRASH_THRESHOLD);

    // The brake. Detection with no brake is a notification, and the loop it
    // detected carries on regardless.
    const after = await t.query(api.agentApi.nextTask, { apiKey });
    expect(after.tasks.map((x: { taskId: string }) => x.taskId)).not.toContain(
      taskId,
    );
    expect(after.dispatch.skipped.heldForReview).toBe(1);

    // And it reaches the one queue a person actually watches.
    const queue = await alice.query(api.obligations.forCurrentUser, {});
    expect(queue.find((r) => r.kind === "stuck")?.id).toBe(taskId);
  });

  it("does not re-hold on every pass", async () => {
    const { t, alice, listId, agentId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Loop",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);

    await t.mutation(internal.maintenance.watchdog, {});
    await alice.mutation(api.tasks.clearThrashHold, { taskId });

    // The same six hours of failures are still there. A pass that re-held the
    // task here would make the release button do nothing at all — the worst
    // kind of broken, because it looks like it worked.
    await t.mutation(internal.maintenance.watchdog, {});
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.thrashHeldAt ?? undefined).toBeUndefined();
  });

  it("holds again when it fails again after being released", async () => {
    const { t, alice, listId, agentId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Loop",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);
    await t.mutation(internal.maintenance.watchdog, {});
    await alice.mutation(api.tasks.clearThrashHold, { taskId });

    // A person let it retry, and it failed again.
    await failRuns(t, agentId, taskId, 1);
    await t.mutation(internal.maintenance.watchdog, {});
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.thrashHeldAt).toBeGreaterThan(0);
    expect(task?.thrashFailures).toBe(THRASH_THRESHOLD + 1);
  });

  it("leaves a task alone once it is done", async () => {
    const { t, alice, listId, agentId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Got there in the end",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);
    await alice.mutation(api.tasks.toggleComplete, { taskId });

    await t.mutation(internal.maintenance.watchdog, {});
    const task = await alice.query(api.tasks.get, { taskId });
    // The failures are history, not a live loop — whatever the run log says.
    expect(task?.thrashHeldAt ?? undefined).toBeUndefined();
    expect(
      (await alice.query(api.obligations.forCurrentUser, {})).some(
        (r) => r.kind === "stuck",
      ),
    ).toBe(false);
  });

  it("clears the hold when the work finally lands", async () => {
    const { t, alice, listId, agentId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Eventually",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);
    await t.mutation(internal.maintenance.watchdog, {});
    expect(
      (await alice.query(api.tasks.get, { taskId }))?.thrashHeldAt,
    ).toBeGreaterThan(0);

    await alice.mutation(api.tasks.toggleComplete, { taskId });
    const done = await alice.query(api.tasks.get, { taskId });
    // A loop that ended with the work done needs no ceremony; leaving the flag
    // set would strand it in the queue built to show what is stuck.
    expect(done?.thrashHeldAt ?? undefined).toBeUndefined();
  });

  it("never shows one person another person's stuck work", async () => {
    const { t, alice, listId, agentId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Alice's loop",
    });
    await failRuns(t, agentId, taskId, THRASH_THRESHOLD);
    await t.mutation(internal.maintenance.watchdog, {});

    const bob = t.withIdentity({ subject: "user_bob" });
    expect(
      (await bob.query(api.obligations.forCurrentUser, {})).some(
        (r) => r.kind === "stuck",
      ),
    ).toBe(false);
    await expect(
      bob.mutation(api.tasks.clearThrashHold, { taskId }),
    ).rejects.toThrow();
  });
});
