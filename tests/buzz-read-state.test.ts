// Read state: the blob, the merge, the budget, and the sidebar it feeds.
//
// The suite is in two halves. The first is over the pure algebra — merge,
// budget, prune, the marker resolution — where order matters and every rule is
// asserted in both directions, because a max-merge that is accidentally
// last-writer-wins passes a one-direction test perfectly. The second half drives
// the real mutations through `convex-test`, because the properties that actually
// break in production are transactional: does a mark-as-read publish exactly one
// blob, does the superseded one go away, does a marker ever go backwards.
//
// Spec: docs/buzz-parity/01-core-comms.md §4, docs/buzz-parity/06-protocol.md §6.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { threadReferenceFrom } from "../convex/buzz/messages";
import { eventVisibleToReader } from "../convex/buzz/log";
import {
  KIND_READ_STATE,
  LOCAL_MAX_PRUNABLE_CONTEXTS,
  READ_STATE_HORIZON_SECONDS,
  READ_STATE_MAX_PLAINTEXT_BYTES,
  READ_STATE_MAX_SLOTS,
  advanceContext,
  blobBytes,
  channelContextKey,
  estimateBlobBytes,
  isIdenticalToLastPublished,
  isValidBlob,
  isValidReadStateDTag,
  maxReadAt,
  mergeContexts,
  messageContextKey,
  observedUnreadEventReadAt,
  parseReadStateEvent,
  pruneStaleContexts,
  readStateDTag,
  resolveChannelReadMarker,
  resolveObservedUnreadRootId,
  sanitizeContexts,
  splitContextsIntoBudgetedSlots,
  threadContextKey,
  trimContextsToBudget,
  type ReadContexts,
  type ReadStateBlob,
} from "../convex/buzz/readState";

// `anyApi` rather than the generated `api`, for the reason the other buzz suites
// state: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it.
const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const readState = anyApi.buzz.readState;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

afterEach(() => {
  vi.useRealTimers();
});

const BASE_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

/**
 * Pin the clock, and move it in whole seconds.
 *
 * Only `Date` is faked. Nostr `created_at` is seconds, so two messages posted in
 * one real millisecond share a timestamp — and half of §4 is about the
 * difference between "at the frontier" and "after it". Controlling the clock is
 * the only way to write those cases at all.
 */
function clockAt(offsetSeconds: number): void {
  vi.setSystemTime(BASE_MS + offsetSeconds * 1000);
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: pubkeyOf(person),
        secretKey: KEYS[person.subject],
        createdAt: Date.now(),
      });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    return { workspaceId };
  });
  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  return { t, scope };
}

type Convex = ReturnType<typeof convexTest>;

async function createRoom(t: Convex, scope: Scope, name: string): Promise<string> {
  const created = (await t
    .withIdentity(ALICE)
    .mutation(channels.create, { ...scope, name })) as { channelId: string };
  await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId: created.channelId });
  return created.channelId;
}

async function post(
  t: Convex,
  scope: Scope,
  channelId: string,
  as: { subject: string },
  body: string,
  parentId?: string,
): Promise<{ eventId: string; createdAt: number }> {
  return (await t.withIdentity(as).mutation(messages.post, {
    ...scope,
    channelId,
    body,
    ...(parentId ? { parentId } : {}),
  })) as { eventId: string; createdAt: number };
}

type Summary = { channelId: string; unread: number; mentions: number };

async function rail(
  t: Convex,
  scope: Scope,
  as: { subject: string },
  activeChannelId?: string,
): Promise<Map<string, Summary>> {
  const rows = (await t
    .withIdentity(as)
    .query(channels.list, {
      ...scope,
      ...(activeChannelId ? { activeChannelId } : {}),
    })) as Summary[];
  return new Map(rows.map((row: Summary) => [row.channelId, row]));
}

// `t.run` hands back a database reader over a *generic* data model, so
// `withIndex` is not typed here (the checked-in `_generated` stub predates
// `convex/buzz/*`). Collecting and filtering is the shape the other buzz suites
// use, and the tables are three rows deep in a test.
async function readStateRow(t: Convex, scope: Scope, person: { subject: string }) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("buzzReadState").collect();
    return (
      rows.find(
        (row: { scopeId: string; pubkey: string }) =>
          row.scopeId === scope.scopeId && row.pubkey === pubkeyOf(person),
      ) ?? null
    );
  });
}

async function blobEvents(t: Convex, person: { subject: string }) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("buzzEvents").collect();
    return rows.filter(
      (row: { kind: number; pubkey: string }) =>
        row.kind === KIND_READ_STATE && row.pubkey === pubkeyOf(person),
    );
  });
}

// ===========================================================================
// The pure algebra
// ===========================================================================

