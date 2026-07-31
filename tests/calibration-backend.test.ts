import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { evaluate, normalizeExpectation, DIRECTIONS } from "../src/lib/calibration";
import { held } from "../convex/calibration";
import { sha256Hex } from "../convex/_agentAuth";

// Calibration, end to end.
//
// The pure model is tested in `calibration.test.ts`. What can only be tested
// here is the thing that makes the whole feature honest: **the baseline is
// measured by the server, at attach time, from real data.** A client-supplied
// baseline is a claim about the past nobody can check, and the abuse is
// trivial — say the number was worse than it was and every decision is a win.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };

const HOUR = 3_600_000;

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject === ALICE.subject ? "Alice" : "Nemo",
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
  const projectId = await alice.mutation(api.projects.create, {
    spaceId,
    name: "Launch",
  });
  const listId = await alice.mutation(api.lists.create, {
    parentType: "project",
    parentId: projectId,
    name: "Work",
  });
  return { t, alice, workspaceId, spaceId, projectId, listId };
}

/** Open tasks, so `measure` has something real to count. */
async function addTasks(
  alice: Awaited<ReturnType<typeof seed>>["alice"],
  listId: Id<"lists">,
  n: number,
) {
  const ids: Id<"tasks">[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(
      await alice.mutation(api.tasks.create, { listId, title: `Task ${i}` }),
    );
  }
  return ids;
}

/** A settled decision to hang a claim on. */
async function decide(state: Awaited<ReturnType<typeof seed>>) {
  const questionId = await state.alice.mutation(api.plans.ask, {
    projectId: state.projectId,
    body: "Do we cut scope?",
  });
  const optionId = await state.alice.mutation(api.plans.addOption, {
    questionId,
    body: "Yes, drop the import",
  });
  const { nodeId } = await state.alice.mutation(api.plans.decide, {
    questionId,
    chosenOptionId: optionId,
    body: "Dropping it",
  });
  return { questionId, optionId, decisionId: nodeId };
}

const OPEN_TASKS = { from: "tasks", filter: { status: "open" }, measure: "count" };

describe("the baseline is measured, not supplied", () => {
  it("reads the real number at the moment the claim is made", async () => {
    const state = await seed();
    await addTasks(state.alice, state.listId, 3);
    const { decisionId } = await decide(state);

    const { baseline } = await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    expect(baseline).toBe(3);
  });

  it("takes no baseline from the caller at all", async () => {
    // There is no argument for one, and the validator refuses to be handed
    // one — so the obvious abuse (claim the number was worse than it was, and
    // every decision becomes a win) has nowhere to enter.
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);
    const { decisionId } = await decide(state);
    await expect(
      state.alice.mutation(api.calibration.attach, {
        decisionId,
        query: OPEN_TASKS,
        direction: "down",
        dueAt: Date.now() + HOUR,
        baseline: 999,
      } as never),
    ).rejects.toThrow(/baseline/i);
  });

  it("refuses a second claim on the same decision", async () => {
    // Re-baselining compares the world to itself, so the claim could never be
    // wrong again.
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);
    const { decisionId } = await decide(state);
    const args = {
      decisionId,
      query: OPEN_TASKS,
      direction: "down" as const,
      dueAt: Date.now() + HOUR,
    };
    await state.alice.mutation(api.calibration.attach, args);
    await expect(
      state.alice.mutation(api.calibration.attach, args),
    ).rejects.toThrow(/already has an expectation/i);
  });

  it("refuses a horizon in the past", async () => {
    const state = await seed();
    const { decisionId } = await decide(state);
    await expect(
      state.alice.mutation(api.calibration.attach, {
        decisionId,
        query: OPEN_TASKS,
        direction: "down",
        dueAt: Date.now() - HOUR,
      }),
    ).rejects.toThrow(/into the future/i);
  });

  it("refuses an outsider", async () => {
    const state = await seed();
    const { decisionId } = await decide(state);
    await expect(
      state.t.withIdentity(OUTSIDER).mutation(api.calibration.attach, {
        decisionId,
        query: OPEN_TASKS,
        direction: "down",
        dueAt: Date.now() + HOUR,
      }),
    ).rejects.toThrow();
  });
});

