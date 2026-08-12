import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  MAX_EXECUTION_ATTEMPTS,
  RECOVERY_DELAY_MS,
  decideRecovery,
  describeExhaustion,
  type AbandonedAttempt,
} from "../convex/_recovery";

// Recovering an attempt that stopped.
//
// The lifecycle always modelled abandonment and nothing was on the other side
// of it, so a stalled attempt waited for a human to notice — the opposite of
// unattended operation. The database work is dull; the three-way decision is
// where this can be wrong, so it is pure and the tests are its specification.
//
// The case worth staring at is `reset`. It looks exactly like a retry and is
// not: the context moved, so the previous failure says nothing about the next
// attempt. Counting it against the cap burns retries on evidence that no longer
// applies; skipping it — which the roadmap suggested — strands work that is now
// perfectly viable.

const NOW = 1_700_000_000_000;
const LONG_AGO = NOW - RECOVERY_DELAY_MS - 1;

function attempt(over: Partial<AbandonedAttempt> = {}): AbandonedAttempt {
  return {
    assignmentId: "asn_1",
    taskId: "task_1",
    attempt: 1,
    finishedAt: LONG_AGO,
    ...over,
  };
}

describe("waiting", () => {
  it("leaves a fresh abandonment alone", () => {
    // An agent whose claim lapsed two minutes ago may simply be slow, and
    // re-offering immediately means two workers on it the moment it comes back.
    expect(decideRecovery(attempt({ finishedAt: NOW - 1000 }), "f", NOW)).toEqual(
      { action: "wait", reason: "too_soon" },
    );
  });

  it("counts from the last re-offer, not from when the attempt ended", () => {
    // Otherwise the pass races itself: a task handed back a minute ago is
    // immediately eligible again and gets re-offered every quarter hour.
    const a = attempt({ finishedAt: LONG_AGO, lastRecoveredAt: NOW - 1000 });
    expect(decideRecovery(a, "f", NOW).action).toBe("wait");
  });

  it("acts once the delay has passed since the re-offer", () => {
    const a = attempt({ finishedAt: LONG_AGO, lastRecoveredAt: LONG_AGO });
    expect(decideRecovery(a, "f", NOW).action).toBe("retry");
  });

  it("waits on a row with no end time rather than guessing", () => {
    expect(decideRecovery(attempt({ finishedAt: undefined }), "f", NOW).action)
      .toBe("wait");
  });
});

describe("retrying", () => {
  it("hands the work back and advances the count", () => {
    expect(decideRecovery(attempt({ attempt: 1 }), "same", NOW)).toEqual({
      action: "retry",
      attempt: 2,
    });
  });

  it("treats two unknown fingerprints as unchanged", () => {
    // A legacy row, or a task with no packets. Guessing "changed" would reset
    // the counter on every such row and turn the cap into decoration.
    expect(
      decideRecovery(
        attempt({ attempt: 2, contextVersionFingerprint: undefined }),
        undefined,
        NOW,
      ),
    ).toEqual({ action: "retry", attempt: 3 });
  });

  it("does not treat a newly-recorded fingerprint as a change", () => {
    expect(
      decideRecovery(
        attempt({ contextVersionFingerprint: undefined }),
        "now-known",
        NOW,
      ).action,
    ).toBe("retry");
  });
});

describe("resetting when the work changed", () => {
  it("starts the count over rather than spending an attempt", () => {
    const d = decideRecovery(
      attempt({ attempt: 2, contextVersionFingerprint: "before" }),
      "after",
      NOW,
    );
    expect(d).toEqual({ action: "reset", attempt: 1, reason: "context_changed" });
  });

  it("rescues a task that had already run out", () => {
    // The most important consequence. At the cap with unchanged context this
    // escalates; with changed context it is new work, and refusing to try it
    // would strand something perfectly viable behind a stale verdict.
    const exhausted = attempt({
      attempt: MAX_EXECUTION_ATTEMPTS,
      contextVersionFingerprint: "before",
    });
    expect(decideRecovery(exhausted, "before", NOW).action).toBe("escalate");
    expect(decideRecovery(exhausted, "after", NOW).action).toBe("reset");
  });
});

describe("escalating", () => {
  it("stops at the cap", () => {
    expect(
      decideRecovery(
        attempt({ attempt: MAX_EXECUTION_ATTEMPTS }),
        "same",
        NOW,
      ),
    ).toEqual({ action: "escalate", attempts: MAX_EXECUTION_ATTEMPTS });
  });

  it("stops above the cap too", () => {
    // Defensive: a row that got ahead of the cap somehow must escalate rather
    // than fall through to a retry that can never terminate.
    expect(
      decideRecovery(
        attempt({ attempt: MAX_EXECUTION_ATTEMPTS + 5 }),
        "same",
        NOW,
      ).action,
    ).toBe("escalate");
  });

  it("says why in a sentence somebody can act on", () => {
    const said = describeExhaustion(3);
    expect(said).toContain("3 times");
    // Names what has to change, rather than reporting a number and stopping.
    expect(said).toMatch(/needs changing/);
  });
});

describe("the whole ladder", () => {
  it("climbs to escalation and no further", () => {
    // One task, unchanged context, recovered repeatedly. The cap has to be
    // reachable in behaviour and not only in the source — an unreachable
    // escalation branch is a bound that does not exist.
    const seen: string[] = [];
    let a = attempt({ attempt: 1 });
    for (let i = 0; i < 5; i++) {
      const d = decideRecovery(a, "same", NOW);
      seen.push(d.action);
      if (d.action === "retry" || d.action === "reset") {
        a = { ...a, attempt: d.attempt, lastRecoveredAt: LONG_AGO };
      }
    }
    expect(seen).toEqual([
      "retry",
      "retry",
      "escalate",
      "escalate",
      "escalate",
    ]);
  });
});