describe("§4.1 the blob format", () => {
  it("accepts only a v1 blob with a plausible client id", () => {
    expect(isValidBlob({ v: 1, client_id: "abc", contexts: {} })).toBe(true);
    expect(isValidBlob({ v: 2, client_id: "abc", contexts: {} })).toBe(false);
    expect(isValidBlob({ v: 1, client_id: "", contexts: {} })).toBe(false);
    expect(isValidBlob({ v: 1, client_id: "x".repeat(65), contexts: {} })).toBe(false);
    expect(isValidBlob({ v: 1, client_id: "abc", contexts: [] })).toBe(false);
    expect(isValidBlob(null)).toBe(false);
    expect(isValidBlob("{}")).toBe(false);
  });

  it("drops entries it cannot store, and keeps the rest", () => {
    const kept = sanitizeContexts({
      good: 10,
      // A key too long in *bytes*, not characters — the wire form is UTF-8.
      ["é".repeat(200)]: 5,
      fractional: 1.5,
      negative: -1,
      overflow: 4_294_967_296,
      notANumber: "10",
      // Convex reserves these prefixes, so a blob carrying one would throw
      // inside somebody's mark-as-read rather than merely be ignored.
      $reserved: 1,
      _reserved: 1,
      "": 1,
    });
    expect(kept).toEqual({ good: 10 });
    // The boundary values are legal.
    expect(sanitizeContexts({ a: 0, b: 4_294_967_295 })).toEqual({ a: 0, b: 4_294_967_295 });
  });

  it("recognises a read-state d tag and nothing else", () => {
    expect(isValidReadStateDTag(readStateDTag("a".repeat(32)))).toBe(true);
    expect(isValidReadStateDTag("read-state:")).toBe(false);
    expect(isValidReadStateDTag("channel-mutes")).toBe(false);
    expect(isValidReadStateDTag(`read-state:${"x".repeat(65)}`)).toBe(false);
  });

  it("refuses an event that is not unambiguously one of ours", () => {
    const self = "a".repeat(64);
    const other = "b".repeat(64);
    const content = JSON.stringify({ v: 1, client_id: "c1", contexts: { room: 5 } });
    const ok = {
      pubkey: self,
      tags: [["d", readStateDTag("s1")], ["t", "read-state"]],
      content,
    };
    expect(parseReadStateEvent(ok, self)?.slotId).toBe("s1");

    // Signed by somebody else, however it is tagged.
    expect(parseReadStateEvent({ ...ok, pubkey: other }, self)).toBe(null);
    // Two `d` tags: the log picked one coordinate and we cannot tell which.
    expect(
      parseReadStateEvent(
        { ...ok, tags: [["d", readStateDTag("s1")], ["d", readStateDTag("s2")], ["t", "read-state"]] },
        self,
      ),
    ).toBe(null);
    // Somebody else's app data at a colliding coordinate.
    expect(parseReadStateEvent({ ...ok, tags: [["d", readStateDTag("s1")]] }, self)).toBe(null);
    expect(parseReadStateEvent({ ...ok, content: "not json" }, self)).toBe(null);
  });
});

describe("§4.2 / §4.5 resolving a marker", () => {
  it("folds the three terms the documented way", () => {
    const root = "r".repeat(64);
    const event = "e".repeat(64);
    // The channel term is passed in already-effective; thread and message are
    // read as own markers.
    expect(
      observedUnreadEventReadAt(
        100,
        { [threadContextKey(root)]: 400, [messageContextKey(event)]: 250 },
        event,
        root,
      ),
    ).toBe(400);
    // A top-level event has no thread term at all, so the thread marker cannot
    // reach it.
    expect(
      observedUnreadEventReadAt(100, { [threadContextKey(root)]: 400 }, event, null),
    ).toBe(100);
    expect(observedUnreadEventReadAt(null, {}, event, null)).toBe(null);
  });

  it("reads a broadcast reply as top-level so it cannot inherit a thread marker", () => {
    const root = "1".repeat(64);
    const parent = "2".repeat(64);
    const threaded = [
      ["e", root, "", "root"],
      ["e", parent, "", "reply"],
    ];
    expect(resolveObservedUnreadRootId(threaded)).toBe(root);
    expect(resolveObservedUnreadRootId([...threaded, ["broadcast", "1"]])).toBe(null);
    // An `e` tag with no reply marker is a quote, not a parent.
    expect(resolveObservedUnreadRootId([["e", root]])).toBe(null);
    expect(resolveObservedUnreadRootId([])).toBe(null);
  });

  it("agrees with messages.ts about what a thread reference is", () => {
    // Restated in readState.ts to avoid a three-module import cycle; this is
    // what keeps the restatement honest.
    const root = "1".repeat(64);
    const parent = "2".repeat(64);
    for (const tags of [
      [],
      [["e", root]],
      [["e", root, "", "reply"]],
      [
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ],
      [
        ["e", root, "", "root"],
        ["e", "3".repeat(64), "", "reply"],
        ["e", parent, "", "reply"],
      ],
    ]) {
      expect(resolveObservedUnreadRootId(tags)).toBe(threadReferenceFrom(tags).rootId);
    }
  });

  it("resolves the channel read marker, and says when the observed set is covered", () => {
    // The passive open path: no observed latest folded in.
    expect(resolveChannelReadMarker(500, undefined)).toEqual({
      markAt: 500,
      clearObserved: false,
    });
    // The explicit path folds it, and the fold wins when it is later.
    expect(resolveChannelReadMarker(500, 900)).toEqual({ markAt: 900, clearObserved: true });
    expect(resolveChannelReadMarker(900, 500)).toEqual({ markAt: 900, clearObserved: true });
    // Nothing to mark at all.
    expect(resolveChannelReadMarker(undefined, undefined)).toEqual({
      markAt: null,
      clearObserved: false,
    });
    expect(resolveChannelReadMarker(0, 0)).toEqual({ markAt: null, clearObserved: false });
  });
});