describe("grading", () => {
  async function claimed(direction: "down" | "up" = "down") {
    const state = await seed();
    const tasks = await addTasks(state.alice, state.listId, 4);
    const { decisionId } = await decide(state);
    await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction,
      dueAt: Date.now() + HOUR,
    });
    return { ...state, decisionId, tasks };
  }

  /** Move the horizon into the past without waiting an hour. */
  async function ripen(
    t: Awaited<ReturnType<typeof seed>>["t"],
    decisionId: Id<"planNodes">,
  ) {
    await t.run(async (ctx) => {
      const row = await ctx.db.get(decisionId);
      const e = row!.expectation as Record<string, unknown>;
      await ctx.db.patch(decisionId, {
        expectation: { ...e, dueAt: Date.now() - 1000 },
        expectationDueAt: Date.now() - 1000,
      });
    });
  }

  it("does nothing before the horizon", async () => {
    const { t, decisionId } = await claimed();
    await t.mutation(internal.calibration.gradeDue, {});
    const row = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.outcome).toBeUndefined();
  });

  it("marks it held when the number moved the claimed way", async () => {
    const { t, alice, decisionId, tasks } = await claimed("down");
    // Complete two, so open tasks drop from 4 to 2.
    for (const taskId of tasks.slice(0, 2)) {
      await alice.mutation(api.tasks.toggleComplete, { taskId });
    }
    await ripen(t, decisionId);
    await t.mutation(internal.calibration.gradeDue, {});

    const row = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.outcome?.verdict).toBe("met");
    expect(row?.outcome?.value).toBe(2);
  });

  it("marks it missed when it did not, and says so flatly", async () => {
    // The most valuable row in the system: the only place a team finds out
    // its model of its own work is wrong.
    const { t, alice, listId, decisionId } = await claimed("down");
    await addTasks(alice, listId, 2);
    await ripen(t, decisionId);
    await t.mutation(internal.calibration.gradeDue, {});

    const row = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.outcome?.verdict).toBe("missed");
    expect(row?.outcome?.value).toBe(6);
  });

  it("grades once and never again", async () => {
    // Idempotent by construction: grading clears the due stamp, so the
    // decision leaves the range.
    const { t, decisionId } = await claimed();
    await ripen(t, decisionId);
    await t.mutation(internal.calibration.gradeDue, {});
    const first = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(first?.expectationDueAt).toBeUndefined();

    await t.mutation(internal.calibration.gradeDue, {});
    const second = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(second?.outcome?.checkedAt).toBe(first?.outcome?.checkedAt);
  });

  it("does not grade a retracted decision", async () => {
    // It is out of the plan; grading it would put it back through a side door.
    const { t, alice, decisionId } = await claimed();
    await alice.mutation(api.plans.retract, { nodeId: decisionId });
    await ripen(t, decisionId);
    await t.mutation(internal.calibration.gradeDue, {});
    const row = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.outcome).toBeUndefined();
  });

  it("logs what happened to the activity feed", async () => {
    const { t, decisionId } = await claimed();
    await ripen(t, decisionId);
    await t.mutation(internal.calibration.gradeDue, {});
    const types = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect())
        .map((e) => e.type)
        .filter((tp) => tp.startsWith("question.claim")),
    );
    expect(types).toHaveLength(1);
  });
});

describe("a claim that has been checked stays on the record", () => {
  it("can be withdrawn before it is graded", async () => {
    const state = await seed();
    const { decisionId } = await decide(state);
    await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    await state.alice.mutation(api.calibration.detach, { decisionId });
    const row = await state.t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.expectation).toBeUndefined();
  });

  it("cannot be withdrawn after", async () => {
    // Deleting a graded claim is how a team quietly stops being wrong.
    const state = await seed();
    await addTasks(state.alice, state.listId, 1);
    const { decisionId } = await decide(state);
    await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    await state.t.run(async (ctx) => {
      await ctx.db.patch(decisionId, {
        expectationDueAt: Date.now() - 1000,
        expectation: {
          ...(await ctx.db.get(decisionId))!.expectation as object,
          dueAt: Date.now() - 1000,
        },
      });
    });
    await state.t.mutation(internal.calibration.gradeDue, {});
    await expect(
      state.alice.mutation(api.calibration.detach, { decisionId }),
    ).rejects.toThrow(/stays on the record/i);
  });
});

describe("reading it back across a scope", () => {
  it("returns claims with their verdicts", async () => {
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);
    const { decisionId } = await decide(state);
    await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
      note: "cutting scope should shrink the queue",
    });

    const rows = await state.alice.query(api.calibration.forScope, {
      scopeType: "workspace",
      scopeId: state.workspaceId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].question).toBe("Do we cut scope?");
    expect(rows[0].outcome).toBeNull();
    expect(
      (rows[0].expectation as { note: string }).note,
    ).toContain("shrink the queue");
  });

  it("shows an outsider nothing", async () => {
    const state = await seed();
    const { decisionId } = await decide(state);
    await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    const rows = await state.t
      .withIdentity(OUTSIDER)
      .query(api.calibration.forScope, {
        scopeType: "workspace",
        scopeId: state.workspaceId,
      });
    expect(rows).toEqual([]);
  });

  it("ignores decisions with no claim attached", async () => {
    const state = await seed();
    await decide(state);
    const rows = await state.alice.query(api.calibration.forScope, {
      scopeType: "workspace",
      scopeId: state.workspaceId,
    });
    expect(rows).toEqual([]);
  });
});

