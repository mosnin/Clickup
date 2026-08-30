import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../convex/schema";
import { sha256Hex } from "../convex/_agentAuth";
import { publicKeyFromSecret, verifyEvent } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV, relayPubkeyFor } from "../convex/buzz/relay";
import {
  CHAT_AGENT_IDEMPOTENT_TOOLS,
  CHAT_AGENT_READ_TOOLS,
  CHAT_AGENT_TOOLS,
} from "../src/lib/buzz/agent-chat-tools";

// C6b — the key-authenticated chat surface an agent uses to be a member of a
// room.
//
// What these tests are actually about, in order of how expensive the bug would
// be. **Tenancy**: an agent must not be able to reach a room its scope does not
// contain, and a channel id is a guessable-looking string that arrives from
// outside. **Governance**: the role, the fences and the budgets are
// `_agentAuth`'s, and the point of the tests below is that this file did not
// quietly grow a second copy of any of them — including the ordering property
// that a readonly refusal costs an agent nothing. **Identity**: an agent's
// message must be signed by the agent's own key, because that is what makes
// "who wrote this" answerable from the log forever rather than from a column
// somebody can flip (02-agents §10.3). **One write path**: an agent's message
// has to pick up the mention tags, the thread root and the room clock that a
// person's message picks up, which is only true while both go through the same
// core.

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * The same repair `tests/buzz-search.test.ts` documents at length.
 *
 * convex-test evaluates a search index by scanning every row in the table and
 * applying the declared filters in declaration order, and its text filter calls
 * `.split()` on the field without checking it is there. In real Convex a row
 * with no `searchText` is not in the index at all; in the fake it is scanned
 * like any other row and throws. Reordering the equality filters ahead of the
 * text filter makes the fake short-circuit on rows the real index would never
 * have held — `.every` is order-independent as a predicate, so no row's verdict
 * changes, only whether the double reaches an undefined field before deciding.
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
    // Getters, because convex-test's own global resolves to the *currently
    // running* test's syscall through AsyncLocalStorage.
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
const agentChat = anyApi.buzz.agentChat;
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

// Fixed keys, like every other buzz test: several assertions are about *which*
// pubkey signed something, and a random key makes those pass or fail by the day.
const USER_KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
};
const SCOUT_SECRET = "05".repeat(32);
const READER_SECRET = "06".repeat(32);
const FENCED_SECRET = "07".repeat(32);
const STRANGER_SECRET = "08".repeat(32);
/** Never given a `buzzKeys` row: the agent nobody minted an identity for. */
const MUTE_KEY = "cua_test_mute";

const SCOUT_KEY = "cua_test_scout";
const READER_KEY = "cua_test_reader";
const FENCED_KEY = "cua_test_fenced";
const STRANGER_KEY = "cua_test_stranger";
const REVOKED_KEY = "cua_test_revoked";

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