describe("§4.3 merge", () => {
  it("takes the max per key and loses nothing, in either order", () => {
    const laptop: ReadContexts = { a: 10, b: 50, c: 7 };
    const phone: ReadContexts = { a: 20, b: 5, d: 9 };
    const forward = mergeContexts(laptop, phone).contexts;
    const backward = mergeContexts(phone, laptop).contexts;
    expect(forward).toEqual({ a: 20, b: 50, c: 7, d: 9 });
    // The property, not the example: merging is commutative, so no device can
    // erase another by publishing second.
    expect(backward).toEqual(forward);
    // And idempotent, so a blob re-delivered by history and by the live
    // subscription is one merge.
    expect(mergeContexts(forward, phone).contexts).toEqual(forward);
    expect(mergeContexts(forward, phone).advanced).toEqual([]);
  });

  it("reports only the keys it actually moved forward", () => {
    // `advanced` is what clears a forced-unread dot, so an unchanged key must
    // not appear — re-receiving your own blob would otherwise undo a
    // deliberate mark-unread.
    const merged = mergeContexts({ a: 10, b: 10 }, { a: 10, b: 11, c: 1 });
    expect(merged.advanced.sort()).toEqual(["b", "c"]);
  });

  it("never lowers a marker", () => {
    const contexts = { room: 100 };
    expect(advanceContext(contexts, "room", 99).contexts).toEqual({ room: 100 });
    expect(advanceContext(contexts, "room", 100).contexts).toEqual({ room: 100 });
    expect(advanceContext(contexts, "room", 101).contexts).toEqual({ room: 101 });
    // A value that is not a marker is ignored rather than stored.
    expect(advanceContext(contexts, "room", -1).contexts).toEqual({ room: 100 });
    expect(advanceContext(contexts, "room", 1.5).contexts).toEqual({ room: 100 });
    expect(advanceContext({}, "room", 0).contexts).toEqual({ room: 0 });
  });

  it("suppresses a publish that would say exactly what the last one said", () => {
    expect(isIdenticalToLastPublished({ a: 1 }, { a: 1 })).toBe(true);
    expect(isIdenticalToLastPublished({ a: 1 }, { a: 2 })).toBe(false);
    expect(isIdenticalToLastPublished({ a: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(isIdenticalToLastPublished({ a: 1, b: 1 }, { a: 1 })).toBe(false);
  });
});

describe("§4.3 the byte budget", () => {
  const clientId = "c".repeat(32);

  it("estimates exactly what the serializer produces", () => {
    // The estimate exists because eviction is a loop and re-serialising is
    // quadratic. An estimate that can drift from the serializer is one that
    // eventually publishes a blob a byte over the cap.
    const cases: ReadContexts[] = [
      {},
      { a: 1 },
      { a: 1, b: 22, c: 333 },
      { ["ü".repeat(20)]: 4_294_967_295, [threadContextKey("r".repeat(64))]: 12 },
    ];
    for (const contexts of cases) {
      const blob: ReadStateBlob = { v: 1, client_id: clientId, contexts };
      expect(estimateBlobBytes(clientId, contexts)).toBe(blobBytes(blob));
    }
  });

  it("sheds oldest msg: first, then oldest thread:, and never a channel", () => {
    const contexts: ReadContexts = {
      room1: 1,
      room2: 2,
      [messageContextKey("a".repeat(64))]: 10,
      [messageContextKey("b".repeat(64))]: 20,
      [threadContextKey("c".repeat(64))]: 30,
      [threadContextKey("d".repeat(64))]: 40,
    };
    const full = estimateBlobBytes(clientId, contexts);

    // Room for everything: nothing is shed.
    expect(trimContextsToBudget(contexts, clientId, full)).toEqual(contexts);

    // One entry short: the oldest `msg:` goes first.
    const dropOne = trimContextsToBudget(contexts, clientId, full - 1);
    expect(dropOne).not.toBeNull();
    expect(Object.keys(dropOne ?? {})).not.toContain(messageContextKey("a".repeat(64)));
    expect(Object.keys(dropOne ?? {})).toContain(messageContextKey("b".repeat(64)));

    // Squeezed to the channels plus one prunable entry: both `msg:` markers are
    // gone before any `thread:` is touched, and the newest thread survives.
    const channelsOnly = estimateBlobBytes(clientId, { room1: 1, room2: 2 });
    const tight = trimContextsToBudget(
      contexts,
      clientId,
      channelsOnly + estimateBlobBytes(clientId, { [threadContextKey("d".repeat(64))]: 40 }) -
        estimateBlobBytes(clientId, {}) +
        1,
    );
    expect(tight).not.toBeNull();
    const tightKeys = Object.keys(tight ?? {});
    expect(tightKeys).toContain("room1");
    expect(tightKeys).toContain("room2");
    expect(tightKeys).toContain(threadContextKey("d".repeat(64)));
    expect(tightKeys.filter((key: string) => key.startsWith("msg:"))).toEqual([]);
  });

  it("refuses rather than dropping a channel key", () => {
    // Losing a channel key resurrects that channel's badge (§10.22), so the
    // answer to "the channels alone do not fit" is more slots, never an
    // eviction. `null` is that signal.
    const contexts: ReadContexts = {};
    for (let i = 0; i < 50; i += 1) contexts[`room${i}`.padEnd(64, "0")] = 1000 + i;
    expect(trimContextsToBudget(contexts, clientId, 200)).toBeNull();
    // Every channel key survives when there is room, whatever else is dropped.
    const withNoise = { ...contexts, [messageContextKey("f".repeat(64))]: 1 };
    const trimmed = trimContextsToBudget(withNoise, clientId, estimateBlobBytes(clientId, contexts));
    expect(trimmed).not.toBeNull();
    for (const key of Object.keys(contexts)) expect(trimmed?.[key]).toBe(contexts[key]);
  });

  it("splits across slots round-robin, keeping thread and msg markers in the primary", () => {
    const contexts: ReadContexts = {};
    for (let i = 0; i < 800; i += 1) {
      contexts[String(i).padStart(64, "0")] = 1_700_000_000 + i;
    }
    contexts[threadContextKey("a".repeat(64))] = 1_700_000_000;
    contexts[messageContextKey("b".repeat(64))] = 1_700_000_001;

    const slots = splitContextsIntoBudgetedSlots(contexts, clientId);
    expect(slots).not.toBeNull();
    const parts = slots ?? [];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(READ_STATE_MAX_SLOTS);

    // Every slot fits.
    for (const slot of parts) {
      expect(estimateBlobBytes(clientId, slot)).toBeLessThanOrEqual(
        READ_STATE_MAX_PLAINTEXT_BYTES,
      );
    }
    // Nothing is lost, and nothing is duplicated.
    const union: ReadContexts = {};
    let total = 0;
    for (const slot of parts) {
      for (const [key, value] of Object.entries(slot)) {
        expect(union[key]).toBeUndefined();
        union[key] = value;
        total += 1;
      }
    }
    expect(total).toBe(Object.keys(contexts).length);
    expect(union).toEqual(contexts);
    // Prunable entries live in the primary slot only.
    expect(parts[0][threadContextKey("a".repeat(64))]).toBe(1_700_000_000);
    expect(parts[0][messageContextKey("b".repeat(64))]).toBe(1_700_000_001);
    // Round-robin, so the slots are within one entry of each other.
    const sizes = parts.map((slot: ReadContexts) => Object.keys(slot).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(3);
  });

  it("gives up rather than publishing a truncated blob", () => {
    const contexts: ReadContexts = {};
    for (let i = 0; i < 6000; i += 1) {
      contexts[String(i).padStart(64, "0")] = 1_700_000_000 + i;
    }
    expect(splitContextsIntoBudgetedSlots(contexts, clientId)).toBeNull();
  });

  it("is deterministic — the same contexts split the same way twice", () => {
    const contexts: ReadContexts = {};
    for (let i = 0; i < 600; i += 1) contexts[String(i).padStart(64, "0")] = 1_700_000_000 + i;
    expect(splitContextsIntoBudgetedSlots(contexts, clientId)).toEqual(
      splitContextsIntoBudgetedSlots({ ...contexts }, clientId),
    );
  });
});

describe("§4.3 pruning", () => {
  const now = 1_800_000_000;

  it("drops stale prunable markers and never a channel key", () => {
    const contexts: ReadContexts = {
      roomA: 1,
      roomB: now,
      [threadContextKey("a".repeat(64))]: now - READ_STATE_HORIZON_SECONDS - 1,
      [threadContextKey("b".repeat(64))]: now - 10,
      [messageContextKey("c".repeat(64))]: now - READ_STATE_HORIZON_SECONDS - 1,
      [messageContextKey("d".repeat(64))]: now,
    };
    const pruned = pruneStaleContexts(contexts, now);
    // A channel key from 1970 stays: losing one resurrects a badge.
    expect(pruned.roomA).toBe(1);
    expect(pruned.roomB).toBe(now);
    expect(pruned[threadContextKey("a".repeat(64))]).toBeUndefined();
    expect(pruned[threadContextKey("b".repeat(64))]).toBe(now - 10);
    expect(pruned[messageContextKey("c".repeat(64))]).toBeUndefined();
    expect(pruned[messageContextKey("d".repeat(64))]).toBe(now);
  });

  it("caps the survivors at the newest N", () => {
    const contexts: ReadContexts = { room: 5 };
    for (let i = 0; i < LOCAL_MAX_PRUNABLE_CONTEXTS + 50; i += 1) {
      contexts[messageContextKey(String(i).padStart(64, "0"))] = now - i;
    }
    const pruned = pruneStaleContexts(contexts, now);
    expect(Object.keys(pruned).length).toBe(LOCAL_MAX_PRUNABLE_CONTEXTS + 1);
    // Newest kept, oldest dropped.
    expect(pruned[messageContextKey("0".repeat(64))]).toBe(now);
    expect(
      pruned[messageContextKey(String(LOCAL_MAX_PRUNABLE_CONTEXTS + 40).padStart(64, "0"))],
    ).toBeUndefined();
    expect(pruned.room).toBe(5);
  });
});

// ===========================================================================
// The transactional half
// ===========================================================================

describe("publishing a blob", () => {
  it("writes one replaceable event and hard-deletes the one it replaces", async () => {
    clockAt(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");

    clockAt(10);
    const first = await post(t, scope, room, BOB, "hello");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });

    let blobs = await blobEvents(t, ALICE);
    expect(blobs).toHaveLength(1);
    const firstBlobId = blobs[0].eventId;
    expect(blobs[0].coord).toBe(
      `${KIND_READ_STATE}:${pubkeyOf(ALICE)}:${readStateDTag(
        (await readStateRow(t, scope, ALICE))?.publishedSlots[0].slotId ?? "",
      )}`,
    );

    clockAt(30);
    await post(t, scope, room, BOB, "again");
    clockAt(40);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });

    blobs = await blobEvents(t, ALICE);
    // Still exactly one. 06-protocol §6.3: read state is hard-deleted on
    // replacement, so a mark-as-read does not leave a row behind forever.
    expect(blobs).toHaveLength(1);
    expect(blobs[0].eventId).not.toBe(firstBlobId);
    // …and neither does its tag projection.
    const orphans = await t.run(async (ctx: Ctx) => {
      const rows = await ctx.db.query("buzzEventTags").collect();
      return rows.filter((row: { eventId: string }) => row.eventId === firstBlobId);
    });
    expect(orphans).toHaveLength(0);
    expect(first.createdAt).toBeLessThan(blobs[0].createdAt);
  });

  it("carries a watermark that only moves forward", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");

    const watermarks: number[] = [];
    for (const offset of [10, 11, 12]) {
      clockAt(offset);
      await post(t, scope, room, BOB, `m${offset}`);
      await t
        .withIdentity(ALICE)
        .mutation(readState.markChannelRead, { ...scope, channelId: room });
      const row = await readStateRow(t, scope, ALICE);
      watermarks.push(row?.publishedAt ?? 0);
    }
    // Strictly increasing: `max(now, watermark + 1)` (§10.21), so a replica
    // holding the old blob is always superseded even under clock skew.
    expect(watermarks[1]).toBeGreaterThan(watermarks[0]);
    expect(watermarks[2]).toBeGreaterThan(watermarks[1]);
  });

  it("does not publish again when nothing changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "hello");

    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    const first = (await blobEvents(t, ALICE))[0].eventId;

    clockAt(21);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    expect((await blobEvents(t, ALICE))[0].eventId).toBe(first);
  });

  it("reassembles multi-slot state through the same merge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");

    // A reader in many rooms. Seeded directly, because the alternative is
    // creating six hundred channels to reach one code path.
    const many: ReadContexts = {};
    for (let i = 0; i < 700; i += 1) many[String(i).padStart(64, "0")] = 1_700_000_000 + i;
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("buzzReadState", {
        ...scope,
        pubkey: pubkeyOf(ALICE),
        contexts: many,
        forcedUnread: {},
        clientId: "seeded",
        rotation: 0,
        publishedSlots: [],
        publishedContexts: {},
        publishedAt: 0,
        updatedAt: Date.now(),
      });
    });

    clockAt(10);
    await post(t, scope, room, BOB, "hello");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });

    const blobs = await blobEvents(t, ALICE);
    expect(blobs.length).toBeGreaterThan(1);
    expect(blobs.length).toBeLessThanOrEqual(READ_STATE_MAX_SLOTS);
    const row = await readStateRow(t, scope, ALICE);
    expect(row?.publishedSlots).toHaveLength(blobs.length);

    // Every slot is a valid blob under the reader's own key, and their union is
    // the whole state — which is what `hydrate` rebuilds from.
    const union: ReadContexts = {};
    for (const blob of blobs) {
      const parsed = parseReadStateEvent(blob, pubkeyOf(ALICE));
      expect(parsed).not.toBeNull();
      Object.assign(union, parsed?.blob.contexts ?? {});
    }
    for (const key of Object.keys(many)) expect(union[key]).toBe(many[key]);
    expect(union[room]).toBeDefined();

    // A second write reassembles them rather than losing the ones it did not
    // touch.
    clockAt(30);
    await post(t, scope, room, BOB, "again");
    clockAt(40);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    const after = await readStateRow(t, scope, ALICE);
    expect(Object.keys(after?.contexts ?? {}).length).toBe(Object.keys(many).length + 1);
  });
});

