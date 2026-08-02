import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  deadBand as pureDeadBand,
  describeSituation as pureDescribe,
  isSituationTrue as pureIsTrue,
  normalizeSituation as pureNormalize,
  COMPARISONS,
  type Comparison,
} from "../src/lib/situation";
import {
  deadBand,
  describeSituation,
  isSituationTrue,
  normalizeSituation,
  situationRefusal,
} from "../convex/_situations";

// Situations, end to end.
//
// The arithmetic is proven in `situation.test.ts`. What can only be proven here
// is everything the arithmetic assumes and cannot enforce:
//
//   - that the dead band survives being written to a table and read back on the
//     next poll, because a cron recomputing from `false` every tick has no
//     hysteresis whatever the pure function says;
//   - that a measurement nobody is allowed to take reads as false rather than
//     as zero, since zero satisfies `at_most` permanently;
//   - that a query whose filters the resolver would ignore is refused instead
//     of measured against the wrong records;
//   - and that a transition never touches a layout.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };

const SCREEN = "project:situations";
const PANEL = "custom:sprint-heat";

/** Open tasks in the scope — what almost every real situation measures. */
const OPEN_TASKS = { from: "tasks", filter: { status: "open" }, measure: "count" };

function situation(over: Record<string, unknown> = {}) {
  return {
    id: "open-tasks",
    label: "Open tasks",
    query: OPEN_TASKS,
    compare: "at_least",
    threshold: 6,
    ...over,
  };
}

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
    // Alice is a member rather than the owner, deliberately: a workspace owner
    // can see inside every private space, which would hide the visibility bug
    // the "measures only what its owner can see" case is looking for.
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: "user_root",
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: id,
      role: "member",
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

type State = Awaited<ReturnType<typeof seed>>;

async function addTasks(alice: State["alice"], listId: Id<"lists">, n: number) {
  const ids: Id<"tasks">[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(await alice.mutation(api.tasks.create, { listId, title: `Task ${i}` }));
  }
  return ids;
}

/** Bring the next check forward, so a poll can be watched without waiting. */
async function ripen(t: State["t"]) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("panelSituations").collect()) {
      await ctx.db.patch(row._id, { nextCheckAt: 0 });
    }
  });
}

async function situationEvents(t: State["t"]) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("events").collect())
      .filter((e) => e.type.startsWith("situation."))
      .map((e) => ({ type: e.type, title: e.entityTitle, payload: e.payload })),
  );
}

async function stateOf(t: State["t"]) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("panelSituations").collect())[0],
  );
}

async function subscribe(state: State, over: Record<string, unknown> = {}) {
  return await state.alice.mutation(api.situations.subscribe, {
    scopeType: "workspace",
    scopeId: state.workspaceId,
    screenKey: SCREEN,
    panelId: PANEL,
    situation: situation(over),
  });
}

describe("a condition is measured, then remembered", () => {
  it("answers the moment it is subscribed to", async () => {
    // A condition already true when you point a panel at it is true. Waiting a
    // quarter of an hour to say so reads as the feature not working.
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    const result = await subscribe(state);
    expect(result.isTrue).toBe(true);
    expect(result.value).toBe(6);
  });

  it("starts false when the condition is not met", async () => {
    const state = await seed();
    await addTasks(state.alice, state.listId, 2);
    const result = await subscribe(state);
    expect(result.isTrue).toBe(false);
    expect(result.value).toBe(2);
  });

  it("announces the arrival exactly once", async () => {
    // The transition is the event, not the state. A poll that finds the same
    // answer has nothing to announce, and a screen that re-announced every
    // fifteen minutes would train people to ignore it.
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    await subscribe(state);
    expect(await situationEvents(state.t)).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) {
      await ripen(state.t);
      await state.t.mutation(internal.situations.evaluateDue, {});
    }
    const events = await situationEvents(state.t);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("situation.became_true");
    // Named by its condition rather than by the panel: "Sprint panel appeared"
    // tells a reader nothing about what changed in their work.
    expect(events[0].title).toBe("Open tasks reached 6");
  });
});

