import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  NEVER_TRIMMED,
  SECTION_ORDER,
  describeOmissions,
  estimateTokens,
  trimToBudget,
  type ContextSection,
} from "../convex/_taskContext";

// One-call task context.
//
// The round trip saved is the small half. The half worth testing is the two
// judgements this module makes on every runtime's behalf: what order to read
// things in, and what to drop when there is too much — and, above all, that
// what was dropped is NAMED. An agent handed a silently truncated context
// believes it has the whole picture and acts with unearned confidence, which
// is strictly worse than having no budget at all.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };

function section(
  key: ContextSection["key"],
  items: { id: string; tokens: number }[],
): ContextSection {
  return {
    key,
    items: items.map((i) => ({
      id: i.id,
      label: key,
      tokens: i.tokens,
      value: { id: i.id },
    })),
  };
}

const ids = (r: ReturnType<typeof trimToBudget>, key: string) =>
  r.sections.find((s) => s.key === key)?.items.map((i) => i.id) ?? [];

describe("the order", () => {
  it("ranks by what it costs to have missed it", () => {
    // Not by size, and not by how interesting each looks. Working unready, or
    // redoing work somebody already asked you to change, is worse than
    // repeating something a previous run tried.
    expect(SECTION_ORDER).toEqual([
      "readiness",
      "revisions",
      "decisions",
      "packets",
      "outcomes",
    ]);
  });

  it("comes back in that order even when a section is empty", () => {
    const r = trimToBudget([section("packets", [{ id: "p", tokens: 1 }])]);
    expect(r.sections.map((s) => s.key)).toEqual(SECTION_ORDER);
  });
});