describe("§4.5 the sidebar", () => {
  it("counts unread messages, mentions, and neither for your own", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");

    // The room's own system rows (created, joined) are visible and are not
    // conversational, so a fresh room reads as nothing unread (§10.3).
    expect((await rail(t, scope, ALICE)).get(room)).toMatchObject({ unread: 0, mentions: 0 });

    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(11);
    await post(t, scope, room, BOB, `hey @[Alice](${ALICE.subject})`);
    clockAt(12);
    await post(t, scope, room, ALICE, "mine");

    const alice = (await rail(t, scope, ALICE)).get(room);
    // Two of Bob's, one of which names her. Her own message is never unread.
    expect(alice).toMatchObject({ unread: 2, mentions: 1 });

    // Bob sees only Alice's, and it does not name him.
    expect((await rail(t, scope, BOB)).get(room)).toMatchObject({ unread: 1, mentions: 0 });
  });

  it("suppresses the badge on the room the reader is standing in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");

    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);
    expect((await rail(t, scope, ALICE, room)).get(room)?.unread).toBe(0);
  });

  it("does not badge a room the reader has not joined", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const created = (await t
      .withIdentity(BOB)
      .mutation(channels.create, { ...scope, name: "bobs-room" })) as { channelId: string };
    clockAt(10);
    await post(t, scope, created.channelId, BOB, "in my room");

    // Alice can see the open room in the browser; it is not in her rail's
    // sense of "unread", because nothing there is waiting for her.
    const summary = (await rail(t, scope, ALICE)).get(created.channelId);
    expect(summary).toMatchObject({ unread: 0, mentions: 0 });

    await t.withIdentity(ALICE).mutation(channels.join, { ...scope, channelId: created.channelId });
    expect((await rail(t, scope, ALICE)).get(created.channelId)?.unread).toBe(1);
  });

  it("counts a thread reply toward the room, and honours a per-message marker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    const head = await post(t, scope, room, BOB, "topic");
    clockAt(20);
    const reply = await post(t, scope, room, BOB, "reply", head.eventId);

    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(2);

    // Reading the reply on its own marks exactly it, and nothing else.
    clockAt(30);
    await t.withIdentity(ALICE).mutation(readState.markMessagesRead, {
      ...scope,
      channelId: room,
      messages: [{ messageId: reply.eventId, readAt: reply.createdAt }],
    });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);
  });

  it("counts every message in a DM as addressed to you", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const dm = (await t
      .withIdentity(BOB)
      .mutation(channels.openDm, { ...scope, actorIds: [ALICE.subject] })) as {
      channelId: string;
    };
    clockAt(10);
    await post(t, scope, dm.channelId, BOB, "no token in here");

    // No `p` tag naming Alice beyond the DM itself — a DM is addressed to its
    // participants by construction, which is what makes it a count rather than
    // a dot (§4.8).
    expect((await rail(t, scope, ALICE)).get(dm.channelId)).toMatchObject({
      unread: 1,
      mentions: 1,
    });
  });

  it("stops counting once the marker covers the room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(0);

    clockAt(30);
    await post(t, scope, room, BOB, "two");
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);
  });

  it("draws the same numbers in the room header as in the rail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, `hello @[Alice](${ALICE.subject})`);

    const railRow = (await rail(t, scope, ALICE)).get(room);
    const header = (await t
      .withIdentity(ALICE)
      .query(channels.get, { ...scope, channelId: room })) as Summary;
    expect({ unread: header.unread, mentions: header.mentions }).toEqual({
      unread: railRow?.unread,
      mentions: railRow?.mentions,
    });
  });
});

