import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  blastRadius,
  flowProgress,
  neighbourhood,
  readyTasks,
  structuralStalls,
  unlockRanking,
  type GraphNode,
} from "../convex/_taskGraph";

// The task graph.
//
// Everything here is arithmetic over an edge list, which is why it is pure and
// why the tests are the specification. Two classes of property matter:
//
// The ANSWERS — that finishing the task twelve others wait on outranks
// finishing a leaf, that six tasks in a row is not the same as six side by
// side, that a chain nobody can reach is visible at all.
//
// And the SAFETY — this runs inside a query over edges an agent wrote. It must
// terminate on a cycle it is promised it will never see, must not recurse down
// a long chain, and must not invent a blocker it cannot read.

/** `a <- b` reads "b is blocked by a". */
function graph(
  spec: Record<string, { done?: boolean; blockedBy?: string[] }>,
): GraphNode[] {
  return Object.entries(spec).map(([id, n]) => ({
    id,
    done: n.done ?? false,
    blockedBy: n.blockedBy ?? [],
  }));
}

describe("what is ready", () => {
  it("is open work with nothing open in front of it", () => {
    const g = graph({
      a: {},
      b: { blockedBy: ["a"] },
      c: {},
    });
    expect(readyTasks(g).sort()).toEqual(["a", "c"]);
  });

  it("treats a done blocker as history", () => {
    const g = graph({ a: { done: true }, b: { blockedBy: ["a"] } });
    expect(readyTasks(g)).toEqual(["b"]);
  });

  it("does not invent a blocker it cannot see", () => {
    // A dependency outside the readable set is somebody else's business.
    // Treating it as open would make every cross-boundary task look stuck,
    // which is a great way to make a fleet stop working for no reason.
    const g = graph({ b: { blockedBy: ["invisible"] } });
    expect(readyTasks(g)).toEqual(["b"]);
  });
});