describe("the two copies of the comparison agree", () => {
  it("grades the same way on both sides of the wire", () => {
    // The Convex tree cannot import from `src/`, so `held` is written twice.
    // Two copies of a rule drift; this is the only thing standing between
    // them, and it is cheaper than the bug.
    //
    // Compared directly rather than by driving data through the resolver: a
    // matrix that has to arrange real tasks to hit each value is a test whose
    // failures are about the arranging.
    for (const direction of DIRECTIONS) {
      for (const baseline of [0, 1, 10, 100]) {
        for (const target of [0, 5, 10]) {
          for (const value of [0, 1, 5, 9, 10, 11, 100]) {
            const pure = normalizeExpectation({
              query: OPEN_TASKS,
              direction,
              target,
              baseline,
              dueAt: 1,
            })!;
            const label = `${direction} baseline=${baseline} target=${target} value=${value}`;
            expect(evaluate(pure, value, 2).verdict === "met", label).toBe(
              held({ direction, target, baseline }, value),
            );
          }
        }
      }
    }
  });
});

describe("an agent staking a claim", () => {
  async function withAgent() {
    const state = await seed();
    const key = "cua_test_calibration_agent";
    await state.t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Ada",
        parentType: "workspace",
        parentId: state.workspaceId,
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
    });
    return { ...state, key };
  }

  it("reads the baseline from real data, not from the agent", async () => {
    const state = await withAgent();
    await addTasks(state.alice, state.listId, 5);
    const { decisionId } = await decide(state);
    const { baseline } = await state.t.mutation(api.agentApi.planExpect, {
      apiKey: state.key,
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    expect(baseline).toBe(5);
  });

  it("gets graded like anybody else", async () => {
    // The point: an agent whose claims are checked has a track record, which
    // is a different and stronger signal than "I finished the task".
    const state = await withAgent();
    await addTasks(state.alice, state.listId, 3);
    const { decisionId } = await decide(state);
    await state.t.mutation(api.agentApi.planExpect, {
      apiKey: state.key,
      decisionId,
      query: OPEN_TASKS,
      direction: "up",
      dueAt: Date.now() + HOUR,
    });
    await addTasks(state.alice, state.listId, 2);
    await state.t.run(async (ctx) => {
      const row = await ctx.db.get(decisionId);
      await ctx.db.patch(decisionId, {
        expectation: {
          ...(row!.expectation as object),
          dueAt: Date.now() - 1000,
        },
        expectationDueAt: Date.now() - 1000,
      });
    });
    await state.t.mutation(internal.calibration.gradeDue, {});
    const row = await state.t.run(async (ctx) => ctx.db.get(decisionId));
    expect(row?.outcome?.verdict).toBe("met");
    expect(row?.outcome?.value).toBe(5);
  });

  it("cannot re-baseline either", async () => {
    const state = await withAgent();
    const { decisionId } = await decide(state);
    const args = {
      apiKey: state.key,
      decisionId,
      query: OPEN_TASKS,
      direction: "down" as const,
      dueAt: Date.now() + HOUR,
    };
    await state.t.mutation(api.agentApi.planExpect, args);
    await expect(
      state.t.mutation(api.agentApi.planExpect, args),
    ).rejects.toThrow(/already has an expectation/i);
  });

  it("refuses an unknown key", async () => {
    const state = await withAgent();
    const { decisionId } = await decide(state);
    await expect(
      state.t.mutation(api.agentApi.planExpect, {
        apiKey: "cua_not_a_key",
        decisionId,
        query: OPEN_TASKS,
        direction: "down",
        dueAt: Date.now() + HOUR,
      }),
    ).rejects.toThrow();
  });
});

describe("a claim is about its own project", () => {
  it("ignores work in a sibling project", async () => {
    // Measuring across the whole workspace would let the number move for
    // reasons nobody claimed anything about — and would fold in spaces the
    // claimant may not even be able to see.
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);

    const otherProject = await state.alice.mutation(api.projects.create, {
      spaceId: state.spaceId,
      name: "Unrelated",
    });
    const otherList = await state.alice.mutation(api.lists.create, {
      parentType: "project",
      parentId: otherProject,
      name: "Elsewhere",
    });
    await addTasks(state.alice, otherList, 7);

    const { decisionId } = await decide(state);
    const { baseline } = await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: OPEN_TASKS,
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    // Two, not nine.
    expect(baseline).toBe(2);
  });

  it("cannot be talked out of its own project", async () => {
    // The narrowing is forced rather than defaulted, so a query that names a
    // different project is overruled.
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);
    const otherProject = await state.alice.mutation(api.projects.create, {
      spaceId: state.spaceId,
      name: "Unrelated",
    });
    const otherList = await state.alice.mutation(api.lists.create, {
      parentType: "project",
      parentId: otherProject,
      name: "Elsewhere",
    });
    await addTasks(state.alice, otherList, 7);

    const { decisionId } = await decide(state);
    const { baseline } = await state.alice.mutation(api.calibration.attach, {
      decisionId,
      query: {
        ...OPEN_TASKS,
        filter: {
          status: "open",
          scopeToKind: "project",
          scopeToId: otherProject,
        },
      },
      direction: "down",
      dueAt: Date.now() + HOUR,
    });
    expect(baseline).toBe(2);
  });
});
