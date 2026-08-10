import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  BURST_LIMIT_PER_MINUTE,
  sha256Hex,
} from "../convex/_agentAuth";

// Integration tests for the rules that make multi-agent collaboration
// safe: hierarchy authz, claims, blockers, approval gates, roles, and
// budgets — run against convex-test's in-memory backend.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

// Everything a test needs: Alice's personal space with one list + its
// statuses, and an agent with a usable API key.
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

describe("read authorization", () => {
  it("does not leak tasks across users by ID", async () => {
    const { t, alice, listId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Secret plan",
    });

    const bob = t.withIdentity(BOB);
    expect(await bob.query(api.tasks.get, { taskId })).toBeNull();
    expect(await bob.query(api.tasks.listForList, { listId })).toEqual([]);
    expect(await bob.query(api.tasks.titles, { taskIds: [taskId] })).toEqual(
      {},
    );
    // The owner still sees it.
    expect(await alice.query(api.tasks.get, { taskId })).not.toBeNull();
  });
});

describe("claims", () => {
  it("refuses a second claim while the first is fresh", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Contested work",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });
    await expect(
      alice.mutation(api.tasks.claim, { taskId }),
    ).rejects.toThrow(/already claimed/);
    // Humans can force-release, after which claiming works.
    await alice.mutation(api.tasks.releaseClaim, { taskId });
    await alice.mutation(api.tasks.claim, { taskId });
  });
});

describe("blockers", () => {
  it("refuses completion while a blocker is open", async () => {
    const { t, alice, listId, doneStatus, apiKey } = await setup();
    const blocker = await alice.mutation(api.tasks.create, {
      listId,
      title: "Foundation",
    });
    const blocked = await alice.mutation(api.tasks.create, {
      listId,
      title: "Roof",
    });
    await alice.mutation(api.tasks.update, {
      taskId: blocked,
      blockedByTaskIds: [blocker],
    });

    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey, taskId: blocked }),
    ).rejects.toThrow(/blocked/);

    await alice.mutation(api.tasks.update, {
      taskId: blocker,
      statusId: doneStatus,
    });
    await t.mutation(api.agentApi.completeTask, { apiKey, taskId: blocked });
  });

  it("refuses a dependency cycle, direct and transitive", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const a = await alice.mutation(api.tasks.create, { listId, title: "A" });
    const b = await alice.mutation(api.tasks.create, { listId, title: "B" });
    const c = await alice.mutation(api.tasks.create, { listId, title: "C" });
    // A ← B (B blocked by A) is fine…
    await alice.mutation(api.tasks.update, {
      taskId: b,
      blockedByTaskIds: [a],
    });
    // …but closing the loop is not: completion is refused while a blocker
    // is open, so A→B→A is two tasks neither of which can ever complete —
    // and agents wire dependencies programmatically, which is how the wedge
    // gets built without anyone noticing.
    await expect(
      alice.mutation(api.tasks.update, { taskId: a, blockedByTaskIds: [b] }),
    ).rejects.toThrow(/cycle/);
    // Transitive too, and over the agent path: C blocked by B, then A
    // blocked by C would close A→C→B→A.
    await alice.mutation(api.tasks.update, {
      taskId: c,
      blockedByTaskIds: [b],
    });
    await expect(
      t.mutation(api.agentApi.addDependency, {
        apiKey,
        taskId: a,
        blockedByTaskId: c,
      }),
    ).rejects.toThrow(/cycle/);
  });
});

describe("approval gates", () => {
  it("blocks agents until a human approves; agents cannot lower the gate", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Risky deploy",
      requiresApproval: true,
    });

    await expect(
      t.mutation(api.agentApi.completeTask, { apiKey, taskId }),
    ).rejects.toThrow(/approval/);
    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey,
        taskId,
        requiresApproval: false,
      }),
    ).rejects.toThrow(/Only a human/);

    await alice.mutation(api.tasks.approve, { taskId });
    await t.mutation(api.agentApi.completeTask, { apiKey, taskId });
  });
});