async function seed() {
  const t = convexTest(schema, modules);
  repairSearchIndexFake();
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
        pubkey: publicKeyFromSecret(USER_KEYS[person.subject]),
        secretKey: USER_KEYS[person.subject],
        createdAt: Date.now(),
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    // A second community, whose only purpose is to be somewhere an Acme agent
    // must not be able to reach.
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Umbrella",
      slug: "umbrella",
      ownerClerkId: BOB.subject,
      createdAt: Date.now(),
    });
    for (const [subject, workspace, role] of [
      [ALICE.subject, workspaceId, "owner"],
      [BOB.subject, workspaceId, "member"],
      [BOB.subject, otherWorkspaceId, "owner"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId: workspace,
        role,
        joinedAt: Date.now(),
      });
    }

    async function agent(
      name: string,
      parentId: string,
      apiKey: string,
      secretKey: string | null,
      extra: Record<string, unknown> = {},
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        ...extra,
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 12),
        createdAt: Date.now(),
      });
      if (secretKey) {
        await ctx.db.insert("buzzKeys", {
          principalType: "agent",
          principalId: agentId,
          pubkey: publicKeyFromSecret(secretKey),
          secretKey,
          createdAt: Date.now(),
        });
      }
      return agentId;
    }

    const scoutId = await agent("Scout", workspaceId, SCOUT_KEY, SCOUT_SECRET);
    const readerId = await agent("Reader", workspaceId, READER_KEY, READER_SECRET, {
      role: "readonly",
    });
    // A list-restricted agent. The list it is allowed to touch is irrelevant to
    // Chat and that is the point: restriction is about the agent, not the room.
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      createdAt: Date.now(),
      position: 0,
    });
    const listId = await ctx.db.insert("lists", {
      name: "Inbox",
      parentType: "space",
      parentId: spaceId,
      createdAt: Date.now(),
      position: 0,
    });
    const fencedId = await agent("Fenced", workspaceId, FENCED_KEY, FENCED_SECRET, {
      allowedListIds: [listId],
    });
    const strangerId = await agent(
      "Stranger",
      otherWorkspaceId,
      STRANGER_KEY,
      STRANGER_SECRET,
    );
    const muteId = await agent("Mute", workspaceId, MUTE_KEY, null);

    // A key that was minted and then taken away. Same agent, so the only thing
    // distinguishing it from a live call is the revocation.
    await ctx.db.insert("agentKeys", {
      agentId: scoutId,
      keyHash: sha256Hex(REVOKED_KEY),
      keyPrefix: REVOKED_KEY.slice(0, 12),
      createdAt: Date.now(),
      revokedAt: Date.now(),
    });

    return {
      workspaceId,
      otherWorkspaceId,
      scoutId,
      readerId,
      fencedId,
      strangerId,
      muteId,
    };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const other: Scope = { scopeType: "workspace", scopeId: ids.otherWorkspaceId };

  const general = await createRoom(t, scope, "general");
  const secret = await createRoom(t, scope, "acquisition", "private");

  return { t, scope, other, general, secret, ...ids };
}

async function createRoom(
  t: ReturnType<typeof convexTest>,
  scope: Scope,
  name: string,
  visibility: "open" | "private" = "open",
): Promise<string> {
  const result = (await t
    .withIdentity(scope.scopeId.startsWith("user") ? ALICE : ALICE)
    .mutation(channels.create, { ...scope, name, visibility })) as {
    channelId: string;
  };
  return result.channelId;
}

/** A human puts an agent in a room — the only way into a private one. */
async function addAgent(
  t: ReturnType<typeof convexTest>,
  scope: Scope,
  channelId: string,
  agentId: string,
  who: { subject: string } = ALICE,
) {
  await t
    .withIdentity(who)
    .mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: agentId, actorType: "agent" }],
    });
}

async function usageCount(
  t: ReturnType<typeof convexTest>,
  agentId: string,
): Promise<number> {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("agentUsage").collect();
    return rows
      .filter((row) => row.agentId === agentId)
      .reduce((total, row) => total + row.count, 0);
  });
}

// ---------------------------------------------------------------------------
// The tenancy fence
// ---------------------------------------------------------------------------