describe("the budget", () => {
  it("returns everything when there is no budget", () => {
    const r = trimToBudget([
      section("decisions", [{ id: "d", tokens: 500 }]),
      section("packets", [{ id: "p", tokens: 9000 }]),
    ]);
    expect(r.omitted).toEqual([]);
    expect(r.tokens).toBe(9500);
    // A runtime that has not thought about its budget gets the complete
    // answer, not one this module guessed at.
    expect(ids(r, "packets")).toEqual(["p"]);
  });

  it("trims from the bottom of the relevance order", () => {
    const r = trimToBudget(
      [
        section("readiness", [{ id: "r", tokens: 10 }]),
        section("decisions", [{ id: "d", tokens: 40 }]),
        section("packets", [{ id: "p", tokens: 40 }]),
        section("outcomes", [{ id: "o", tokens: 40 }]),
      ],
      100,
    );
    expect(ids(r, "decisions")).toEqual(["d"]);
    expect(ids(r, "packets")).toEqual(["p"]);
    expect(ids(r, "outcomes")).toEqual([]);
    expect(r.omitted.map((o) => o.section)).toEqual(["outcomes"]);
  });

  it("keeps part of a section rather than none of it", () => {
    // Three of eight decisions plus a note saying five were dropped beats zero
    // decisions, and beats eight that blew the budget.
    const r = trimToBudget(
      [section("decisions", [1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, tokens: 30 })))],
      100,
    );
    expect(ids(r, "decisions")).toEqual(["d1", "d2", "d3"]);
    expect(r.omitted[0]).toMatchObject({
      section: "decisions",
      count: 2,
      tokens: 60,
      ids: ["d4", "d5"],
    });
  });

  it("does not squeeze a small item in after a big one was dropped", () => {
    // Taking whatever happens to fit would make the answer depend on item
    // order in a way nobody asked for, and quietly re-rank relevance by size.
    const r = trimToBudget(
      [
        section("packets", [
          { id: "big", tokens: 90 },
          { id: "huge", tokens: 500 },
          { id: "tiny", tokens: 1 },
        ]),
      ],
      100,
    );
    expect(ids(r, "packets")).toEqual(["big"]);
    expect(r.omitted[0].ids).toEqual(["huge", "tiny"]);
  });

  it("never trims readiness or open revisions", () => {
    const r = trimToBudget(
      [
        section("readiness", [{ id: "r", tokens: 400 }]),
        section("revisions", [{ id: "v", tokens: 400 }]),
        section("packets", [{ id: "p", tokens: 10 }]),
      ],
      50,
    );
    expect(ids(r, "readiness")).toEqual(["r"]);
    expect(ids(r, "revisions")).toEqual(["v"]);
    // Answering a question about safety by omitting the safety information
    // would be the wrong way to honour a number.
    expect(r.overBudget).toBe(true);
    expect(NEVER_TRIMMED).toEqual(["readiness", "revisions"]);
  });

  it("names what it dropped, with ids", () => {
    const r = trimToBudget(
      [section("packets", [{ id: "p1", tokens: 500 }])],
      10,
    );
    const notice = describeOmissions(r.omitted, r.overBudget);
    expect(notice).toContain("1 packets");
    expect(notice).toContain("omitted");
    expect(r.omitted[0].ids).toEqual(["p1"]);
  });

  it("says nothing at all when nothing was dropped", () => {
    // "Nothing was omitted" on every response teaches its reader to skip the
    // field, which is exactly when it matters that they do not.
    expect(describeOmissions([], false)).toBeNull();
  });

  it("estimates tokens from length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

// ── End to end ──

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

describe("one call", () => {
  it("gathers every source and hands back a ready acknowledgement", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship it",
    });
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "The brief",
      content: "Everything you need to know about shipping it.",
    });
    await alice.mutation(api.contextPackets.attach, { taskId, packetId });

    const ctxView = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
    });

    expect(ctxView.order).toEqual(SECTION_ORDER);
    expect(ctxView.contextPackets).toHaveLength(1);
    // Unread, so not ready — the verdict is the first thing in the answer for
    // exactly this reason.
    expect(ctxView.readiness.ready).toBe(false);

    // The argument for the follow-up call, built rather than assembled by hand
    // from four responses. Getting it wrong means claiming to have read a
    // version you have not.
    expect(ctxView.acknowledge).toEqual([{ packetId, version: 1 }]);
    await t.mutation(api.agentApi.acknowledgeTaskContext, {
      apiKey,
      taskId,
      packets: ctxView.acknowledge,
    });
    const after = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
    });
    expect(after.readiness.ready).toBe(true);
  });

  it("reports the same load the dispatcher computes", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship it",
    });
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Brief",
      content: "abcdefgh",
    });
    await alice.mutation(api.contextPackets.attach, { taskId, packetId });

    const before = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
    });
    expect(before.load.contextPacketCount).toBe(1);
    expect(before.load.contextVersionFingerprint).toHaveLength(64);

    // The fingerprint is the whole reason this number belongs to the task
    // rather than to a dispatch record: it is how a pulling agent finds out
    // its context moved under it.
    await alice.mutation(api.contextPackets.update, {
      packetId,
      content: "abcdefgh, and one more thing",
    });
    const after = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
    });
    expect(after.load.contextVersionFingerprint).not.toBe(
      before.load.contextVersionFingerprint,
    );
  });

  it("trims to a budget and says so", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship it",
    });
    const { packetId } = await alice.mutation(api.contextPackets.create, {
      listId,
      title: "Enormous brief",
      content: "x".repeat(40_000),
    });
    await alice.mutation(api.contextPackets.attach, { taskId, packetId });

    const view = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
      tokenBudget: 100,
    });
    expect(view.contextPackets).toHaveLength(0);
    expect(view.budget.omitted[0]).toMatchObject({
      section: "packets",
      count: 1,
      ids: [packetId],
    });
    expect(view.budget.notice).toContain("omitted");
    // And the acknowledgement is built from what was RETURNED, so a trimmed
    // response cannot be used to claim you read the packet that was dropped.
    expect(view.acknowledge).toEqual([]);
  });

  it("refuses a task the agent cannot reach", async () => {
    const { t, alice, listId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Alice's work",
    });
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
      t.query(api.agentApi.getTaskContext, { apiKey: outsiderKey, taskId }),
    ).rejects.toThrow();
  });
});