describe("§4.9 the mark-as-read triggers", () => {
  it("opening a channel marks top-level only, and does not absorb a thread reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    const head = await post(t, scope, room, BOB, "topic");
    clockAt(20);
    await post(t, scope, room, BOB, "a reply nobody has opened", head.eventId);

    // The passive open path: the caller's readAt is the newest *top-level*
    // message, and the room's observed latest — which counts the reply — is not
    // folded in (§10.12).
    clockAt(30);
    await t.withIdentity(ALICE).mutation(readState.markChannelRead, {
      ...scope,
      channelId: room,
      readAt: head.createdAt,
      topLevelOnly: true,
    });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);
  });

  it("Escape folds the observed latest and clears the room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    const head = await post(t, scope, room, BOB, "topic");
    clockAt(20);
    await post(t, scope, room, BOB, "a reply", head.eventId);

    clockAt(30);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(0);
  });

  it("Shift+Escape marks every joined room read at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const first = await createRoom(t, scope, "one");
    const second = await createRoom(t, scope, "two");
    clockAt(10);
    await post(t, scope, first, BOB, "a");
    await post(t, scope, second, BOB, "b");
    expect((await rail(t, scope, ALICE)).get(first)?.unread).toBe(1);

    clockAt(20);
    const swept = (await t
      .withIdentity(ALICE)
      .mutation(readState.markAllChannelsRead, scope)) as { channels: number };
    expect(swept.channels).toBe(2);
    const after = await rail(t, scope, ALICE);
    expect(after.get(first)?.unread).toBe(0);
    expect(after.get(second)?.unread).toBe(0);
    // One blob for the whole gesture, not one per room.
    expect(await blobEvents(t, ALICE)).toHaveLength(1);
  });

  it("a marker never goes backwards, whatever a caller asks for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");

    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    const high = (await readStateRow(t, scope, ALICE))?.contexts[channelContextKey(room)];

    clockAt(21);
    await t.withIdentity(ALICE).mutation(readState.markChannelRead, {
      ...scope,
      channelId: room,
      readAt: 1,
      topLevelOnly: true,
    });
    expect((await readStateRow(t, scope, ALICE))?.contexts[channelContextKey(room)]).toBe(high);
  });

  it("mark unread lights the dot without rewinding anything", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    const marker = (await readStateRow(t, scope, ALICE))?.contexts[channelContextKey(room)];

    clockAt(30);
    const forced = (await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelUnread, { ...scope, channelId: room })) as {
      baseline: number | null;
    };
    expect(forced.baseline).toBe(marker);

    const row = await readStateRow(t, scope, ALICE);
    // The marker is untouched — a rewind would be permanent and would apply on
    // every device (§4.4).
    expect(row?.contexts[channelContextKey(room)]).toBe(marker);
    expect(row?.forcedUnread[room]).toBe(marker ?? null);

    // Dot tier only: never a mention, because nobody addressed it to you.
    expect((await rail(t, scope, ALICE)).get(room)).toMatchObject({ unread: 1, mentions: 0 });
  });

  it("mark unread survives a resync, and is cleared by a genuine read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    clockAt(30);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelUnread, { ...scope, channelId: room });
    const baseline =
      (await readStateRow(t, scope, ALICE))?.contexts[channelContextKey(room)] ?? 0;

    // A sync that carries the *same* marker — the other device knew no more
    // than we did — must leave the mark standing.
    clockAt(40);
    await t.withIdentity(ALICE).mutation(readState.importBlobs, {
      ...scope,
      blobs: [JSON.stringify({ v: 1, client_id: "phone", contexts: { [room]: baseline } })],
    });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);
    expect((await readStateRow(t, scope, ALICE))?.forcedUnread[room]).toBe(baseline);

    // A sync carrying a *later* marker is a read that happened elsewhere. The
    // read wins, the dot goes out, and the entry is drained from the map.
    clockAt(50);
    const drained = (await t.withIdentity(ALICE).mutation(readState.importBlobs, {
      ...scope,
      blobs: [
        JSON.stringify({ v: 1, client_id: "phone", contexts: { [room]: baseline + 100 } }),
      ],
    })) as { advanced: string[]; cleared: string[] };
    expect(drained.advanced).toContain(room);
    expect(drained.cleared).toContain(room);
    expect((await readStateRow(t, scope, ALICE))?.forcedUnread[room]).toBeUndefined();
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(0);
  });

  it("mark read clears a forced-unread mark", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelUnread, { ...scope, channelId: room });
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(1);

    clockAt(30);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });
    expect((await readStateRow(t, scope, ALICE))?.forcedUnread[room]).toBeUndefined();
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(0);
  });

  it("opening a thread marks only the replies handed to it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    const head = await post(t, scope, room, BOB, "topic");
    clockAt(20);
    const visible = await post(t, scope, room, BOB, "visible", head.eventId);
    clockAt(21);
    await post(t, scope, room, BOB, "still collapsed", visible.eventId);

    clockAt(30);
    await t.withIdentity(ALICE).mutation(readState.markMessagesRead, {
      ...scope,
      channelId: room,
      messages: [{ messageId: visible.eventId, readAt: visible.createdAt }],
    });

    const row = await readStateRow(t, scope, ALICE);
    // Exactly one `msg:` marker: marking the whole subtree would hide the
    // collapsed reply forever (§10.18).
    expect(
      Object.keys(row?.contexts ?? {}).filter((key: string) => key.startsWith("msg:")),
    ).toEqual([messageContextKey(visible.eventId)]);
    // The head and the collapsed reply are still unread.
    expect((await rail(t, scope, ALICE)).get(room)?.unread).toBe(2);
  });

  it("refuses to record a marker for something that is not an event id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    const marked = (await t.withIdentity(ALICE).mutation(readState.markMessagesRead, {
      ...scope,
      channelId: room,
      messages: [{ messageId: "not-an-event-id", readAt: 10 }],
    })) as { marked: number };
    expect(marked.marked).toBe(0);
    expect(Object.keys((await readStateRow(t, scope, ALICE))?.contexts ?? {})).toEqual([]);
  });
});