describe("the tenancy fence", () => {
  it("cannot reach a room in another community, however it is asked", async () => {
    const { t, general, strangerId } = await seed();

    // Every surface, because a fence that holds on four of five doors is not a
    // fence. The room resolves under the *key's* community, so an Acme channel
    // id is not "forbidden" to an Umbrella agent — it is not there at all, which
    // is the same answer a room that never existed gets.
    await expect(
      t.query(agentChat.readChannel, { apiKey: STRANGER_KEY, channelId: general }),
    ).rejects.toThrow(/Channel not found/);
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: STRANGER_KEY,
        channelId: general,
        body: "hello from elsewhere",
      }),
    ).rejects.toThrow(/Channel not found/);
    await expect(
      t.mutation(agentChat.joinChannel, { apiKey: STRANGER_KEY, channelId: general }),
    ).rejects.toThrow(/Channel not found/);
    await expect(
      t.mutation(agentChat.react, {
        apiKey: STRANGER_KEY,
        channelId: general,
        targetId: "f".repeat(64),
        emoji: "👍",
      }),
    ).rejects.toThrow(/Channel not found/);

    // And the rail says the same thing: an agent's list is its own community's.
    const rooms = (await t.query(agentChat.listChannels, {
      apiKey: STRANGER_KEY,
    })) as { channelId: string }[];
    expect(rooms.map((room) => room.channelId)).not.toContain(general);
    expect(strangerId).toBeTruthy();
  });

  it("takes the community from the key, not from an argument", async () => {
    const { t, scope, other } = await seed();
    // There is deliberately no scope argument to get wrong: `chat_whoami`
    // reports the community it resolved, and it is the key's.
    const me = (await t.query(agentChat.identity, { apiKey: SCOUT_KEY })) as {
      community: Scope;
    };
    expect(me.community).toEqual(scope);
    const stranger = (await t.query(agentChat.identity, {
      apiKey: STRANGER_KEY,
    })) as { community: Scope };
    expect(stranger.community).toEqual(other);
  });

  it("does not admit that a private room it is not in exists", async () => {
    const { t, secret } = await seed();

    const rooms = (await t.query(agentChat.listChannels, { apiKey: SCOUT_KEY })) as {
      channelId: string;
    }[];
    expect(rooms.map((room) => room.channelId)).not.toContain(secret);

    // "Not found" rather than "forbidden", and the two are indistinguishable on
    // purpose: whether #acquisition exists is itself what a private room keeps.
    await expect(
      t.query(agentChat.readChannel, { apiKey: SCOUT_KEY, channelId: secret }),
    ).rejects.toThrow(/Channel not found/);
    await expect(
      t.mutation(agentChat.joinChannel, { apiKey: SCOUT_KEY, channelId: secret }),
    ).rejects.toThrow(/Channel not found/);
  });

  it("keeps a private room out of search for an agent that is not in it", async () => {
    const { t, scope, secret, general, scoutId } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: secret, body: "pineapple merger" });
    await addAgent(t, scope, general, scoutId);
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: general, body: "pineapple pizza" });

    const found = (await t.query(agentChat.search, {
      apiKey: SCOUT_KEY,
      text: "pineapple",
    })) as { hits: { channelId: string; content: string }[] };

    expect(found.hits.map((hit) => hit.channelId)).toEqual([general]);
    expect(found.hits[0].content).toBe("pineapple pizza");
  });
});

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

