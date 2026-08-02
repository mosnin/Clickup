import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  AUTHOR_ONLY_KINDS,
  P_GATED_KINDS,
  RESULT_GATED_KINDS,
  SEARCHABLE_KINDS,
  SHARED_GATED_KINDS,
} from "../convex/buzz/_kinds";
import { globalFilterGateFailure } from "../convex/buzz/log";
import { SEARCHABLE_MESSAGE_KINDS, type SearchResponse } from "../convex/buzz/search";
import {
  buildMessageLink,
  parseMessageLink,
} from "../src/components/chat/transcript/message-link";
import { resolveSearchHitDestination } from "../src/components/chat/search/hit-destination";

// `anyApi` rather than the generated `api`, for the reason every buzz suite
// states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it. The references
// resolve identically at runtime — convex-test finds them through the glob.
const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const search = anyApi.buzz.search;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
/** In the community, but in none of its private rooms. */
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

// ---------------------------------------------------------------------------
// One repair to the test double, stated out loud
// ---------------------------------------------------------------------------

/**
 * convex-test 0.0.54 evaluates a search index by **scanning every row in the
 * table** and applying the declared filters in declaration order — and its text
 * filter calls `.split()` on the field without checking that the field is there.
 *
 * That is exactly backwards from the property this suite exists to prove. In
 * real Convex a row with no `searchText` is *not in the index*, so the engine
 * never sees it; in the fake it is scanned like any other row and blows up. The
 * shim below reorders the equality filters ahead of the text filter, which makes
 * the fake short-circuit on rows the real index would never have held.
 *
 * It is a repair to the double and not a change in behaviour: `.every` is
 * order-independent as a predicate, so no row's verdict differs — only whether
 * the fake reaches an undefined field before deciding. Without it this file
 * could not contain a database that holds a privacy-sensitive event at all,
 * which would make the central assertion untestable.
 */
type SyscallHost = {
  syscall: (op: string, jsonArgs: string) => string;
  asyncSyscall: (op: string, jsonArgs: string) => Promise<string>;
  jsSyscall: (op: string, args: Record<string, unknown>) => unknown;
};

let shimInstalled = false;

function equalityFiltersFirst(jsonArgs: string): string {
  let parsed: {
    query?: { source?: { type?: string; filters?: { type?: string }[] } };
  };
  try {
    parsed = JSON.parse(jsonArgs);
  } catch {
    return jsonArgs;
  }
  const source = parsed.query?.source;
  if (source?.type !== "Search" || !Array.isArray(source.filters)) return jsonArgs;
  source.filters = [
    ...source.filters.filter((filter) => filter.type !== "Search"),
    ...source.filters.filter((filter) => filter.type === "Search"),
  ];
  return JSON.stringify(parsed);
}