describe("read state is the reader's own", () => {
  it("only ever answers with the caller's state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const room = await createRoom(t, scope, "general");
    clockAt(10);
    await post(t, scope, room, BOB, "one");
    clockAt(20);
    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: room });

    const mine = (await t.withIdentity(ALICE).query(readState.forCurrentUser, scope)) as {
      pubkey: string | null;
      contexts: ReadContexts;
    };
    expect(mine.pubkey).toBe(pubkeyOf(ALICE));
    expect(mine.contexts[channelContextKey(room)]).toBeGreaterThan(0);

    // Bob asks the same question and gets his own answer — there is no argument
    // in which he could ask for hers.
    const his = (await t.withIdentity(BOB).query(readState.forCurrentUser, scope)) as {
      pubkey: string | null;
      contexts: ReadContexts;
    };
    expect(his.pubkey).toBe(pubkeyOf(BOB));
    expect(his.contexts).toEqual({});
  });

  it("refuses a caller outside the community", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    await expect(
      t.withIdentity({ subject: "user_outsider" }).query(readState.forCurrentUser, scope),
    ).rejects.toThrow();
  });

  it("refuses a blob that is not one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    await expect(
      t.withIdentity(ALICE).mutation(readState.importBlobs, { ...scope, blobs: ["nonsense"] }),
    ).rejects.toThrow(/read-state blob/);
    await expect(
      t.withIdentity(ALICE).mutation(readState.importBlobs, {
        ...scope,
        blobs: [JSON.stringify({ v: 2, client_id: "x", contexts: {} })],
      }),
    ).rejects.toThrow(/read-state blob/);
  });
});