describe("agent governance", () => {
  it("rejects mutations from readonly agents but allows reads", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, { agentId, role: "readonly" });

    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId,
        title: "Nope",
      }),
    ).rejects.toThrow(/read-only/);
    // Reads and presence still work.
    expect(await t.query(api.agentApi.listTasks, { apiKey })).toEqual([]);
    await t.mutation(api.agentApi.heartbeat, {
      apiKey,
      statusText: "observing",
    });
  });

  it("enforces the daily action budget", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, { agentId, dailyActionLimit: 2 });

    await t.mutation(api.agentApi.createTask, { apiKey, listId, title: "1" });
    await t.mutation(api.agentApi.createTask, { apiKey, listId, title: "2" });
    await expect(
      t.mutation(api.agentApi.createTask, { apiKey, listId, title: "3" }),
    ).rejects.toThrow(/budget exhausted/);
  });

  it("enforces the exact burst boundary without blocking reads or presence", async () => {
    const { t, listId, agentId, apiKey } = await setup();
    const day = new Date().toISOString().slice(0, 10);
    const minute = new Date().toISOString().slice(0, 16);
    const usageId = await t.run((ctx) =>
      ctx.db.insert("agentUsage", {
        agentId,
        day,
        count: BURST_LIMIT_PER_MINUTE - 1,
        minute,
        minuteCount: BURST_LIMIT_PER_MINUTE - 1,
      }),
    );

    // The 60th write is accepted; the 61st is refused before its handler
    // can create another task or consume another unit of daily budget.
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Boundary write",
    });
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId,
        title: "Refused write",
      }),
    ).rejects.toThrow(/rate limited.*60 actions\/minute/i);

    const usage = await t.run((ctx) => ctx.db.get(usageId));
    expect(usage).toMatchObject({
      count: BURST_LIMIT_PER_MINUTE,
      minute,
      minuteCount: BURST_LIMIT_PER_MINUTE,
    });
    expect(await t.query(api.agentApi.listTasks, { apiKey })).toHaveLength(1);

    // A throttled runtime must still be able to observe work and report
    // liveness so operators can diagnose it instead of seeing a false outage.
    await t.mutation(api.agentApi.heartbeat, {
      apiKey,
      statusText: "throttled but healthy",
    });
    expect(await t.query(api.agentApi.whoami, { apiKey })).toMatchObject({
      actionsUsedToday: BURST_LIMIT_PER_MINUTE,
      actionsRemainingToday: 2_000 - BURST_LIMIT_PER_MINUTE,
      burstLimitPerMinute: BURST_LIMIT_PER_MINUTE,
    });
  });

  it("invalidates every API mode while an agent is paused", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, { agentId, status: "paused" });

    await expect(
      t.query(api.agentApi.whoami, { apiKey }),
    ).rejects.toThrow(/agent is paused/i);
    await expect(
      t.mutation(api.agentApi.connect, { apiKey }),
    ).rejects.toThrow(/agent is paused/i);
    await expect(
      t.mutation(api.agentApi.heartbeat, { apiKey }),
    ).rejects.toThrow(/agent is paused/i);
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId,
        title: "Must not be created",
      }),
    ).rejects.toThrow(/agent is paused/i);
  });

  it("confines list-restricted agents to their allowed lists", async () => {
    const { t, alice, spaceId, listId, agentId, apiKey } = await setup();
    const otherList = await t.run(async (ctx) => {
      const id = await ctx.db.insert("lists", {
        name: "Off limits",
        parentType: "space",
        parentId: spaceId,
        position: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("listStatuses", {
        listId: id,
        name: "To Do",
        color: "#aaa",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      return id;
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });

    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Allowed",
    });
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId: otherList as Id<"lists">,
        title: "Denied",
      }),
    ).rejects.toThrow(/not allowed/);
    // Structure-level ops are refused entirely for restricted agents.
    await expect(
      t.mutation(api.agentApi.createSpace, { apiKey, name: "New space" }),
    ).rejects.toThrow(/restricted/);
  });

  it("normalizes an empty allowedListIds to unrestricted instead of bricking the agent", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    // Restrict, then remove the only restriction the way the UI does when
    // the last badge is cleared (filtering the array down to []).
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [],
    });
    const agent = await t.run((ctx) => ctx.db.get(agentId));
    // [] must never be stored verbatim — _agentAuth keys off `undefined`,
    // so a stored [] would refuse every list and every structure op.
    expect(agent?.allowedListIds).toBeUndefined();

    // The agent is unrestricted again: it can create a space (a
    // structure-level op restricted agents can never perform) and create a
    // task on a list that was never in the old allow-list.
    await t.mutation(api.agentApi.createSpace, { apiKey, name: "New space" });
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Still works",
    });

    // null (what the UI now sends) normalizes the same way.
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: null,
    });
    const agentAfterNull = await t.run((ctx) => ctx.db.get(agentId));
    expect(agentAfterNull?.allowedListIds).toBeUndefined();
  });

  it("invalid and revoked keys are rejected", async () => {
    const { t, apiKey } = await setup();
    await expect(
      t.query(api.agentApi.whoami, { apiKey: "cua_wrong" }),
    ).rejects.toThrow(/Invalid API key/);
    await t.run(async (ctx) => {
      const key = await ctx.db
        .query("agentKeys")
        .withIndex("by_hash", (q) => q.eq("keyHash", sha256Hex(apiKey)))
        .unique();
      await ctx.db.patch(key!._id, { revokedAt: Date.now() });
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey }),
    ).rejects.toThrow(/Invalid API key/);
  });
});

