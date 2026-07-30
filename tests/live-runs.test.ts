import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

// Live runs: the AG-UI-shaped stream between start_run and finish_run.
//
// The contract worth pinning down:
//
//  1. **The run document is the stream.** Steps, narration and state land on
//     the run row, so a watcher's ordinary subscription IS the live feed.
//  2. **Only the run's own agent can write to it**, only while it is running,
//     and another agent's run id answers "not found" — existence is
//     information.
//  3. **State stays small and deltas merge** (null deletes), because this is
//     a dashboard's worth of numbers, not a data channel.
//  4. **The read side is access-checked like the task it hangs off.**

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: id,
      role: "owner",
      joinedAt: Date.now(),
    });
    return id;
  });
  const alice = t.withIdentity(ALICE);
  const spaceId = await alice.mutation(api.spaces.create, {
    name: "HQ",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await alice.mutation(api.lists.create, {
    parentType: "space",
    parentId: spaceId,
    name: "Backlog",
  });
  const taskId = await alice.mutation(api.tasks.create, {
    listId,
    title: "Ship it",
  });

  async function makeAgent(name: string, key: string) {
    const agentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId: workspaceId,
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        status: "active",
        role: "member",
        dailyActionLimit: 2000,
      });
      await ctx.db.insert("agentKeys", {
        agentId: id,
        keyHash: sha256Hex(key),
        keyPrefix: key.slice(0, 12),
        createdAt: Date.now(),
      });
      return id;
    });
    return agentId;
  }

  const key = "cua_test_key_liveruns";
  const agentId = await makeAgent("Ada", key);
  return { t, workspaceId, listId, taskId, agentId, key, makeAgent };
}

/** A run bound to the task, through the real claim path. */
async function startTaskRun(
  t: Awaited<ReturnType<typeof seed>>["t"],
  key: string,
  taskId: Awaited<ReturnType<typeof seed>>["taskId"],
) {
  await t.mutation(api.agentApi.claimTask, { apiKey: key, taskId });
  return await t.mutation(api.agentApi.startRun, {
    apiKey: key,
    title: "Implement the thing",
    taskId,
  });
}

describe("the stream", () => {
  it("materializes steps a watcher can read in order", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);

    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "step_started",
      step: { key: "read", title: "Reading the codebase" },
    });
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "step_finished",
      step: { key: "read", detail: "12 files" },
    });
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "step_started",
      step: { key: "write", title: "Writing the fix" },
    });

    const live = await t
      .withIdentity(ALICE)
      .query(api.agents.liveRunForTask, { taskId });
    expect(live?.agentName).toBe("Ada");
    expect(live?.steps.map((s) => [s.key, s.status])).toEqual([
      ["read", "done"],
      ["write", "running"],
    ]);
    expect(live?.steps[0].detail).toBe("12 files");
  });

  it("replaces the narration line rather than accumulating a transcript", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "narration",
      text: "Reading the migration runbook",
    });
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "narration",
      text: "Found the failing constraint",
    });
    const live = await t
      .withIdentity(ALICE)
      .query(api.agents.liveRunForTask, { taskId });
    expect(live?.lastNarration).toBe("Found the failing constraint");
  });

  it("merges deltas shallowly, with null deleting a key", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "state_snapshot",
      state: { tests: 3, files: 2, branch: "fix-1" },
    });
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "state_delta",
      state: { tests: 9, branch: null },
    });
    const live = await t
      .withIdentity(ALICE)
      .query(api.agents.liveRunForTask, { taskId });
    expect(live?.liveState).toEqual({ tests: 9, files: 2 });
  });

  it("refuses state large enough to be a data channel", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await expect(
      t.mutation(api.agentApi.emitRunEvent, {
        apiKey: key,
        runId,
        type: "state_snapshot",
        state: { blob: "x".repeat(5000) },
      }),
    ).rejects.toThrow(/4KB/);
  });

  it("caps a run at 50 chapters", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    for (let i = 0; i < 50; i += 1) {
      await t.mutation(api.agentApi.emitRunEvent, {
        apiKey: key,
        runId,
        type: "step_started",
        step: { key: `s${i}` },
      });
    }
    await expect(
      t.mutation(api.agentApi.emitRunEvent, {
        apiKey: key,
        runId,
        type: "step_started",
        step: { key: "one-too-many" },
      }),
    ).rejects.toThrow(/50 steps/);
  });

  it("re-starting a step refreshes it instead of duplicating the chapter", async () => {
    // Retried calls are the normal case for an LLM runtime.
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "step_started",
      step: { key: "read", title: "Reading" },
    });
    await t.mutation(api.agentApi.emitRunEvent, {
      apiKey: key,
      runId,
      type: "step_started",
      step: { key: "read", title: "Reading again" },
    });
    const live = await t
      .withIdentity(ALICE)
      .query(api.agents.liveRunForTask, { taskId });
    expect(live?.steps).toHaveLength(1);
    expect(live?.steps[0].title).toBe("Reading again");
  });

  it("refuses to finish a step that never started", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await expect(
      t.mutation(api.agentApi.emitRunEvent, {
        apiKey: key,
        runId,
        type: "step_finished",
        step: { key: "phantom" },
      }),
    ).rejects.toThrow(/start it first/);
  });
});

describe("who may write", () => {
  it("answers 'not found' for another agent's run", async () => {
    const { t, taskId, key, makeAgent } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    const otherKey = "cua_test_key_intruder";
    await makeAgent("Eve", otherKey);
    await expect(
      t.mutation(api.agentApi.emitRunEvent, {
        apiKey: otherKey,
        runId,
        type: "narration",
        text: "I am not your agent",
      }),
    ).rejects.toThrow(/Run not found/);
  });

  it("refuses events after the run has finished", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await t.mutation(api.agentApi.finishRun, {
      apiKey: key,
      runId,
      status: "succeeded",
      summary: "done",
    });
    await expect(
      t.mutation(api.agentApi.emitRunEvent, {
        apiKey: key,
        runId,
        type: "narration",
        text: "one more thing",
      }),
    ).rejects.toThrow(/finished/);
  });
});

describe("who may watch", () => {
  it("shows the live run to a member and nothing to an outsider", async () => {
    const { t, taskId, key } = await seed();
    await startTaskRun(t, key, taskId);
    expect(
      await t.withIdentity(ALICE).query(api.agents.liveRunForTask, { taskId }),
    ).not.toBeNull();
    // The title and narration of a run are workspace-internal reasoning.
    expect(
      await t
        .withIdentity(OUTSIDER)
        .query(api.agents.liveRunForTask, { taskId }),
    ).toBeNull();
  });

  it("goes dark the moment the run finishes", async () => {
    const { t, taskId, key } = await seed();
    const runId = await startTaskRun(t, key, taskId);
    await t.mutation(api.agentApi.finishRun, {
      apiKey: key,
      runId,
      status: "succeeded",
      summary: "done",
    });
    expect(
      await t.withIdentity(ALICE).query(api.agents.liveRunForTask, { taskId }),
    ).toBeNull();
  });
});