describe("governance", () => {
  it("gives a readonly agent every read and no mutation", async () => {
    const { t, scope, general, readerId } = await seed();
    await addAgent(t, scope, general, readerId);
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: general, body: "morning" });

    // Reads: all four, all fine.
    await expect(
      t.query(agentChat.identity, { apiKey: READER_KEY }),
    ).resolves.toMatchObject({ role: "readonly", canWrite: false });
    const rooms = (await t.query(agentChat.listChannels, { apiKey: READER_KEY })) as {
      channelId: string;
    }[];
    expect(rooms.map((room) => room.channelId)).toContain(general);
    const page = (await t.query(agentChat.readChannel, {
      apiKey: READER_KEY,
      channelId: general,
    })) as { events: { content: string }[] };
    expect(page.events.some((event) => event.content === "morning")).toBe(true);
    await expect(
      t.query(agentChat.search, { apiKey: READER_KEY, text: "morning" }),
    ).resolves.toMatchObject({ found: 1 });

    // Mutations: none.
    for (const call of [
      t.mutation(agentChat.postMessage, {
        apiKey: READER_KEY,
        channelId: general,
        body: "here goes",
      }),
      t.mutation(agentChat.react, {
        apiKey: READER_KEY,
        channelId: general,
        targetId: "f".repeat(64),
        emoji: "👍",
      }),
      t.mutation(agentChat.joinChannel, { apiKey: READER_KEY, channelId: general }),
      t.mutation(agentChat.leaveChannel, { apiKey: READER_KEY, channelId: general }),
    ]) {
      await expect(call).rejects.toThrow(/read-only/);
    }
  });

  it("refuses a readonly agent's post before charging it anything", async () => {
    const { t, scope, general, readerId } = await seed();
    await addAgent(t, scope, general, readerId);
    expect(await usageCount(t, readerId)).toBe(0);

    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: READER_KEY,
        channelId: general,
        body: "nope",
      }),
    ).rejects.toThrow(/read-only/);

    // The ordering property, not just the refusal. If the role check ever moved
    // after the counter, a misconfigured agent retrying in a loop would burn a
    // whole day's budget on calls that were never going to be allowed.
    expect(await usageCount(t, readerId)).toBe(0);
  });

  it("lets a readonly agent keep its own bookkeeping", async () => {
    const { t, scope, general, readerId } = await seed();
    await addAgent(t, scope, general, readerId);
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: general, body: "for the record" });

    // Read state and a status are facts about the reader, not changes to the
    // room — and they are unmetered, so neither the role nor the budget applies.
    await expect(
      t.mutation(agentChat.markRead, { apiKey: READER_KEY, channelId: general }),
    ).resolves.toMatchObject({ markedAt: expect.any(Number) });
    await expect(
      t.mutation(agentChat.setStatus, { apiKey: READER_KEY, text: "reading" }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
    expect(await usageCount(t, readerId)).toBe(0);

    // And the marker really moved: the room stops being unread for it.
    const rooms = (await t.query(agentChat.listChannels, { apiKey: READER_KEY })) as {
      channelId: string;
      unread: number;
    }[];
    expect(rooms.find((room) => room.channelId === general)?.unread).toBe(0);
  });

  it("fences a list-restricted agent out of changing its own membership", async () => {
    const { t, scope, general, fencedId } = await seed();

    await expect(
      t.mutation(agentChat.joinChannel, { apiKey: FENCED_KEY, channelId: general }),
    ).rejects.toThrow(/restricted to specific lists/);

    // But a human may still put it in a room, and then it works normally —
    // restriction narrows what an agent may reach for, not what it may be given.
    await addAgent(t, scope, general, fencedId);
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: FENCED_KEY,
        channelId: general,
        body: "reporting in",
      }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
    await expect(
      t.mutation(agentChat.leaveChannel, { apiKey: FENCED_KEY, channelId: general }),
    ).rejects.toThrow(/restricted to specific lists/);
  });

  it("applies the daily budget, and does not reimplement it", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    await t.run(async (ctx: Ctx) => {
      await ctx.db.patch(scoutId, { dailyActionLimit: 1 });
    });

    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "one",
      }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "two",
      }),
    ).rejects.toThrow(/Daily action budget exhausted/);

    // Unmetered calls still work while the work budget is gone: an agent that
    // has hit its limit must still be able to say so.
    await expect(
      t.mutation(agentChat.setStatus, { apiKey: SCOUT_KEY, text: "out of budget" }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
  });

  it("applies the per-minute burst cap", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("agentUsage", {
        agentId: scoutId,
        day: new Date().toISOString().slice(0, 10),
        count: 1,
        minute: new Date().toISOString().slice(0, 16),
        minuteCount: 60,
      });
    });

    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "flood",
      }),
    ).rejects.toThrow(/Rate limited/);
  });

  it("fails closed on a revoked key, and on a paused agent", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);

    // Revoked: reads and writes alike, and the refusal says nothing about which
    // agent the key used to belong to.
    await expect(
      t.query(agentChat.identity, { apiKey: REVOKED_KEY }),
    ).rejects.toThrow(/Invalid API key/);
    await expect(
      t.query(agentChat.readChannel, { apiKey: REVOKED_KEY, channelId: general }),
    ).rejects.toThrow(/Invalid API key/);
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: REVOKED_KEY,
        channelId: general,
        body: "still here?",
      }),
    ).rejects.toThrow(/Invalid API key/);
    await expect(
      t.mutation(agentChat.markRead, { apiKey: REVOKED_KEY, channelId: general }),
    ).rejects.toThrow(/Invalid API key/);
    await expect(
      t.query(agentChat.search, { apiKey: "cua_never_existed", text: "x" }),
    ).rejects.toThrow(/Invalid API key/);

    // A paused agent holds a perfectly valid key and is still stopped — pausing
    // is the switch a human reaches for, so it has to reach the chat surface too.
    await t.run(async (ctx: Ctx) => {
      await ctx.db.patch(scoutId, { status: "paused" });
    });
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "hello",
      }),
    ).rejects.toThrow(/paused/);
    await expect(
      t.query(agentChat.listChannels, { apiKey: SCOUT_KEY }),
    ).rejects.toThrow(/paused/);
  });

  it("refuses an agent nobody minted a Chat identity for", async () => {
    const { t, scope, general, muteId } = await seed();
    // `addMembers` refuses a principal with no signing identity outright — a
    // membership is recorded in the log as a `p` tag and there is no value to
    // put in it. So the row is written by hand, which is the shape a key
    // rotation gone wrong would leave behind: a member with nothing to sign
    // with. The point is that the *write* refuses rather than producing an
    // unsigned or misattributed event.
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("buzzMemberships", {
        ...scope,
        channelId: general,
        actorId: muteId,
        actorType: "agent",
        role: "bot",
        joinedAt: Date.now(),
      });
    });

    // Reading is fine — it has nothing to sign. Writing is not, and the refusal
    // names the human action that fixes it rather than inventing a key: an agent
    // that could summon its own identity is an agent nothing can govern.
    await expect(
      t.query(agentChat.readChannel, { apiKey: MUTE_KEY, channelId: general }),
    ).resolves.toMatchObject({ channelId: general });
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: MUTE_KEY,
        channelId: general,
        body: "can I speak",
      }),
    ).rejects.toThrow(/no Chat signing key/);
    await expect(
      t.query(agentChat.identity, { apiKey: MUTE_KEY }),
    ).resolves.toMatchObject({ pubkey: null });
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("being a member", () => {
  it("reads an open room without joining, and cannot post until it does", async () => {
    const { t, scope, general } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: general, body: "anyone about" });

    const page = (await t.query(agentChat.readChannel, {
      apiKey: SCOUT_KEY,
      channelId: general,
    })) as { joined: boolean };
    expect(page.joined).toBe(false);

    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "me",
      }),
    ).rejects.toThrow(/Join this channel before posting/);

    await expect(
      t.mutation(agentChat.joinChannel, { apiKey: SCOUT_KEY, channelId: general }),
    ).resolves.toEqual({ joined: true });
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "me",
      }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
  });

  it("joins as a bot, which is how the room draws it as an agent", async () => {
    const { t, scope, general, scoutId } = await seed();
    await t.mutation(agentChat.joinChannel, { apiKey: SCOUT_KEY, channelId: general });

    const membership = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzMemberships")
        .filter((q) => q.eq(q.field("actorId"), scoutId))
        .first(),
    );
    expect(membership?.role).toBe("bot");
    expect(membership?.actorType).toBe("agent");

    // Joining twice is the same act, not a second membership.
    await expect(
      t.mutation(agentChat.joinChannel, { apiKey: SCOUT_KEY, channelId: general }),
    ).resolves.toEqual({ joined: false });
    const rooms = (await t.query(agentChat.listChannels, { apiKey: SCOUT_KEY })) as {
      channelId: string;
      memberCount: number;
      joined: boolean;
    }[];
    expect(rooms.find((room) => room.channelId === general)).toMatchObject({
      joined: true,
      memberCount: 2,
    });
    expect(scope).toBeTruthy();
  });

  it("leaves, and stops being able to post", async () => {
    const { t, general } = await seed();
    await t.mutation(agentChat.joinChannel, { apiKey: SCOUT_KEY, channelId: general });
    await expect(
      t.mutation(agentChat.leaveChannel, { apiKey: SCOUT_KEY, channelId: general }),
    ).resolves.toEqual({ left: true, hidden: false });
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "still here",
      }),
    ).rejects.toThrow(/Join this channel before posting/);
  });

  it("works in a private room a human put it in", async () => {
    const { t, scope, secret, scoutId } = await seed();
    await addAgent(t, scope, secret, scoutId);

    const rooms = (await t.query(agentChat.listChannels, { apiKey: SCOUT_KEY })) as {
      channelId: string;
    }[];
    expect(rooms.map((room) => room.channelId)).toContain(secret);
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: secret,
        body: "on it",
      }),
    ).resolves.toMatchObject({ eventId: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// Identity: an agent's words are signed by the agent
// ---------------------------------------------------------------------------

describe("what an agent's message is", () => {
  it("is signed by the agent's own key — not a human's, not the deployment's", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    const { eventId } = (await t.mutation(agentChat.postMessage, {
      apiKey: SCOUT_KEY,
      channelId: general,
      body: "shipping the migration now",
    })) as { eventId: string };

    const row = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzEvents")
        .filter((q) => q.eq(q.field("eventId"), eventId))
        .unique(),
    );
    expect(row).not.toBeNull();

    const agentPubkey = publicKeyFromSecret(SCOUT_SECRET);
    expect(row!.pubkey).toBe(agentPubkey);
    // The three keys it must not be: the human who created it, the human who
    // owns the room, and the community relay. Each of those would make the
    // message unattributable to the agent in the log, forever.
    expect(row!.pubkey).not.toBe(publicKeyFromSecret(USER_KEYS[ALICE.subject]));
    expect(row!.pubkey).not.toBe(publicKeyFromSecret(USER_KEYS[BOB.subject]));
    expect(row!.pubkey).not.toBe(relayPubkeyFor(scope));

    // And it verifies as a real BIP-340 signature over the NIP-01 id, so an
    // event exported from this log stands up outside it.
    expect(
      verifyEvent({
        id: row!.eventId,
        pubkey: row!.pubkey,
        created_at: row!.createdAt,
        kind: row!.kind,
        tags: row!.tags,
        content: row!.content,
        sig: row!.sig,
      }),
    ).toBe(true);

    // The reader is told whose it is without having to resolve a hex string.
    const page = (await t.query(agentChat.readChannel, {
      apiKey: SCOUT_KEY,
      channelId: general,
    })) as { authors: Record<string, { name: string; isAgent: boolean }> };
    expect(page.authors[agentPubkey]).toMatchObject({ name: "Scout", isAgent: true });
  });

  it("picks up the mentions, thread root and room clock a person's message picks up", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);

    // A mention parsed out of the body server-side. This is the single clearest
    // signal that the write went through `postMessageCore` and not around it: an
    // agent surface that built its own event would have no reason to parse prose.
    const { eventId: rootId } = (await t.mutation(agentChat.postMessage, {
      apiKey: SCOUT_KEY,
      channelId: general,
      body: `heads up @[Bob](${BOB.subject}) — deploy at four`,
    })) as { eventId: string };

    const root = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzEvents")
        .filter((q) => q.eq(q.field("eventId"), rootId))
        .unique(),
    );
    const mentioned = root!.tags
      .filter((tag: string[]) => tag[0] === "p")
      .map((tag: string[]) => tag[1]);
    expect(mentioned).toContain(publicKeyFromSecret(USER_KEYS[BOB.subject]));
    // Bob really was woken up, through the same notification path a person's
    // message uses. C12 moved the in-app half of that path from the
    // `notifications` feed into Work's `mentions` queue — the unified inbox —
    // so this asserts the row is there, and `tests/buzz-bridge.test.ts` asserts
    // it is there exactly once.
    const notified = await t.run(async (ctx: Ctx) =>
      ctx.db.query("mentions").collect(),
    );
    expect(
      notified.some(
        (row) =>
          row.mentionedClerkId === BOB.subject && row.parentType === "room",
      ),
    ).toBe(true);

    // A reply's root is derived from its parent, so a reply to a reply stays in
    // one thread rather than starting a second.
    const { eventId: replyId } = (await t.mutation(agentChat.postMessage, {
      apiKey: SCOUT_KEY,
      channelId: general,
      body: "and rolled back at five",
      parentId: rootId,
    })) as { eventId: string };
    const { eventId: deepId } = (await t.mutation(agentChat.postMessage, {
      apiKey: SCOUT_KEY,
      channelId: general,
      body: "no, four thirty",
      parentId: replyId,
    })) as { eventId: string };

    const thread = (await t.query(agentChat.readThread, {
      apiKey: SCOUT_KEY,
      channelId: general,
      rootId,
    })) as { events: { id: string }[] };
    const ids = thread.events.map((event) => event.id);
    expect(ids).toContain(rootId);
    expect(ids).toContain(replyId);
    expect(ids).toContain(deepId);

    // And a root that disagrees with the parent is refused rather than filed
    // under a thread nobody is reading.
    await expect(
      t.mutation(agentChat.postMessage, {
        apiKey: SCOUT_KEY,
        channelId: general,
        body: "wrong thread",
        parentId: replyId,
        rootId: replyId,
      }),
    ).rejects.toThrow(/root does not match/);

    // The room's clock moved, which is what orders the rail.
    const room = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzChannels")
        .filter((q) => q.eq(q.field("channelId"), general))
        .unique(),
    );
    expect(room!.lastActivityAt).toBeGreaterThan(0);
  });

  it("reacts idempotently, and takes it back", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    const { eventId } = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, {
        ...scope,
        channelId: general,
        body: "who wants this one",
      })) as { eventId: string };

    const first = (await t.mutation(agentChat.react, {
      apiKey: SCOUT_KEY,
      channelId: general,
      targetId: eventId,
      emoji: "🙋",
    })) as { eventId: string; added: boolean };
    expect(first.added).toBe(true);

    const second = (await t.mutation(agentChat.react, {
      apiKey: SCOUT_KEY,
      channelId: general,
      targetId: eventId,
      emoji: "🙋",
    })) as { eventId: string; added: boolean };
    expect(second).toEqual({ eventId: first.eventId, added: false });

    await expect(
      t.mutation(agentChat.unreact, {
        apiKey: SCOUT_KEY,
        channelId: general,
        targetId: eventId,
        emoji: "🙋",
      }),
    ).resolves.toEqual({ removed: true });
    await expect(
      t.mutation(agentChat.unreact, {
        apiKey: SCOUT_KEY,
        channelId: general,
        targetId: eventId,
        emoji: "🙋",
      }),
    ).resolves.toEqual({ removed: false });
  });

  it("cannot react to a message in a room it cannot see", async () => {
    const { t, scope, secret, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    const { eventId } = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: secret, body: "the number is 12" })) as {
      eventId: string;
    };

    // Named through a room it *is* in, so the refusal cannot be about the room:
    // this is the probe a reaction would otherwise become.
    await expect(
      t.mutation(agentChat.react, {
        apiKey: SCOUT_KEY,
        channelId: general,
        targetId: eventId,
        emoji: "👀",
      }),
    ).rejects.toThrow(/Message not found/);
  });

  it("publishes a working status as the same kind a person's status is", async () => {
    const { t, scope } = await seed();
    const { eventId } = (await t.mutation(agentChat.setStatus, {
      apiKey: SCOUT_KEY,
      text: "reindexing the archive",
      emoji: "🛠️",
    })) as { eventId: string };

    const row = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("buzzEvents")
        .filter((q) => q.eq(q.field("eventId"), eventId))
        .unique(),
    );
    expect(row!.kind).toBe(30315);
    expect(row!.pubkey).toBe(publicKeyFromSecret(SCOUT_SECRET));
    expect(row!.content).toBe("reindexing the archive");
    expect(row!.tags).toContainEqual(["d", "general"]);

    // Replaceable at one coordinate, which is what makes "setting a status"
    // replace the last one rather than accumulate a history of moods. Asserted
    // on the stored coordinate rather than by publishing twice: `created_at` is
    // in seconds, so a second publish inside the same second is legitimately
    // *dominated* — a real property of the log, not something to sleep past.
    expect(row!.coord).toBe(`30315:${publicKeyFromSecret(SCOUT_SECRET)}:general`);
    expect(scope).toBeTruthy();
  });

  it("reads a room the same way a person does, edits and all", async () => {
    const { t, scope, general, scoutId } = await seed();
    await addAgent(t, scope, general, scoutId);
    const { eventId } = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId: general, body: "ship on tuesady" })) as {
      eventId: string;
    };
    await t
      .withIdentity(ALICE)
      .mutation(messages.edit, {
        ...scope,
        channelId: general,
        targetId: eventId,
        body: "ship on tuesday",
      });

    // The edit travels with the page. A read that only ranged over time would
    // hand back the typo and the agent would answer the wrong sentence.
    const page = (await t.query(agentChat.readChannel, {
      apiKey: SCOUT_KEY,
      channelId: general,
    })) as { events: { kind: number; content: string }[] };
    expect(page.events.some((event) => event.kind === 9 && event.content === "ship on tuesady")).toBe(
      true,
    );
    expect(
      page.events.some((event) => event.kind === 40003 && event.content === "ship on tuesday"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

describe("the MCP catalog", () => {
  const source = readFileSync(
    join(process.cwd(), "convex/buzz/agentChat.ts"),
    "utf8",
  );
  const exported = new Set(
    [
      ...source.matchAll(
        /^export const ([A-Za-z0-9_]+) = (?:query|mutation|action|hostedMcpQuery|hostedMcpMutation)\(/gm,
      ),
    ].map((m) => m[1]),
  );

  it("only advertises tools whose Convex function exists", () => {
    // Guard the guard: a broken scan would pass this vacuously.
    expect(exported.size).toBeGreaterThan(8);
    const referenced = CHAT_AGENT_TOOLS.map((tool) => {
      const body = tool.run.toString();
      const match = /chat\.([A-Za-z0-9_]+)/.exec(body);
      return match?.[1] ?? "";
    });
    expect(referenced.filter((name) => !exported.has(name))).toEqual([]);
  });

  it("advertises every Chat function exactly once, under a namespaced name", () => {
    const names = CHAT_AGENT_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    // `chat_` is not decoration: the Work catalog already has `list_channels`,
    // `read_channel` and `mark_channel_read` for its own channels, and two
    // applications sharing one endpoint (D11) must not share a tool name.
    expect(names.every((name) => name.startsWith("chat_"))).toBe(true);
    expect(names).toHaveLength(exported.size);
  });

  it("classifies reads as reads and nothing else", () => {
    const names = new Set(CHAT_AGENT_TOOLS.map((tool) => tool.name));
    for (const name of [...CHAT_AGENT_READ_TOOLS, ...CHAT_AGENT_IDEMPOTENT_TOOLS]) {
      expect(names.has(name)).toBe(true);
    }
    // A tool cannot be both: `readOnlyHint` says a call has no effect at all,
    // and `idempotentHint` says a call has an effect that repeating is safe.
    for (const name of CHAT_AGENT_READ_TOOLS) {
      expect(CHAT_AGENT_IDEMPOTENT_TOOLS).not.toContain(name);
    }
    // Marking read and setting a status are unmetered, and still writes. A
    // client told they are reads would retry them as freely as a fetch.
    expect(CHAT_AGENT_READ_TOOLS).not.toContain("chat_mark_read");
    expect(CHAT_AGENT_READ_TOOLS).not.toContain("chat_set_status");
  });

  it("is registered on the hosted MCP server", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/[transport]/route.ts"),
      "utf8",
    );
    expect(route).toContain("CHAT_AGENT_TOOLS");
    expect(route).toContain("TOOLS.push(...CHAT_AGENT_TOOLS)");
    expect(route).toContain("READ_TOOLS.add(name)");
  });
});