describe("run history — the memory layer", () => {
  // The largest capability gap in the product was that agents could WRITE
  // runs and never read one back. These cover the three things that make the
  // feature worth having, and the one thing that would make it a leak.

  it("lets a teammate's lesson be read, and reads a run in full", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Migrate the ledger",
    });

    // A second agent in the SAME scope has already tried and failed.
    const other = await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Pathfinder",
        parentType: "user",
        parentId: ALICE.subject,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentRuns", {
        agentId: id,
        taskId,
        title: "First attempt",
        status: "failed",
        error: "The staging credentials are rotated",
        links: ["https://example.test/run/1"],
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 30_000,
        steps: [
          {
            key: "connect",
            title: "Connect to staging",
            status: "failed",
            startedAt: Date.now() - 55_000,
            finishedAt: Date.now() - 50_000,
          },
        ],
      });
      return id;
    });

    // A run someone else can't see is a lesson nobody learns: same scope,
    // so it reads.
    const runs = await t.query(api.agentApi.listRuns, { apiKey, taskId });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toMatch(/credentials/);

    const full = await t.query(api.agentApi.getRun, {
      apiKey,
      runId: runs[0].runId,
    });
    expect(full.agentName).toBe("Pathfinder");
    expect(full.steps).toHaveLength(1);
    expect(full.steps[0].status).toBe("failed");
    expect(other).toBeDefined();
  });

  it("carries recent outcomes on get_task, where they are acted on", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship the invite emails",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRuns", {
        agentId,
        taskId,
        title: "Attempt",
        status: "succeeded",
        summary: "Sent 40 invites",
        startedAt: Date.now() - 10_000,
        finishedAt: Date.now(),
      });
    });
    const task = await t.query(api.agentApi.getTask, { apiKey, taskId });
    expect(task.recentOutcomes).toHaveLength(1);
    expect(task.recentOutcomes[0].summary).toBe("Sent 40 invites");
  });

  it("refuses a run belonging to another scope — existence is information", async () => {
    const { t, apiKey } = await setup();
    const foreignRun = await t.run(async (ctx) => {
      const strangerAgent = await ctx.db.insert("agents", {
        name: "Stranger",
        parentType: "user",
        parentId: "user_someone_else",
        status: "active",
        createdByClerkId: "user_someone_else",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("agentRuns", {
        agentId: strangerAgent,
        title: "Not yours",
        status: "succeeded",
        startedAt: Date.now(),
      });
    });
    await expect(
      t.query(api.agentApi.getRun, { apiKey, runId: foreignRun }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("dispatch — one selector, not two", () => {
  it("honours the concurrency ceiling on the pull path and says why", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    // Default maxConcurrentTasks is 1. Hand the agent a task and let it claim.
    const first = await alice.mutation(api.tasks.create, {
      listId,
      title: "Held work",
    });
    await alice.mutation(api.tasks.create, { listId, title: "Queued work" });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId: first });

    const offered = await t.query(api.agentApi.nextTask, {
      apiKey,
      includeUnassigned: true,
      limit: 3,
    });
    // At its ceiling: nothing handed out, and the reason is legible rather
    // than an empty list that reads as an empty backlog.
    expect(offered.tasks).toHaveLength(0);
    expect(offered.dispatch.activeLoad).toBe(1);
    expect(offered.dispatch.availableSlots).toBe(0);
    expect(offered.dispatch.skipped.atConcurrencyLimit).toBeGreaterThan(0);

    // Raise the ceiling and the same backlog flows.
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { maxConcurrentTasks: 3 });
    });
    const after = await t.query(api.agentApi.nextTask, {
      apiKey,
      includeUnassigned: true,
      limit: 3,
    });
    expect(after.tasks.length).toBeGreaterThan(0);
    expect(after.dispatch.availableSlots).toBe(2);
  });
});