// ── Through the watchdog ──
//
// The pure decision above proves the choice; this proves the pass acts on it.
// They are separable and both necessary: the first version of the thrash pass
// made a correct decision and then wrote it to the wrong field, which no unit
// test of the decision could have seen.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ALICE.subject,
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
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, listId, agentId };
  });
  return { t, alice, ...ids };
}

/** An abandoned assignment for `taskId`, as the watchdog would have left it. */
async function abandonedAssignment(
  t: Awaited<ReturnType<typeof setup>>["t"],
  ids: { workspaceId: string; spaceId: string; agentId: string },
  taskId: string,
  over: { attempt?: number; finishedAt?: number; fingerprint?: string } = {},
) {
  return await t.run(async (ctx) => {
    // A plan and a wave exist only so the assignment's foreign keys are real
    // ids. Nothing in the recovery pass dereferences them — it works from the
    // assignment and its task — so they are minimal rather than meaningful.
    const roadmapId = await ctx.db.insert("roadmaps", {
      workspaceId: ids.workspaceId as Id<"workspaces">,
      name: "Roadmap",
      phases: [],
      position: 0,
      createdAt: Date.now(),
    });
    const planId = await ctx.db.insert("executionPlans", {
      workspaceId: ids.workspaceId as Id<"workspaces">,
      spaceId: ids.spaceId as Id<"spaces">,
      createdByAgentId: ids.agentId as Id<"agents">,
      idempotencyKey: `plan-${taskId}`,
      requestFingerprint: "fp",
      name: "Plan",
      objective: "Do the thing",
      sourceContext: "-",
      successCriteria: [],
      assumptions: [],
      openQuestions: [],
      roadmapId,
      projects: [],
      tasks: [],
      createdAt: Date.now(),
    });
    const waveId = await ctx.db.insert("executionWaves", {
      workspaceId: ids.workspaceId as Id<"workspaces">,
      planId,
      createdByAgentId: ids.agentId as Id<"agents">,
      idempotencyKey: `wave-${taskId}`,
      requestFingerprint: "fp",
      assignments: [],
      skipped: [],
      createdAt: Date.now(),
    });
    return await ctx.db.insert("executionAssignments", {
      workspaceId: ids.workspaceId as Id<"workspaces">,
      planId,
      waveId,
      taskId: taskId as Id<"tasks">,
      taskRef: "t1",
      agentId: ids.agentId as Id<"agents">,
      delivery: "poll_required",
      status: "abandoned",
      attempt: over.attempt ?? 1,
      contextVersionFingerprint: over.fingerprint,
      dispatchedAt: Date.now() - RECOVERY_DELAY_MS * 3,
      finishedAt: over.finishedAt ?? Date.now() - RECOVERY_DELAY_MS - 60_000,
    });
  });
}

describe("the recovery pass", () => {
  it("hands abandoned work back and advances the count", async () => {
    const { t, alice, listId, ...ids } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Dropped work",
    });
    await alice.mutation(api.tasks.claim, { taskId });
    const assignmentId = await abandonedAssignment(t, ids, taskId);

    await t.mutation(internal.maintenance.watchdog, {});

    const task = await alice.query(api.tasks.get, { taskId });
    // Back in the pull path: no claim, no hold.
    expect(task?.claimedByActorId ?? undefined).toBeUndefined();
    expect(task?.thrashHeldAt ?? undefined).toBeUndefined();

    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    // Without this the cap is unreachable and the escalation branch is dead
    // code — a bound that exists in the source and not in the behaviour.
    expect(assignment?.attempt).toBe(2);
    expect(assignment?.lastRecoveredAt).toBeGreaterThan(0);
  });

  it("holds the task and says why once attempts run out", async () => {
    const { t, alice, listId, ...ids } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Never going to work",
    });
    await abandonedAssignment(t, ids, taskId, {
      attempt: MAX_EXECUTION_ATTEMPTS,
    });

    await t.mutation(internal.maintenance.watchdog, {});

    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.thrashHeldAt).toBeGreaterThan(0);
    // The same brake thrash detection uses, with a different label — two flags
    // that both mean "withheld until somebody looks" is how the two drift.
    expect(task?.holdReason).toBe("attempts_exhausted");

    const queue = await alice.query(api.obligations.forCurrentUser, {});
    const row = queue.find((r) => r.kind === "stuck");
    expect(row?.id).toBe(taskId);
    expect(row?.raisedBy).toBe("Held after running out of attempts");
  });

  it("leaves a task somebody already finished alone", async () => {
    const { t, alice, listId, ...ids } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Finished after the attempt died",
    });
    await abandonedAssignment(t, ids, taskId, {
      attempt: MAX_EXECUTION_ATTEMPTS,
    });
    await alice.mutation(api.tasks.toggleComplete, { taskId });

    await t.mutation(internal.maintenance.watchdog, {});
    expect(
      (await alice.query(api.tasks.get, { taskId }))?.thrashHeldAt ?? undefined,
    ).toBeUndefined();
  });

  it("does not fight a hold another pass already put on", async () => {
    const { t, alice, listId, ...ids } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Already held",
    });
    const assignmentId = await abandonedAssignment(t, ids, taskId);
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId as Id<"tasks">, {
        thrashHeldAt: Date.now(),
        holdReason: "thrash",
      });
    });

    await t.mutation(internal.maintenance.watchdog, {});
    // Recovering a task a person has been asked to look at would be the brake
    // and the accelerator fighting each other.
    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(assignment?.attempt).toBe(1);
    expect(
      (await alice.query(api.tasks.get, { taskId }))?.holdReason,
    ).toBe("thrash");
  });
});