function repairSearchIndexFake(): void {
  if (shimInstalled) return;
  const holder = globalThis as unknown as { Convex?: SyscallHost };
  const base = holder.Convex;
  if (!base) return;
  shimInstalled = true;
  holder.Convex = {
    // Getters, because convex-test's own global is a getter that resolves to
    // the *currently running* test's syscall through AsyncLocalStorage. Caching
    // the function instead of the accessor would pin every later test to the
    // first test's database.
    get syscall() {
      const inner = base.syscall;
      return (op: string, jsonArgs: string) =>
        inner(op, op === "1.0/queryStream" ? equalityFiltersFirst(jsonArgs) : jsonArgs);
    },
    get asyncSyscall() {
      return base.asyncSyscall;
    },
    get jsSyscall() {
      return base.jsSyscall;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seed() {
  const t = convexTest(schema, modules);
  repairSearchIndexFake();

  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, CAROL, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: publicKeyFromSecret(KEYS[person.subject]),
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
    // A second community with the same words in it, so "the tenancy fence" is a
    // claim about two real workspaces rather than about a string that resolves
    // to nothing.
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Beta",
      slug: "beta",
      ownerClerkId: BOB.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
      [CAROL.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    await ctx.db.insert("memberships", {
      userClerkId: BOB.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });

    return { workspaceId, otherWorkspaceId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const otherScope: Scope = { scopeType: "workspace", scopeId: ids.otherWorkspaceId };
  return { t, scope, otherScope };
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function createChannel(
  t: Harness,
  scope: Scope,
  args: Record<string, unknown>,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, ...args })) as { channelId: string };
  return result.channelId;
}

/** Posting requires membership, so anyone but the room's creator joins first. */
async function join(
  t: Harness,
  scope: Scope,
  channelId: string,
  as: { subject: string },
): Promise<void> {
  await t.withIdentity(as).mutation(channels.join, { ...scope, channelId });
}

async function post(
  t: Harness,
  scope: Scope,
  channelId: string,
  body: string,
  as = ALICE,
  reply?: { parentId: string; rootId?: string },
): Promise<string> {
  const result = (await t.withIdentity(as).mutation(messages.post, {
    ...scope,
    channelId,
    body,
    ...(reply ?? {}),
  })) as { eventId: string };
  return result.eventId;
}

async function run(
  t: Harness,
  scope: Scope,
  args: Record<string, unknown>,
  as: { subject: string } | null = ALICE,
): Promise<SearchResponse> {
  const runner = as ? t.withIdentity(as) : t;
  return (await runner.query(search.messages, { ...scope, ...args })) as SearchResponse;
}

function ids(response: SearchResponse): string[] {
  return response.hits.map((hit) => hit.eventId);
}

// ---------------------------------------------------------------------------
// The allowlist is the mechanism (§16.16)
// ---------------------------------------------------------------------------

describe("the searchable allowlist", () => {
  it("contains no gated kind", () => {
    // Buzz's `p_gated_persistent_kinds_have_storage_null_tsvector`, restated
    // against our allowlist. If this ever fails, some private kind's content has
    // been made indexable and every other assertion in this file is void.
    for (const kind of SEARCHABLE_KINDS) {
      expect(AUTHOR_ONLY_KINDS.has(kind), `kind ${kind} is author-only`).toBe(false);
      expect(P_GATED_KINDS.has(kind), `kind ${kind} is #p-gated`).toBe(false);
      expect(SHARED_GATED_KINDS.has(kind), `kind ${kind} is shared-gated`).toBe(false);
      expect(RESULT_GATED_KINDS.has(kind), `kind ${kind} is result-gated`).toBe(false);
    }
  });

  it("searches only kinds that have a room to navigate to", () => {
    // Derived from the allowlist, so it cannot drift from it. Kind 0 (profiles)
    // is searchable and deliberately absent here: §6.3 says a hit with no
    // channel is unnavigable.
    expect(SEARCHABLE_MESSAGE_KINDS).toEqual([9, 40002, 45001, 45003]);
    for (const kind of SEARCHABLE_MESSAGE_KINDS) {
      expect(SEARCHABLE_KINDS.has(kind)).toBe(true);
    }
  });

  it("the filter-level gate would refuse a search that named a gated kind", () => {
    // The gate in `search.messages` runs *before* the search branch (§16.12) and
    // passes today because nothing searchable is gated. This asserts that it is
    // load-bearing rather than decorative: hand it a p-gated kind and it refuses.
    const reader = pubkeyOf(ALICE);
    expect(
      globalFilterGateFailure({ kinds: [...SEARCHABLE_MESSAGE_KINDS] }, reader),
    ).toBeNull();
    expect(
      globalFilterGateFailure({ kinds: [...SEARCHABLE_MESSAGE_KINDS, 1059] }, reader),
    ).toContain("restricted");
  });
});

// ---------------------------------------------------------------------------
// Storage-level unsearchability
// ---------------------------------------------------------------------------

describe("privacy-sensitive kinds are unsearchable at the storage layer", () => {
  it("writes no index entry for them, and finds nothing for their author", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    await post(t, scope, room, "the pineapple velociraptor deploy plan");

    // A kind-1059 gift wrap: `#p`-gated, global, and outside the allowlist.
    // Published through the real write path so the row is exactly what a
    // production write would produce.
    const PHRASE = "sequestered narwhal ledger";
    await t.run(async (ctx: Ctx) => {
      const { publishCore } = await import("../convex/buzz/log");
      const outcome = await publishCore(ctx, {
        actor: { type: "user", id: ALICE.subject, name: "Alice" },
        scope,
        kind: 1059,
        tags: [["p", pubkeyOf(ALICE)]],
        content: PHRASE,
      });
      expect(outcome.status).toBe("inserted");
    });

    // 1. The mechanism, asserted directly: there is no index entry. Not "the
    //    query filtered it out" — the column the index reads is absent, so a
    //    hit for it cannot exist, cannot be counted, and cannot be resurrected
    //    by a later refactor of the query side.
    const stored = await t.run(async (ctx: Ctx) => {
      const rows = await ctx.db.query("buzzEvents").collect();
      return rows.map((row: { kind: number; searchText?: string; content: string }) => ({
        kind: row.kind,
        indexed: row.searchText !== undefined,
        content: row.content,
      }));
    });
    const secret = stored.find((row) => row.content === PHRASE);
    expect(secret).toBeDefined();
    expect(secret?.indexed).toBe(false);
    // …and the ordinary message beside it *is* indexed, so the assertion above
    // is about the kind rather than about nothing having been written.
    expect(
      stored.some((row) => row.kind === 9 && row.indexed && row.content.includes("pineapple")),
    ).toBe(true);

    // 2. The author — the one person who is allowed to read it, who wrote it,
    //    and who therefore knows its exact wording — cannot find it.
    const exact = await run(t, scope, { text: PHRASE });
    expect(exact.hits).toEqual([]);
    // Not even the count moves: an aggregate leaks existence (§16.13).
    expect(exact.found).toBe(0);

    for (const term of ["narwhal", "sequestered ledger", "ledger"]) {
      expect((await run(t, scope, { text: term })).found).toBe(0);
    }

    // 3. The searchable message in the same room is still findable, so the
    //    zeroes above are a property of the kind and not of a broken search.
    expect((await run(t, scope, { text: "pineapple" })).found).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe("visibility", () => {
  it("never returns a private room's messages to a non-member", async () => {
    const { t, scope } = await seed();
    const open = await createChannel(t, scope, { name: "general" });
    const closed = await createChannel(t, scope, {
      name: "acquisitions",
      visibility: "private",
    });
    await post(t, scope, open, "the quarterly kingfisher review");
    const secret = await post(t, scope, closed, "the kingfisher acquisition memo");

    // Alice created both rooms, so she is in both and sees both.
    const asAlice = await run(t, scope, { text: "kingfisher" }, ALICE);
    expect(asAlice.found).toBe(2);
    expect(ids(asAlice)).toContain(secret);

    // Carol is in the community and in neither private room.
    const asCarol = await run(t, scope, { text: "kingfisher" }, CAROL);
    expect(asCarol.found).toBe(1);
    expect(ids(asCarol)).not.toContain(secret);
    expect(asCarol.hits[0].channelId).toBe(open);
  });

  it("does not let a non-member reach a private room by naming its id", async () => {
    const { t, scope } = await seed();
    const closed = await createChannel(t, scope, {
      name: "acquisitions",
      visibility: "private",
    });
    await post(t, scope, closed, "the kingfisher acquisition memo");

    // The narrowing an `in:` produces, aimed at a room the reader is not in.
    // The index filter matches; the per-hit room check is the thing that says no.
    const asCarol = await run(t, scope, { text: "kingfisher", channelIds: [closed] }, CAROL);
    expect(asCarol.hits).toEqual([]);
    expect(asCarol.found).toBe(0);
  });

  it("returns an archived room's messages only to its members", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "old-project" });
    await post(t, scope, room, "the kingfisher retrospective");
    await t.withIdentity(ALICE).mutation(channels.setArchived, {
      ...scope,
      channelId: room,
      archived: true,
    });

    expect((await run(t, scope, { text: "kingfisher" }, ALICE)).found).toBe(1);
    expect((await run(t, scope, { text: "kingfisher" }, CAROL)).found).toBe(0);
  });

  it("drops a deleted message from the results", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    const id = await post(t, scope, room, "the kingfisher plan");
    expect((await run(t, scope, { text: "kingfisher" })).found).toBe(1);

    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId: room, targetId: id });
    expect((await run(t, scope, { text: "kingfisher" })).found).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe("the tenancy fence", () => {
  it("refuses a scope the caller is not in", async () => {
    const { t, otherScope } = await seed();
    await expect(run(t, otherScope, { text: "anything" }, ALICE)).rejects.toThrow(/Forbidden/);
  });

  it("refuses an unauthenticated caller", async () => {
    const { t, scope } = await seed();
    await expect(run(t, scope, { text: "anything" }, null)).rejects.toThrow();
  });

  it("refuses a caller in no community at all", async () => {
    const { t, scope } = await seed();
    await expect(run(t, scope, { text: "anything" }, OUTSIDER)).rejects.toThrow(/Forbidden/);
  });

  it("never returns another community's messages, on any query shape", async () => {
    const { t, scope, otherScope } = await seed();
    const mine = await createChannel(t, scope, { name: "general" }, ALICE);
    const theirs = await createChannel(t, otherScope, { name: "general" }, BOB);
    await post(t, scope, mine, "the kingfisher plan for acme", ALICE);
    await post(t, otherScope, theirs, "the kingfisher plan for beta", BOB);

    // Every shape the query can take: bare text, channel-narrowed,
    // author-narrowed, and time-narrowed. The index carries `scopeId` but not
    // `scopeType`, so this is the assertion that the per-hit re-check works.
    const shapes: Record<string, unknown>[] = [
      { text: "kingfisher" },
      { text: "kingfisher", channelIds: [theirs] },
      { text: "kingfisher", authors: [pubkeyOf(BOB)] },
      { text: "kingfisher", since: 0, until: Math.floor(Date.now() / 1000) + 60 },
      { text: "kingfisher", channelIds: [mine, theirs], authors: [pubkeyOf(BOB)] },
    ];
    for (const shape of shapes) {
      const response = await run(t, scope, shape, ALICE);
      for (const hit of response.hits) {
        expect(hit.channelId).toBe(mine);
      }
    }

    // …and symmetrically, from the other side.
    const fromBeta = await run(t, otherScope, { text: "kingfisher" }, BOB);
    expect(fromBeta.found).toBe(1);
    expect(fromBeta.hits[0].channelId).toBe(theirs);
  });
});

// ---------------------------------------------------------------------------
// The structured operators, executed
// ---------------------------------------------------------------------------

describe("operators, executed", () => {
  it("narrows by channel", async () => {
    const { t, scope } = await seed();
    const one = await createChannel(t, scope, { name: "general" });
    const two = await createChannel(t, scope, { name: "design" });
    await post(t, scope, one, "the kingfisher plan");
    const inDesign = await post(t, scope, two, "the kingfisher mock");

    const response = await run(t, scope, { text: "kingfisher", channelIds: [two] });
    expect(ids(response)).toEqual([inDesign]);
  });

  it("narrows by author", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    await post(t, scope, room, "the kingfisher plan", ALICE);
    await join(t, scope, room, BOB);
    const fromBob = await post(t, scope, room, "the kingfisher counter-plan", BOB);

    const response = await run(t, scope, { text: "kingfisher", authors: [pubkeyOf(BOB)] });
    expect(ids(response)).toEqual([fromBob]);
  });

  it("narrows by time, inclusively at both ends", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    const id = await post(t, scope, room, "the kingfisher plan");
    const at = (await run(t, scope, { text: "kingfisher" })).hits[0].createdAt;

    expect(ids(await run(t, scope, { text: "kingfisher", since: at }))).toEqual([id]);
    expect(ids(await run(t, scope, { text: "kingfisher", until: at }))).toEqual([id]);
    expect((await run(t, scope, { text: "kingfisher", since: at + 1 })).found).toBe(0);
    // The `before:` translation: one second earlier excludes it, which is the
    // whole reason the grammar subtracts a second.
    expect((await run(t, scope, { text: "kingfisher", until: at - 1 })).found).toBe(0);
  });

  it("combines every narrowing at once", async () => {
    const { t, scope } = await seed();
    const one = await createChannel(t, scope, { name: "general" });
    const two = await createChannel(t, scope, { name: "design" });
    await post(t, scope, one, "the kingfisher plan", ALICE);
    await post(t, scope, two, "the kingfisher plan", ALICE);
    await join(t, scope, two, BOB);
    const wanted = await post(t, scope, two, "the kingfisher plan", BOB);
    const at = Math.floor(Date.now() / 1000);

    const response = await run(t, scope, {
      text: "kingfisher",
      channelIds: [two],
      authors: [pubkeyOf(BOB)],
      since: at - 120,
      until: at + 120,
    });
    expect(ids(response)).toEqual([wanted]);
  });

  it("refuses more channels than it will search, rather than searching some of them", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    await expect(
      run(t, scope, {
        text: "kingfisher",
        channelIds: Array.from({ length: 9 }, (_, i) => `${room}${i}`),
      }),
    ).rejects.toThrow(/at most 8 channels/);
  });

  it("short-circuits an empty query with no results and no error", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    await post(t, scope, room, "the kingfisher plan");
    for (const text of ["", "   ", "\0"]) {
      const response = await run(t, scope, { text });
      expect(response).toEqual({ hits: [], found: 0, truncated: false });
    }
  });

  it("honours the limit and reports truncation", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    for (let i = 0; i < 5; i += 1) {
      await post(t, scope, room, `kingfisher note ${i}`);
    }
    const limited = await run(t, scope, { text: "kingfisher", limit: 2 });
    expect(limited.hits).toHaveLength(2);
    expect(limited.found).toBe(5);
    expect(limited.truncated).toBe(true);

    const all = await run(t, scope, { text: "kingfisher", limit: 50 });
    expect(all.hits).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });

  it("returns hits newest first, with a deterministic tie-break", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "general" });
    for (let i = 0; i < 4; i += 1) await post(t, scope, room, `kingfisher ${i}`);

    const response = await run(t, scope, { text: "kingfisher" });
    const order = response.hits.map((hit) => [hit.createdAt, hit.eventId] as const);
    for (let i = 1; i < order.length; i += 1) {
      const [prevAt, prevId] = order[i - 1];
      const [at, id] = order[i];
      expect(prevAt > at || (prevAt === at && prevId < id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// What a hit carries, and where it goes
// ---------------------------------------------------------------------------

describe("hits", () => {
  it("carries the room, the author and the thread it lives in", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "design", description: "" });
    const root = await post(t, scope, room, "the kingfisher thread", ALICE);
    await join(t, scope, room, BOB);
    const reply = await post(t, scope, room, "the kingfisher reply", BOB, {
      parentId: root,
      rootId: root,
    });

    const response = await run(t, scope, { text: "kingfisher reply" });
    const hit = response.hits.find((candidate) => candidate.eventId === reply);
    expect(hit).toBeDefined();
    expect(hit?.channelId).toBe(room);
    expect(hit?.channelName).toBe("design");
    expect(hit?.authorName).toBe(BOB.subject);
    expect(hit?.authorIsAgent).toBe(false);
    expect(hit?.threadRootId).toBe(root);
    expect(hit?.content).toContain("kingfisher");
  });

  it("routes to a link that resolves back to the same message", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, { name: "design" });
    const root = await post(t, scope, room, "the kingfisher thread");
    await join(t, scope, room, BOB);
    const reply = await post(t, scope, room, "the kingfisher reply", BOB, {
      parentId: root,
      rootId: root,
    });

    const response = await run(t, scope, { text: "kingfisher reply" });
    const hit = response.hits.find((candidate) => candidate.eventId === reply);
    const destination = resolveSearchHitDestination(hit!);
    expect(destination).not.toBeNull();
    expect(destination?.kind).toBe("message");
    // The link is the one the transcript already parses, and the route it names
    // is `/chat/c/[channelId]`, which exists.
    expect(destination?.href).toBe(
      buildMessageLink({ channelId: room, messageId: reply, threadRootId: root }),
    );
    const parsed = parseMessageLink(destination!.href);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.channelId).toBe(room);
      expect(parsed.value.messageId).toBe(reply);
      expect(parsed.value.threadRootId).toBe(root);
    }
  });
});