describe("spend ceilings", () => {
  // The ceiling that was charted and never enforced. Money is the one budget
  // where "we show you a graph" is not a control: an agent could burn
  // hundreds of dollars of tokens inside three mutations while the only
  // enforced limit counted the mutations.

  it("stops the agent once its own daily ceiling is crossed", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      dailySpendUsdLimit: 5,
    });

    // Under the ceiling: work continues.
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Cheap work",
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId: runId,
      status: "succeeded",
      costUsd: 2,
    });
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Still allowed",
    });

    // Crossing it stops the NEXT action, not the one that crossed — cost is
    // known when a run ends, never before an action starts, so a circuit
    // breaker is the only honest shape.
    const run2Id = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Expensive work",
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId: run2Id,
      status: "succeeded",
      costUsd: 4,
    });
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey,
        listId,
        title: "Refused",
      }),
    ).rejects.toThrow(/spend ceiling/i);
  });

  it("records spend that crosses the line instead of refusing it", async () => {
    const { t, alice, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      dailySpendUsdLimit: 1,
    });
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Overrun",
    });
    // The money is already gone. Refusing to write it down would only hide
    // the overrun from whoever set the limit — so finish_run authenticates
    // as presence and always commits.
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId: runId,
      status: "succeeded",
      costUsd: 40,
    });
    const detail = await alice.query(api.agents.detail, { agentId });
    expect(detail?.spendTodayUsd).toBe(40);
    expect(detail?.spendLimitUsd).toBe(1);
  });

  it("stops every agent in the space when the FLEET ceiling is crossed", async () => {
    const { t, alice, listId, apiKey } = await setup();
    // The number an agency owner actually sets: ten agents at twenty dollars
    // each is a two-hundred dollar day nobody agreed to.
    await alice.mutation(api.x402.setFleetSpendLimit, {
      scopeType: "user",
      scopeId: ALICE.subject,
      dailySpendUsdLimit: 10,
    });
    // A SECOND agent in the same space, with no ceiling of its own.
    const other = await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Runner",
        parentType: "user",
        parentId: ALICE.subject,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      });
      const key = "cua_test_key_runner";
      await ctx.db.insert("agentKeys", {
        agentId: id,
        keyHash: sha256Hex(key),
        keyPrefix: key.slice(0, 12),
        createdAt: Date.now(),
      });
      return { id, key };
    });

    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Burn the fleet budget",
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId: runId,
      status: "succeeded",
      costUsd: 12,
    });

    // The agent that spent it is stopped…
    await expect(
      t.mutation(api.agentApi.createTask, { apiKey, listId, title: "No" }),
    ).rejects.toThrow(/fleet daily spend/i);
    // …and so is the teammate that spent nothing. That is the point.
    await expect(
      t.mutation(api.agentApi.createTask, {
        apiKey: other.key,
        listId,
        title: "Also no",
      }),
    ).rejects.toThrow(/fleet daily spend/i);
  });

  it("announces the crossing once, where it can commit", async () => {
    const { t, alice, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      dailySpendUsdLimit: 3,
    });
    for (const cost of [1, 5, 5]) {
      const rId = await t.mutation(api.agentApi.startRun, {
        apiKey,
        title: `spend ${cost}`,
      });
      await t.mutation(api.agentApi.finishRun, {
        apiKey,
        runId: rId,
        status: "succeeded",
        costUsd: cost,
      });
    }
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "agent.budget_exhausted"))
        .collect(),
    );
    // Once — on the crossing. Not once per run after it, and not never
    // (which is what emitting from the throwing refusal path would give,
    // since a Convex mutation that throws rolls back everything it wrote).
    expect(events.length).toBe(1);
  });

  it("leaves an agent with no ceiling uncapped", async () => {
    const { t, listId, apiKey } = await setup();
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Costly but uncapped",
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId: runId,
      status: "succeeded",
      costUsd: 9999,
    });
    // A ceiling nobody set must never halt a working fleet.
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Allowed",
    });
  });
});