describe("maxReadAt", () => {
  it("folds a list of markers to the max non-null", () => {
    expect(maxReadAt()).toBe(null);
    expect(maxReadAt(null, undefined)).toBe(null);
    expect(maxReadAt(null, 0)).toBe(0);
    expect(maxReadAt(5, null, 9, undefined, 2)).toBe(9);
  });
});

describe("a read-state blob is private to its author", () => {
  // A blob says which rooms you opened and when you last looked at them, which
  // is a record of your attention. Buzz encrypts it to itself; that defends
  // against a relay operator, which we do not have, since the server holds
  // every key by construction. What it ALSO defends against is a fellow
  // community member reading it back — and that threat is real here. There is
  // no cipher in this repo, and none is needed: kind 30078 is author-gated.
  //
  // This asserts the gate itself rather than going through a query. A first
  // version called `log.read` and swallowed the rejection, so it passed with
  // the gate removed — it was measuring an unrelated refusal of an
  // unconstrained global read, not privacy. `eventVisibleToReader` is the one
  // per-event gate every read surface runs, so testing it directly is both
  // narrower and stronger.
  it("is invisible to another member through the one visibility gate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clockAt(0);
    const { t, scope } = await seed();
    const general = await createRoom(t, scope, "general");

    await t
      .withIdentity(ALICE)
      .mutation(readState.markChannelRead, { ...scope, channelId: general });

    const blobs = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzEvents")
        .filter((q) => q.eq(q.field("kind"), 30078))
        .collect(),
    );
    expect(blobs.length).toBeGreaterThan(0);
    for (const row of blobs) {
      expect(row.pubkey).toBe(pubkeyOf(ALICE));
      expect(eventVisibleToReader(row, pubkeyOf(ALICE))).toBe(true);
      expect(eventVisibleToReader(row, pubkeyOf(BOB))).toBe(false);
    }
  });
});