describe("the dead band survives a poll cycle", () => {
  it("stays true one unit below the threshold, and leaves at two", async () => {
    // This is the property the table exists for. `wasTrue` is persisted, so the
    // second poll asks "is it still true" rather than "is it true", and a value
    // resting on its threshold does not flap once every fifteen minutes.
    const state = await seed();
    const tasks = await addTasks(state.alice, state.listId, 6);
    expect((await subscribe(state)).isTrue).toBe(true);

    await state.alice.mutation(api.tasks.toggleComplete, { taskId: tasks[0] });
    await ripen(state.t);
    await state.t.mutation(internal.situations.evaluateDue, {});
    const held = await stateOf(state.t);
    expect(held.lastValue).toBe(5);
    expect(held.wasTrue).toBe(true);

    await state.alice.mutation(api.tasks.toggleComplete, { taskId: tasks[1] });
    await ripen(state.t);
    await state.t.mutation(internal.situations.evaluateDue, {});
    const left = await stateOf(state.t);
    expect(left.lastValue).toBe(4);
    expect(left.wasTrue).toBe(false);

    const events = await situationEvents(state.t);
    expect(events.map((e) => e.type)).toEqual([
      "situation.became_true",
      "situation.became_false",
    ]);
  });

  it("takes one transition while a value oscillates across the threshold", async () => {
    // The same property as the pure flap test, driven through real tasks and
    // real polls: six open, one closes, one opens, one closes.
    const state = await seed();
    const tasks = await addTasks(state.alice, state.listId, 6);
    await subscribe(state);

    for (let i = 0; i < 3; i += 1) {
      await state.alice.mutation(api.tasks.toggleComplete, { taskId: tasks[0] });
      await ripen(state.t);
      await state.t.mutation(internal.situations.evaluateDue, {});
    }
    expect((await stateOf(state.t)).wasTrue).toBe(true);
    expect(await situationEvents(state.t)).toHaveLength(1);
  });

  it("forgets the old verdict when the condition itself changes", async () => {
    // A remembered `true` belongs to the threshold it was measured against.
    // Carrying it onto a new one would apply the old condition's band to the
    // new condition's number.
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    await subscribe(state);
    const again = await subscribe(state, { threshold: 20 });
    expect(again.isTrue).toBe(false);
    const rows = await state.t.run(async (ctx) =>
      ctx.db.query("panelSituations").collect(),
    );
    // Replaced, not duplicated: a panel with two conditions has no answer to
    // "is it here".
    expect(rows).toHaveLength(1);
  });
});

describe("a measurement nobody can take is not a measurement", () => {
  it("goes false when the owner loses the scope, rather than reading zero", async () => {
    // `at_most` is the dangerous comparison: an unreadable number that fell
    // through as zero would make the panel arrive at the exact moment the
    // system stopped being able to say anything about it.
    const state = await seed();
    const result = await subscribe(state, { compare: "at_most", threshold: 2 });
    expect(result.isTrue).toBe(true);

    await state.t.run(async (ctx) => {
      for (const m of await ctx.db.query("memberships").collect()) {
        await ctx.db.delete(m._id);
      }
    });
    await ripen(state.t);
    await state.t.mutation(internal.situations.evaluateDue, {});

    const row = await stateOf(state.t);
    expect(row.wasTrue).toBe(false);
    expect(row.lastValue).toBeUndefined();
  });

  it("never turns true on a row whose condition no longer parses", async () => {
    // A row written by another build must not be repaired into something that
    // fires. It is skipped — and still leaves the sweep's range, so one broken
    // subscription cannot starve the ones behind it.
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    await subscribe(state);
    await state.t.run(async (ctx) => {
      const row = (await ctx.db.query("panelSituations").collect())[0];
      await ctx.db.patch(row._id, {
        situation: { id: "x", label: "x", compare: "roughly", threshold: 6 },
        wasTrue: false,
        nextCheckAt: 0,
      });
    });
    await state.t.mutation(internal.situations.evaluateDue, {});
    const row = await stateOf(state.t);
    expect(row.wasTrue).toBe(false);
    expect(row.nextCheckAt).toBeGreaterThan(Date.now());
  });

  it("hides an unparseable subscription from the screen entirely", async () => {
    const state = await seed();
    await subscribe(state);
    await state.t.run(async (ctx) => {
      const row = (await ctx.db.query("panelSituations").collect())[0];
      await ctx.db.patch(row._id, { situation: { nonsense: true } });
    });
    expect(
      await state.alice.query(api.situations.forScreen, { screenKey: SCREEN }),
    ).toEqual([]);
  });
});