describe("the stop signal", () => {
  // A pause says "this agent is off until further notice". A stop is about
  // the work in flight: drop what you are doing now. The product only had
  // the first, and it was invisible to a run already going.

  it("refuses writes, releases claims, and tells the agent why", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Work in flight",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });

    const { released } = await alice.mutation(api.agents.requestStop, {
      agentId,
      reason: "Spending too long on the wrong thing",
    });
    // A stopped agent holding claims is work nobody else may touch, held by
    // something told to do nothing.
    expect(released).toBe(1);

    await expect(
      t.mutation(api.agentApi.createTask, { apiKey, listId, title: "No" }),
    ).rejects.toThrow(/stopped by a human/i);

    // Reads and presence survive: a stopped agent must still be able to say
    // where it got to.
    await t.mutation(api.agentApi.heartbeat, { apiKey, statusText: "halted" });

    // And it learns through the channel it already polls, rather than
    // discovering the stop as a refusal on its next write.
    const inbox = await t.query(api.agentApi.listWakeInbox, { apiKey });
    const notice = inbox.find((d) => d.type === "stop");
    expect(notice).toBeDefined();
    expect(notice?.payload.reason).toMatch(/wrong thing/);
    expect(notice?.payload.resumesWhen).toMatch(/human clears/);
  });

  it("lifts cleanly — a stop nobody can clear is just a pause", async () => {
    const { t, alice, listId, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.requestStop, {
      agentId,
      reason: "Pausing the experiment",
    });
    await expect(
      t.mutation(api.agentApi.createTask, { apiKey, listId, title: "No" }),
    ).rejects.toThrow(/stopped/i);

    await alice.mutation(api.agents.clearStop, { agentId });
    await t.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Back to work",
    });
  });

  it("requires a reason — 'stopped' with no cause is what breaks trust", async () => {
    const { alice, agentId } = await setup();
    await expect(
      alice.mutation(api.agents.requestStop, { agentId, reason: "   " }),
    ).rejects.toThrow(/why/i);
  });

  it("sends a budget stop down the same channel, and says it self-clears", async () => {
    const { t, alice, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      dailySpendUsdLimit: 2,
    });
    const runId = await t.mutation(api.agentApi.startRun, {
      apiKey,
      title: "Expensive",
    });
    await t.mutation(api.agentApi.finishRun, {
      apiKey,
      runId,
      status: "succeeded",
      costUsd: 5,
    });

    const inbox = await t.query(api.agentApi.listWakeInbox, { apiKey });
    const notice = inbox.find((d) => d.type === "stop");
    expect(notice).toBeDefined();
    // The notice is shared; the LIFETIME is not, and the payload says so.
    // A daily ceiling that needed manual clearing every morning would be a
    // worse product arrived at by making the code look symmetrical.
    expect(notice?.payload.source).toBe("budget");
    expect(notice?.payload.resumesWhen).toMatch(/next UTC day/);
  });
});