describe("what to do next", () => {
  it("counts everything downstream, transitively and once", () => {
    //   a → b → c
    //   a → d
    const g = graph({
      a: {},
      b: { blockedBy: ["a"] },
      c: { blockedBy: ["b"] },
      d: { blockedBy: ["a"] },
    });
    expect(blastRadius(g, "a")).toBe(3);
    expect(blastRadius(g, "b")).toBe(1);
    expect(blastRadius(g, "d")).toBe(0);
  });

  it("counts a diamond once", () => {
    const g = graph({
      a: {},
      b: { blockedBy: ["a"] },
      c: { blockedBy: ["a"] },
      d: { blockedBy: ["b", "c"] },
    });
    expect(blastRadius(g, "a")).toBe(3);
  });

  it("counts work behind a done task", () => {
    // Finishing `a` does not release `b` — `b` is already done — but `c` is
    // still behind both, and is still waiting.
    const g = graph({
      a: {},
      b: { done: true, blockedBy: ["a"] },
      c: { blockedBy: ["b"] },
    });
    expect(blastRadius(g, "a")).toBe(1);
  });

  it("still credits a task whose dependents have other blockers too", () => {
    // The tempting alternative is to count only what becomes IMMEDIATELY
    // ready. That scores the head of a long chain the same as a leaf, which is
    // exactly backwards: `a` is the thing everything is eventually waiting on.
    const g = graph({
      a: {},
      other: {},
      b: { blockedBy: ["a", "other"] },
      c: { blockedBy: ["b"] },
    });
    expect(blastRadius(g, "a")).toBe(2);
  });

  it("ranks the task most work waits on first", () => {
    const g = graph({
      leaf: {},
      head: {},
      m1: { blockedBy: ["head"] },
      m2: { blockedBy: ["m1"] },
    });
    const ranked = unlockRanking(g);
    // A dispatcher that picked fairly between `leaf` and `head` would be fair
    // and slow. This is the whole point of the module.
    expect(ranked[0].id).toBe("head");
    expect(ranked[0].unlocks).toBe(2);
    expect(ranked.map((r) => r.id)).toEqual(["head", "leaf"]);
  });

  it("breaks a tie on the longer chain behind it", () => {
    // Both release one task. The one at the head of the longer chain goes
    // first, because that chain is what will still be running at the end of
    // the day.
    const g = graph({
      shallow: {},
      s1: { blockedBy: ["shallow"] },
      deep: {},
      d1: { blockedBy: ["deep"] },
      d2: { blockedBy: ["d1"], done: true },
    });
    const ranked = unlockRanking(g).filter((r) =>
      ["shallow", "deep"].includes(r.id),
    );
    expect(ranked.map((r) => r.id)).toEqual(["deep", "shallow"]);
  });

  it("is stable rather than incidentally ordered", () => {
    const g = graph({ b: {}, a: {}, c: {} });
    expect(unlockRanking(g).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("offers nothing when nothing is ready", () => {
    const g = graph({ a: { done: true }, b: { done: true } });
    expect(unlockRanking(g)).toEqual([]);
  });
});

describe("how close it really is", () => {
  it("tells six in a row apart from six side by side", () => {
    const chain = graph({
      t1: {},
      t2: { blockedBy: ["t1"] },
      t3: { blockedBy: ["t2"] },
      t4: { blockedBy: ["t3"] },
      t5: { blockedBy: ["t4"] },
      t6: { blockedBy: ["t5"] },
    });
    const flat = graph({ t1: {}, t2: {}, t3: {}, t4: {}, t5: {}, t6: {} });

    // Identical by every count this product had before: 0 of 6.
    expect(flowProgress(chain).done).toBe(flowProgress(flat).done);
    expect(flowProgress(chain).open).toBe(flowProgress(flat).open);
    // Not identical at all in how close they are to finished.
    expect(flowProgress(chain).criticalRemaining).toBe(6);
    expect(flowProgress(flat).criticalRemaining).toBe(1);
    expect(flowProgress(flat).ready).toBe(6);
    expect(flowProgress(chain).ready).toBe(1);
  });

  it("shortens the critical path as the chain is worked", () => {
    const g = graph({
      t1: { done: true },
      t2: { blockedBy: ["t1"] },
      t3: { blockedBy: ["t2"] },
    });
    expect(flowProgress(g).criticalRemaining).toBe(2);
  });

  it("reports nothing remaining when everything is done", () => {
    const g = graph({ a: { done: true }, b: { done: true, blockedBy: ["a"] } });
    expect(flowProgress(g)).toMatchObject({
      total: 2,
      done: 2,
      open: 0,
      ready: 0,
      criticalRemaining: 0,
    });
  });
});

describe("what nobody can reach", () => {
  it("finds a ready head no one is able to pick up", () => {
    const g = graph({
      fenced: {},
      a: { blockedBy: ["fenced"] },
      b: { blockedBy: ["a"] },
      fine: {},
    });
    // Every watchdog in the product looks for work that STOPPED. This is work
    // that is present, healthy, and never going to start.
    const stalls = structuralStalls(g, (id) => id !== "fenced");
    expect(stalls).toEqual([{ id: "fenced", blocking: 2 }]);
  });

  it("reports the head, not the tail behind it", () => {
    const g = graph({
      fenced: {},
      a: { blockedBy: ["fenced"] },
      b: { blockedBy: ["a"] },
    });
    // Reporting a hundred rows for one misconfigured fence would bury the fix.
    expect(structuralStalls(g, (id) => id !== "fenced").map((s) => s.id))
      .toEqual(["fenced"]);
  });

  it("says nothing when everything ready is reachable", () => {
    const g = graph({ a: {}, b: { blockedBy: ["a"] } });
    expect(structuralStalls(g, () => true)).toEqual([]);
  });

  it("puts the most damaging fence first", () => {
    const g = graph({
      small: {},
      s1: { blockedBy: ["small"] },
      big: {},
      b1: { blockedBy: ["big"] },
      b2: { blockedBy: ["b1"] },
    });
    expect(
      structuralStalls(g, (id) => !["small", "big"].includes(id)).map(
        (s) => s.id,
      ),
    ).toEqual(["big", "small"]);
  });
});

describe("what is nearby", () => {
  it("walks both directions to a bounded depth", () => {
    const g = graph({
      up2: {},
      up1: { blockedBy: ["up2"] },
      me: { blockedBy: ["up1"] },
      down1: { blockedBy: ["me"] },
      down2: { blockedBy: ["down1"] },
      far: { blockedBy: ["down2"] },
    });
    const n = neighbourhood(g, "me", 2);
    // Upstream is why you cannot start; downstream is who you are holding up.
    // Both matter, for different reasons.
    expect(n.upstream.sort()).toEqual(["up1", "up2"]);
    expect(n.downstream.sort()).toEqual(["down1", "down2"]);
    expect(n.downstream).not.toContain("far");
  });

  it("never includes the task itself", () => {
    const g = graph({ a: {}, b: { blockedBy: ["a"] }, c: { blockedBy: ["b"] } });
    const n = neighbourhood(g, "b", 5);
    expect(n.upstream).not.toContain("b");
    expect(n.downstream).not.toContain("b");
  });

  it("drops edges to tasks outside the readable set", () => {
    const g = graph({ me: { blockedBy: ["invisible"] } });
    expect(neighbourhood(g, "me", 2).upstream).toEqual([]);
  });
});

describe("safety on input it was promised it would never get", () => {
  // Cycles are refused on write. That is a promise about one code path, and
  // this module runs over rows agents authored — a bound that exists only in
  // the shape of the input is not a bound.
  const cyclic = graph({
    a: { blockedBy: ["c"] },
    b: { blockedBy: ["a"] },
    c: { blockedBy: ["b"] },
  });

  it("terminates on a cycle", () => {
    expect(readyTasks(cyclic)).toEqual([]);
    expect(blastRadius(cyclic, "a")).toBe(2);
    expect(() => flowProgress(cyclic)).not.toThrow();
    expect(() => unlockRanking(cyclic)).not.toThrow();
    expect(() => neighbourhood(cyclic, "a", 10)).not.toThrow();
  });

  it("does not blow the stack on a long chain", () => {
    // Recursive descent over five thousand links is a crash inside a query,
    // and "our chains are short" is a hope rather than a guarantee.
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 5_000; i++) {
      nodes.push({
        id: `t${i}`,
        done: false,
        blockedBy: i === 0 ? [] : [`t${i - 1}`],
      });
    }
    expect(() => flowProgress(nodes)).not.toThrow();
    expect(readyTasks(nodes)).toEqual(["t0"]);
  });

  it("handles an empty graph", () => {
    expect(readyTasks([])).toEqual([]);
    expect(unlockRanking([])).toEqual([]);
    expect(flowProgress([])).toMatchObject({ total: 0, criticalRemaining: 0 });
    expect(neighbourhood([], "nope", 2)).toEqual({
      upstream: [],
      downstream: [],
    });
  });

  it("tolerates a task blocked by itself", () => {
    const g = graph({ a: { blockedBy: ["a"] } });
    expect(readyTasks(g)).toEqual([]);
    expect(() => unlockRanking(g)).not.toThrow();
  });
});

// ── The graph, in the product ──

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

describe("the dispatcher, made effective", () => {
  it("offers the task the most work is waiting on", async () => {
    const { t, alice, listId, apiKey } = await setup();
    // A leaf created FIRST, so date ordering would have picked it — which is
    // exactly what the fair-but-slow dispatcher did.
    await alice.mutation(api.tasks.create, { listId, title: "A leaf" });
    const head = await alice.mutation(api.tasks.create, {
      listId,
      title: "The head",
    });
    const mid = await alice.mutation(api.tasks.create, {
      listId,
      title: "Middle",
    });
    const tail = await alice.mutation(api.tasks.create, {
      listId,
      title: "Tail",
    });
    await alice.mutation(api.tasks.update, {
      taskId: mid,
      blockedByTaskIds: [head],
    });
    await alice.mutation(api.tasks.update, {
      taskId: tail,
      blockedByTaskIds: [mid],
    });

    const dispatch = await t.query(api.agentApi.nextTask, { apiKey, limit: 1 });
    expect(dispatch.tasks[0].title).toBe("The head");
  });

  it("does not overrule a human who marked something urgent", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const urgent = await alice.mutation(api.tasks.create, {
      listId,
      title: "Urgent leaf",
      priority: "urgent",
    });
    const head = await alice.mutation(api.tasks.create, {
      listId,
      title: "Structural head",
    });
    const mid = await alice.mutation(api.tasks.create, {
      listId,
      title: "Middle",
    });
    const tail = await alice.mutation(api.tasks.create, {
      listId,
      title: "Tail",
    });
    await alice.mutation(api.tasks.update, {
      taskId: mid,
      blockedByTaskIds: [head],
    });
    await alice.mutation(api.tasks.update, {
      taskId: tail,
      blockedByTaskIds: [mid],
    });

    // A person marking something urgent is making a claim about the world the
    // dependency graph cannot see. A structural number overruling it would be
    // the machine deciding it knows better.
    const dispatch = await t.query(api.agentApi.nextTask, { apiKey, limit: 1 });
    expect(dispatch.tasks[0].taskId).toBe(urgent);
  });
});

describe("the graph query", () => {
  it("answers all four questions for a list", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const head = await alice.mutation(api.tasks.create, {
      listId,
      title: "Head",
    });
    const mid = await alice.mutation(api.tasks.create, {
      listId,
      title: "Middle",
    });
    const tail = await alice.mutation(api.tasks.create, {
      listId,
      title: "Tail",
    });
    await alice.mutation(api.tasks.update, {
      taskId: mid,
      blockedByTaskIds: [head],
    });
    await alice.mutation(api.tasks.update, {
      taskId: tail,
      blockedByTaskIds: [mid],
    });

    const g = await t.query(api.agentApi.getTaskGraph, {
      apiKey,
      listId,
      aroundTaskId: mid,
    });

    expect(g.progress).toMatchObject({
      total: 3,
      done: 0,
      ready: 1,
      criticalRemaining: 3,
    });
    expect(g.nextBest[0]).toMatchObject({ title: "Head", unlocks: 2 });
    expect(g.unreachable).toEqual([]);
    expect(g.around?.upstream.map((u) => u.taskId)).toEqual([head]);
    expect(g.around?.downstream.map((d) => d.taskId)).toEqual([tail]);
  });

  it("refuses a list the agent cannot reach", async () => {
    const { t, listId } = await setup();
    const outsiderKey = "cua_test_key_outsider";
    await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        name: "Stranger",
        parentType: "user",
        parentId: "user_bob",
        status: "active",
        createdByClerkId: "user_bob",
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(outsiderKey),
        keyPrefix: outsiderKey.slice(0, 12),
        createdAt: Date.now(),
      });
    });
    await expect(
      t.query(api.agentApi.getTaskGraph, { apiKey: outsiderKey, listId }),
    ).rejects.toThrow();
  });
});