describe("access is checked on the way in and on the way out", () => {
  it("refuses a scope the subscriber is not in", async () => {
    const state = await seed();
    await expect(
      state.t.withIdentity(OUTSIDER).mutation(api.situations.subscribe, {
        scopeType: "workspace",
        scopeId: state.workspaceId,
        screenKey: SCREEN,
        panelId: PANEL,
        situation: situation(),
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("refuses somebody else's personal scope", async () => {
    const state = await seed();
    await expect(
      state.t.withIdentity(OUTSIDER).mutation(api.situations.subscribe, {
        scopeType: "user",
        scopeId: ALICE.subject,
        screenKey: SCREEN,
        panelId: PANEL,
        situation: situation(),
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("shows a subscription only to the person who made it", async () => {
    const state = await seed();
    await subscribe(state);
    expect(
      await state.t
        .withIdentity(OUTSIDER)
        .query(api.situations.forScreen, { screenKey: SCREEN }),
    ).toEqual([]);
    expect(
      await state.alice.query(api.situations.forScreen, { screenKey: SCREEN }),
    ).toHaveLength(1);
  });

  it("will not let anyone else cancel it", async () => {
    const state = await seed();
    const { subscriptionId } = await subscribe(state);
    await expect(
      state.t
        .withIdentity(OUTSIDER)
        .mutation(api.situations.unsubscribe, { subscriptionId }),
    ).rejects.toThrow(/not found/i);
    await state.alice.mutation(api.situations.unsubscribe, { subscriptionId });
    expect(await stateOf(state.t)).toBeFalsy();
  });

  it("measures only what its owner can see", async () => {
    // A private space the owner is not in must not contribute to the number,
    // or a condition becomes a way to count work behind a boundary.
    const state = await seed();
    const bob = { subject: "user_bob" };
    await state.t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: bob.subject,
        email: "bob@example.com",
        name: "Bob",
      });
      await ctx.db.insert("memberships", {
        userClerkId: bob.subject,
        workspaceId: state.workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const bobT = state.t.withIdentity(bob);
    const secret = await bobT.mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: state.workspaceId,
    });
    await bobT.mutation(api.spaces.updateMeta, { spaceId: secret, private: true });
    const secretList = await bobT.mutation(api.lists.create, {
      parentType: "space",
      parentId: secret,
      name: "Hidden",
    });
    await addTasks(bobT, secretList, 9);
    await addTasks(state.alice, state.listId, 2);

    const result = await subscribe(state, { threshold: 3 });
    // Two, not eleven.
    expect(result.value).toBe(2);
    expect(result.isTrue).toBe(false);
  });
});

describe("a filter the source ignores is refused, not evaluated", () => {
  // The failure this whole block exists to prevent: a situation carrying a
  // narrowing its source does not apply would be measured across everything and
  // announce a condition that is not true of the thing it names.

  it("accepts a task situation narrowed to a list", async () => {
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    const result = await subscribe(state, {
      query: {
        ...OPEN_TASKS,
        filter: { status: "open", scopeToKind: "list", scopeToId: state.listId },
      },
    });
    expect(result.value).toBe(6);
  });

  it("refuses a task situation narrowed to a space", async () => {
    // In the vocabulary, accepted by `normalizeQuery`, and silently dropped by
    // the list walk — which branches on "list" and "project" only.
    const state = await seed();
    await expect(
      subscribe(state, {
        query: {
          ...OPEN_TASKS,
          filter: {
            status: "open",
            scopeToKind: "space",
            scopeToId: state.spaceId,
          },
        },
      }),
    ).rejects.toThrow(/ignored when tasks are counted/i);
  });

  it("refuses a narrowing on any other source at all", async () => {
    const state = await seed();
    await expect(
      subscribe(state, {
        query: {
          from: "pages",
          measure: "count",
          filter: { scopeToKind: "list", scopeToId: state.listId },
        },
      }),
    ).rejects.toThrow(/narrowed to/i);
  });

  it("refuses a malformed condition outright", async () => {
    const state = await seed();
    await expect(subscribe(state, { compare: "roughly" })).rejects.toThrow(
      /missing something/i,
    );
    await expect(subscribe(state, { label: "  " })).rejects.toThrow(
      /missing something/i,
    );
  });

  it("names, per source, exactly what the resolver applies", () => {
    // Read off `convex/dataStream.ts` rather than off the vocabulary: `tasks`
    // is answered by `taskMatches` and applies everything; every other source
    // is answered by `resolveOther`, which applies two or three filters by hand
    // and ignores the rest in silence.
    const ok = (query: unknown, scope: "user" | "workspace" = "workspace") =>
      situationRefusal(query, scope);

    // Tasks honour the lot.
    expect(
      ok({
        from: "tasks",
        filter: {
          status: "complete",
          priority: ["urgent"],
          assignee: "me",
          due: "overdue",
          window: "7d",
          blocked: true,
          needsApproval: true,
          search: "migration",
          scopeToKind: "project",
          scopeToId: "abc123",
        },
      }),
    ).toBeNull();

    // Pages: window and search, nothing else.
    expect(ok({ from: "pages", filter: { window: "30d", search: "spec" } })).toBeNull();
    expect(ok({ from: "pages", filter: { status: "complete" } })).toMatch(/status/);
    expect(ok({ from: "pages", filter: { assignee: "me" } })).toMatch(/assignee/);

    // Agents: search only — not even a window.
    expect(ok({ from: "agents", filter: { search: "ada" } })).toBeNull();
    expect(ok({ from: "agents", filter: { window: "7d" } })).toMatch(/time window/);

    // Activity: window and search.
    expect(ok({ from: "activity", filter: { window: "7d", search: "ada" } })).toBeNull();
    expect(ok({ from: "activity", filter: { due: "overdue" } })).toMatch(/due date/);

    // Time: window only. Its branch never looks at `search`.
    expect(ok({ from: "time", measure: "time_logged", filter: { window: "7d" } })).toBeNull();
    expect(
      ok({ from: "time", measure: "time_logged", filter: { search: "x" } }),
    ).toMatch(/search text/);

    // Goals and sprints: search, and only inside a workspace.
    expect(ok({ from: "goals", filter: { search: "q3" } })).toBeNull();
    expect(ok({ from: "sprints", filter: { search: "s1" } })).toBeNull();
    expect(ok({ from: "sprints" }, "user")).toMatch(/team workspace/);
    expect(ok({ from: "goals" }, "user")).toMatch(/team workspace/);
  });

  it("treats the normalizer's own default as nothing said", () => {
    // `DEFAULT_QUERY` stamps `status: "open"` onto every query whatever the
    // source, so refusing it would refuse the feature for five of the seven
    // sources. A status somebody picked is still refused.
    expect(situationRefusal({ from: "pages", filter: { status: "open" } }, "workspace"))
      .toBeNull();
    expect(situationRefusal({ from: "pages", filter: { status: "closed" } }, "workspace"))
      .toMatch(/status/);
  });

  it("refuses a measure the resolver answers with a count under another name", () => {
    // `scalar` for most `resolveOther` branches is the match count whatever the
    // measure says, so a threshold would be compared against the wrong number —
    // which is not a smaller error than the wrong filter.
    expect(
      situationRefusal({ from: "sprints", measure: "completion_rate" }, "workspace"),
    ).toMatch(/isn't computed/);
    expect(situationRefusal({ from: "agents", measure: "spend" }, "workspace")).toMatch(
      /isn't computed/,
    );
    expect(situationRefusal({ from: "tasks", measure: "spend" }, "workspace")).toMatch(
      /isn't computed/,
    );
    expect(
      situationRefusal({ from: "goals", measure: "completion_rate" }, "workspace"),
    ).toBeNull();
    expect(
      situationRefusal({ from: "time", measure: "time_logged" }, "workspace"),
    ).toBeNull();
  });

  it("refuses a source it cannot measure at all", () => {
    // An unknown source resolves to the empty envelope, so its scalar is zero
    // forever — and zero satisfies `at_most` permanently. A situation that is
    // true because nothing could be read is the worst shape this can take.
    expect(situationRefusal({ from: "invoices" }, "workspace")).toMatch(/not something/);
  });

  it("refuses a field measure with no field named", () => {
    expect(
      situationRefusal({ from: "tasks", measure: "custom_field_sum" }, "workspace"),
    ).toMatch(/needs a field/);
    expect(
      situationRefusal(
        { from: "tasks", measure: "custom_field_sum", measureFieldId: "f1" },
        "workspace",
      ),
    ).toBeNull();
  });
});

describe("evaluation records a condition; it does not rearrange anything", () => {
  it("writes no layout when a situation becomes true", async () => {
    // Whether a panel arrives is a consent decision made elsewhere, per person.
    // If this ever writes a layout row, the feature has become the adaptive UI
    // the whole codebase is built to refuse.
    const state = await seed();
    await addTasks(state.alice, state.listId, 6);
    await subscribe(state);
    await ripen(state.t);
    await state.t.mutation(internal.situations.evaluateDue, {});

    const layouts = await state.t.run(async (ctx) =>
      ctx.db.query("screenLayouts").collect(),
    );
    expect(layouts).toEqual([]);
  });
});

describe("the sweep is bounded and leaves nothing due", () => {
  it("moves every row it touches out of the range", async () => {
    const state = await seed();
    await subscribe(state);
    await ripen(state.t);
    const { checked } = await state.t.mutation(internal.situations.evaluateDue, {});
    expect(checked).toBe(1);
    const again = await state.t.mutation(internal.situations.evaluateDue, {});
    expect(again.checked).toBe(0);
  });
});

describe("the two copies of the rule agree", () => {
  it("compares the same way on both sides of the wire", () => {
    // The Convex tree cannot import from `src/`, so the arithmetic is written
    // twice. This is the only thing standing between the copies, and it is
    // cheaper than the bug.
    for (const compare of COMPARISONS as readonly Comparison[]) {
      for (const threshold of [0, 1, 3, 6, 100, NaN]) {
        for (const value of [-1, 0, 1, 2, 4, 5, 5.5, 6, 7, 90, 99, 100, NaN]) {
          for (const wasTrue of [false, true]) {
            const s = { id: "s", label: "L", query: {}, compare, threshold };
            const label = `${compare} t=${threshold} v=${value} was=${wasTrue}`;
            expect(isSituationTrue(s, value, wasTrue), label).toBe(
              pureIsTrue(s as never, value, wasTrue),
            );
          }
        }
      }
    }
  });

  it("bands and phrases the same way", () => {
    for (const threshold of [0, 1, 3, 6, 100, -4, NaN]) {
      expect(deadBand(threshold)).toBe(pureDeadBand(threshold));
    }
    for (const compare of COMPARISONS as readonly Comparison[]) {
      const s = { id: "s", label: "Open tasks", query: {}, compare, threshold: 6 };
      expect(describeSituation(s)).toBe(pureDescribe(s as never));
    }
  });

  it("accepts and refuses the same inputs", () => {
    const ok = {
      id: "a",
      label: "Open",
      query: {},
      compare: "at_least",
      threshold: 3,
    };
    const cases: unknown[] = [
      ok,
      null,
      undefined,
      42,
      "sprint",
      { ...ok, id: "" },
      { ...ok, label: "   " },
      { ...ok, compare: "roughly" },
      { ...ok, threshold: "six" },
      { ...ok, threshold: NaN },
      { ...ok, query: undefined },
      { ...ok, query: "tasks" },
      { ...ok, id: "x".repeat(500), label: "y".repeat(500) },
    ];
    for (const input of cases) {
      const mine = normalizeSituation(input);
      const theirs = pureNormalize(input);
      expect(mine === null, JSON.stringify(input)).toBe(theirs === null);
      if (mine && theirs) {
        expect(mine.id).toBe(theirs.id);
        expect(mine.label).toBe(theirs.label);
        expect(mine.compare).toBe(theirs.compare);
        expect(mine.threshold).toBe(theirs.threshold);
      }
    }
  });
});
