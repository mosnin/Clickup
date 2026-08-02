import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret, verifyEvent } from "../convex/buzz/_nostr";
import { sha256Hex } from "../convex/_agentAuth";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { TURN_ABANDON_AFTER_MS, TURN_STALE_AFTER_MS, turnIsLive } from "../src/lib/buzz/turn";

// `anyApi` rather than the generated `api`, for the reason every other
// `tests/buzz-*.test.ts` states: `convex/_generated/api.d.ts` is a hand-rolled
// stub that predates `convex/buzz/*`, and only `npx convex dev` may rewrite it.
// The references resolve identically at runtime.
const modules = import.meta.glob("../convex/**/*.*s");
const agents = anyApi.buzz.agents;
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
/** In the workspace, never opens Chat, so never has a signing key. */
const DANA = { subject: "user_dana" };

// Fixed keys: several assertions are about *which* pubkey signed something, and
// a random key makes those pass or fail by the day.
const USER_KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
};
const AGENT_KEYS: Record<string, string> = {
  scout: "11".repeat(32),
  reader: "12".repeat(32),
  fenced: "13".repeat(32),
  paused: "14".repeat(32),
  foreign: "15".repeat(32),
};

/** The plaintext API keys. Only their SHA-256 is stored, as in production. */
const API_KEYS: Record<string, string> = {
  scout: "cua_scout_test_key",
  reader: "cua_reader_test_key",
  fenced: "cua_fenced_test_key",
  paused: "cua_paused_test_key",
  foreign: "cua_foreign_test_key",
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = Awaited<ReturnType<typeof seed>>;

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
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, DANA]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      const secretKey = USER_KEYS[person.subject];
      if (!secretKey) continue;
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: publicKeyFromSecret(secretKey),
        secretKey,
        createdAt: Date.now(),
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Rival",
      slug: "rival",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
      [DANA.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });

    // A real list, because `allowedListIds` is `v.id("lists")` and the fence
    // under test has to be the fence production uses.
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Backlog",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });

    async function makeAgent(
      slug: keyof typeof AGENT_KEYS,
      name: string,
      overrides: Record<string, unknown> = {},
      parent: { parentType: "workspace"; parentId: string } = {
        parentType: "workspace",
        parentId: workspaceId,
      },
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        ...parent,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        ...overrides,
      });
      const secretKey = AGENT_KEYS[slug];
      await ctx.db.insert("buzzKeys", {
        principalType: "agent",
        principalId: agentId,
        pubkey: publicKeyFromSecret(secretKey),
        secretKey,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(API_KEYS[slug]),
        keyPrefix: API_KEYS[slug].slice(0, 8),
        createdAt: Date.now(),
      });
      return agentId;
    }

    const scoutId = await makeAgent("scout", "Scout");
    const readerId = await makeAgent("reader", "Reader", { role: "readonly" });
    const fencedId = await makeAgent("fenced", "Fenced", { allowedListIds: [listId] });
    const pausedId = await makeAgent("paused", "Paused", { status: "paused" });
    const foreignId = await makeAgent("foreign", "Foreign", {}, {
      parentType: "workspace",
      parentId: otherWorkspaceId,
    });

    // An agent that has never been given a Chat identity: the bootstrap gap,
    // which attach has to answer rather than paper over.
    const keylessId = await ctx.db.insert("agents", {
      name: "Keyless",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });

    return {
      workspaceId,
      otherWorkspaceId,
      scoutId,
      readerId,
      fencedId,
      pausedId,
      foreignId,
      keylessId,
    };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const channelId = (
    (await t.withIdentity(ALICE).mutation(channels.create, {
      ...scope,
      name: "engineering",
    })) as { channelId: string }
  ).channelId;

  return { t, scope, channelId, ...ids };
}

function agentPubkey(slug: keyof typeof AGENT_KEYS): string {
  return publicKeyFromSecret(AGENT_KEYS[slug]);
}

function userPubkey(person: { subject: string }): string {
  return publicKeyFromSecret(USER_KEYS[person.subject]);
}

async function attachScout(h: Harness) {
  return await h.t.withIdentity(ALICE).mutation(agents.attach, {
    ...h.scope,
    channelId: h.channelId,
    agentId: h.scoutId,
  });
}

async function startScoutTurn(
  h: Harness,
  args: Record<string, unknown> = {},
): Promise<{ turnId: string; started: boolean; resumed: boolean; state: string }> {
  return (await h.t.mutation(agents.startTurn, {
    apiKey: API_KEYS.scout,
    ...h.scope,
    channelId: h.channelId,
    ...args,
  })) as { turnId: string; started: boolean; resumed: boolean; state: string };
}

/** Reach in and age a turn, which is the only way to test decay in a test. */
async function ageTurn(h: Harness, turnId: string, by: number) {
  await h.t.run(async (ctx: Ctx) => {
    const row = await ctx.db
      .query("buzzTurns")
      .filter((q) => q.eq(q.field("turnId"), turnId))
      .unique();
    if (!row) throw new Error("no such turn");
    await ctx.db.patch(row._id, {
      startedAt: row.startedAt - by,
      lastActivityAt: row.lastActivityAt - by,
    });
  });
}

// ---------------------------------------------------------------------------
// An agent as a member
// ---------------------------------------------------------------------------

describe("an agent joins a room the way a person does", () => {
  it("appears in the member list beside people, under its own name", async () => {
    const h = await seed();
    await attachScout(h);

    const members = (await h.t
      .withIdentity(ALICE)
      .query(channels.members, { ...h.scope, channelId: h.channelId })) as {
      actorId: string;
      actorType: string;
      role: string;
      name: string;
    }[];

    const scout = members.find((m) => m.actorId === h.scoutId);
    expect(scout).toBeDefined();
    // The same list, resolved by the same query, with a real name — not a panel
    // about machines.
    expect(scout?.actorType).toBe("agent");
    expect(scout?.name).toBe("Scout");
    // `bot` is Buzz's default role and a *role*, not a synonym for being an
    // agent: it can be promoted through the ordinary setRole path.
    expect(scout?.role).toBe("bot");
    expect(members.some((m) => m.actorId === ALICE.subject)).toBe(true);
  });

  it("is written into the log as a membership event, not just a row", async () => {
    const h = await seed();
    await attachScout(h);

    const events = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzEvents").collect(),
    );
    const namesScout = (event: { tags: string[][] }) =>
      event.tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey("scout"));
    // 9000 = NIP-29 put-user, the same event a person's addition writes — the
    // room's own creation wrote one for Alice a moment earlier, through the
    // same mutation.
    const put = events.filter((e) => e.kind === 9000 && namesScout(e));
    expect(put).toHaveLength(1);
    expect(put[0].pubkey).toBe(userPubkey(ALICE));
    // And the relay-signed member notification the harness auto-discovers new
    // channel membership from (44100), addressed to the agent.
    const notified = events.filter((e) => e.kind === 44100 && namesScout(e));
    expect(notified).toHaveLength(1);
  });

  it("is idempotent, and never produces a second membership", async () => {
    const h = await seed();
    const first = await attachScout(h);
    const second = await attachScout(h);
    expect(first).toMatchObject({ attached: true, alreadyAttached: false });
    expect(second).toMatchObject({ attached: false, alreadyAttached: true });

    const rows = await h.t.run(async (ctx: Ctx) =>
      await ctx.db
        .query("buzzMemberships")
        .filter((q) => q.eq(q.field("actorId"), h.scoutId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("re-attaching after a detach reverses the removal rather than duplicating it", async () => {
    const h = await seed();
    await attachScout(h);
    await h.t
      .withIdentity(ALICE)
      .mutation(agents.detach, { ...h.scope, channelId: h.channelId, agentId: h.scoutId });
    await attachScout(h);

    const rows = await h.t.run(async (ctx: Ctx) =>
      await ctx.db
        .query("buzzMemberships")
        .filter((q) => q.eq(q.field("actorId"), h.scoutId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].removedAt).toBeUndefined();
  });

  it("detaching is idempotent too, and soft", async () => {
    const h = await seed();
    await attachScout(h);
    const first = await h.t
      .withIdentity(ALICE)
      .mutation(agents.detach, { ...h.scope, channelId: h.channelId, agentId: h.scoutId });
    const second = await h.t
      .withIdentity(ALICE)
      .mutation(agents.detach, { ...h.scope, channelId: h.channelId, agentId: h.scoutId });
    expect(first).toMatchObject({ detached: true });
    expect(second).toMatchObject({ detached: false, alreadyDetached: true });

    // Soft: "Scout was in this room until Tuesday" stays answerable.
    const rows = await h.t.run(async (ctx: Ctx) =>
      await ctx.db
        .query("buzzMemberships")
        .filter((q) => q.eq(q.field("actorId"), h.scoutId))
        .collect(),
    );
    expect(rows[0].removedAt).toBeGreaterThan(0);
  });
});

describe("an agent cannot be put where it does not belong", () => {
  it("refuses an agent from another community", async () => {
    const h = await seed();
    // The identity fence, and the reason an agent cannot reach a room it cannot
    // see: a room lives in a community and an agent belongs to exactly one.
    await expect(
      h.t.withIdentity(ALICE).mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.foreignId,
      }),
    ).rejects.toThrow(/does not belong to that community/);
  });

  it("refuses a list-restricted agent, and says what a list fence cannot describe", async () => {
    const h = await seed();
    await expect(
      h.t.withIdentity(ALICE).mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.fencedId,
      }),
    ).rejects.toThrow(/cannot describe a room/);
  });

  it("refuses a paused agent", async () => {
    const h = await seed();
    await expect(
      h.t.withIdentity(ALICE).mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.pausedId,
      }),
    ).rejects.toThrow(/paused/);
  });

  it("refuses an agent with no signing identity, and names the call that mints one", async () => {
    const h = await seed();
    await expect(
      h.t.withIdentity(ALICE).mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.keylessId,
      }),
    ).rejects.toThrow(/buzz\.keys\.mint/);
  });

  it("refuses somebody who is not in the room, and does not admit the room exists", async () => {
    const h = await seed();
    // Bob is in the workspace but has not joined this channel. An open room is
    // readable, so he gets the join refusal; a private one would answer
    // "not found" from `requireChannelAccess` before this point.
    await expect(
      h.t.withIdentity(BOB).mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.scoutId,
      }),
    ).rejects.toThrow(/Join this channel/);
  });

  it("refuses an unauthenticated caller outright", async () => {
    const h = await seed();
    await expect(
      h.t.mutation(agents.attach, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.scoutId,
      }),
    ).rejects.toThrow();
  });

  it("has no key-authenticated way in at all", async () => {
    const h = await seed();
    // The mechanical form of "an agent must not be able to summon its own
    // access": the membership half of this module accepts no `apiKey`, so an
    // agent holding a perfectly valid key has no argument to put it in. The
    // validator refuses the field rather than ignoring it.
    await expect(
      h.t.mutation(agents.attach, {
        apiKey: API_KEYS.scout,
        ...h.scope,
        channelId: h.channelId,
        agentId: h.scoutId,
      }),
    ).rejects.toThrow();
  });
});

describe("mentionability", () => {
  it("offers an attached, active agent and nobody else", async () => {
    const h = await seed();
    await attachScout(h);
    const offered = (await h.t
      .withIdentity(ALICE)
      .query(agents.mentionable, { ...h.scope, channelId: h.channelId })) as {
      agentId: string;
      name: string;
      pubkey: string;
    }[];
    expect(offered.map((a) => a.name)).toEqual(["Scout"]);
    expect(offered[0].pubkey).toBe(agentPubkey("scout"));
  });

  it("drops an agent that was paused after it joined", async () => {
    const h = await seed();
    await attachScout(h);
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.scoutId, { status: "paused" });
    });
    const offered = (await h.t
      .withIdentity(ALICE)
      .query(agents.mentionable, { ...h.scope, channelId: h.channelId })) as unknown[];
    // Pausing has to mean the runtime stops being asked. It stays a member —
    // it is still in the room — but a mention would ping it.
    expect(offered).toEqual([]);
    const members = (await h.t
      .withIdentity(ALICE)
      .query(channels.members, { ...h.scope, channelId: h.channelId })) as {
      actorId: string;
    }[];
    expect(members.some((m) => m.actorId === h.scoutId)).toBe(true);
  });

  it("hands a mention to the one ping path the app already has", async () => {
    const h = await seed();
    await attachScout(h);
    await h.t.withIdentity(ALICE).mutation(messages.post, {
      ...h.scope,
      channelId: h.channelId,
      body: `Can you take this, @[Scout](${h.scoutId})?`,
    });

    const deliveries = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("agentPingDeliveries").collect(),
    );
    // Not a second mechanism: `enqueueAgentPingDelivery` is the HMAC-signed,
    // SSRF-guarded path a task mention takes, and a mention in a room takes it
    // too. Nothing in convex/buzz/agents.ts re-parses a mention.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      agentId: h.scoutId,
      sourceKind: "mention",
      type: "chat.mention",
    });
    // No `notifyUrl` on this agent, so the receipt is the poll path rather than
    // a push — which is how an agent that polls over MCP still finds out.
    expect(deliveries[0].status).toBe("poll_required");
  });

  it("does not offer an agent in a room it is not in", async () => {
    const h = await seed();
    const otherChannelId = (
      (await h.t
        .withIdentity(ALICE)
        .mutation(channels.create, { ...h.scope, name: "design" })) as {
        channelId: string;
      }
    ).channelId;
    await attachScout(h);
    const offered = (await h.t
      .withIdentity(ALICE)
      .query(agents.mentionable, { ...h.scope, channelId: otherChannelId })) as unknown[];
    expect(offered).toEqual([]);
  });
});

describe("the attachable list", () => {
  it("shows every agent with the reason it cannot be added", async () => {
    const h = await seed();
    const rows = (await h.t
      .withIdentity(ALICE)
      .query(agents.attachable, { ...h.scope, channelId: h.channelId })) as {
      name: string;
      blockedReason: string | null;
      hasKey: boolean;
    }[];
    const byName = new Map(rows.map((r) => [r.name, r]));
    // An agent missing from a picker is indistinguishable from one that does
    // not exist, and both blocks below are fixable in ten seconds by somebody
    // who is told about them.
    expect(byName.get("Scout")?.blockedReason).toBeNull();
    expect(byName.get("Fenced")?.blockedReason).toMatch(/Restricted/);
    expect(byName.get("Paused")?.blockedReason).toBe("Paused");
    expect(byName.get("Keyless")?.blockedReason).toMatch(/No Chat identity/);
    expect(byName.get("Keyless")?.hasKey).toBe(false);
    // Another community's agent is not in this community's list at all.
    expect(byName.has("Foreign")).toBe(false);
  });

  it("puts the agent you should reuse first", async () => {
    const h = await seed();
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.scoutId, { lastSeenAt: Date.now() });
    });
    const rows = (await h.t
      .withIdentity(ALICE)
      .query(agents.attachable, { ...h.scope, channelId: h.channelId })) as {
      name: string;
    }[];
    // Buzz's reuse guardrail, reduced to what our model has: offer the agent
    // that already exists and has been heard from, so nobody makes a second one.
    expect(rows[0].name).toBe("Scout");
  });
});

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

describe("governance is requireAgentByKey's, not this module's", () => {
  it("refuses a read-only agent", async () => {
    const h = await seed();
    await h.t.withIdentity(ALICE).mutation(agents.attach, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.readerId,
    });
    await expect(
      h.t.mutation(agents.startTurn, {
        apiKey: API_KEYS.reader,
        ...h.scope,
        channelId: h.channelId,
      }),
    ).rejects.toThrow(/read-only/);
  });

  it("refuses a list-restricted agent even if it somehow got into the room", async () => {
    const h = await seed();
    // Attach it while unfenced, then fence it: a restriction added afterwards
    // has to bite without anybody remembering to detach.
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.fencedId, { allowedListIds: undefined });
    });
    await h.t.withIdentity(ALICE).mutation(agents.attach, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.fencedId,
    });
    const listId = await h.t.run(async (ctx: Ctx) => {
      const list = await ctx.db.query("lists").first();
      return list!._id;
    });
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.fencedId, { allowedListIds: [listId] });
    });

    await expect(
      h.t.mutation(agents.startTurn, {
        apiKey: API_KEYS.fenced,
        ...h.scope,
        channelId: h.channelId,
      }),
    ).rejects.toThrow(/cannot describe a room/);
  });

  it("refuses a paused agent's key", async () => {
    const h = await seed();
    await expect(
      h.t.mutation(agents.startTurn, {
        apiKey: API_KEYS.paused,
        ...h.scope,
        channelId: h.channelId,
      }),
    ).rejects.toThrow(/paused/i);
  });

  it("spends the daily budget, and stops when it is gone", async () => {
    const h = await seed();
    await attachScout(h);
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.scoutId, { dailyActionLimit: 1 });
    });

    await startScoutTurn(h, { turnId: "t1" });
    // The counter is `agentUsage` — the same row every other agent mutation in
    // the product counts against. There is no second budget for Chat.
    const usage = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("agentUsage").collect(),
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].count).toBe(1);

    await expect(startScoutTurn(h, { turnId: "t2" })).rejects.toThrow(/Daily action budget/);
  });

  it("stops a runaway harness at the burst cap", async () => {
    const h = await seed();
    await attachScout(h);
    const minute = new Date().toISOString().slice(0, 16);
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.insert("agentUsage", {
        agentId: h.scoutId,
        day: new Date().toISOString().slice(0, 10),
        count: 1,
        minute,
        minuteCount: 60,
      });
    });
    await expect(startScoutTurn(h, { turnId: "t1" })).rejects.toThrow(/Rate limited/);
  });

  it("never spends the budget on reporting what it is already doing", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    await h.t.run(async (ctx: Ctx) => {
      await ctx.db.patch(h.scoutId, { dailyActionLimit: 1 });
    });

    // The budget is exhausted, and the turn can still say it is alive and still
    // say how it ended. A refusal here would leave a spinner running forever,
    // caused by the governance that was supposed to contain the agent.
    await h.t.mutation(agents.streamTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId,
      narration: "reading the thread",
    });
    const finished = await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId,
      outcome: "finished",
    });
    expect(finished).toMatchObject({ applied: true, state: "finished" });
  });

  it("refuses a turn in a room the agent is not in, without admitting it exists", async () => {
    const h = await seed();
    await expect(
      startScoutTurn(h, { turnId: "t1" }),
    ).rejects.toThrow(/Channel not found/);
  });

  it("refuses a turn in another community", async () => {
    const h = await seed();
    await attachScout(h);
    await expect(
      h.t.mutation(agents.startTurn, {
        apiKey: API_KEYS.foreign,
        ...h.scope,
        channelId: h.channelId,
      }),
    ).rejects.toThrow(/does not belong to that community/);
  });

  it("answers another agent's turn id with 'not found'", async () => {
    const h = await seed();
    await attachScout(h);
    await h.t.withIdentity(ALICE).mutation(agents.attach, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.readerId,
    });
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    // Existence is information, and a turn id is guessable when a harness
    // numbers its turns from one.
    await expect(
      h.t.mutation(agents.streamTurn, {
        apiKey: API_KEYS.reader,
        ...h.scope,
        channelId: h.channelId,
        turnId,
      }),
    ).rejects.toThrow(/Turn not found/);
  });
});

describe("the turn record", () => {
  it("derives an unforgeable turn id when the harness has none", async () => {
    const h = await seed();
    await attachScout(h);
    const started = await startScoutTurn(h);
    // The id of the event that announced it — a hash, so it is unique and
    // uncollidable, the same trick a room's id uses.
    expect(started.turnId).toMatch(/^[0-9a-f]{64}$/);
    expect(started.started).toBe(true);
  });

  it("is idempotent on restart, and never rewinds", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.streamTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
    });
    const again = await startScoutTurn(h, { turnId: "t1" });
    expect(again).toMatchObject({ started: false, resumed: true, state: "streaming" });
  });

  it("refuses to restart a turn that already ended", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "finished",
    });
    await expect(startScoutTurn(h, { turnId: "t1" })).rejects.toThrow(/already finished/);
  });

  it("treats a second completion as a no-op rather than an error", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "finished",
    });
    // A harness that retried a completion must not be pushed into a retry loop
    // by an error it cannot avoid.
    const second = await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "failed",
      error: "late",
    });
    expect(second).toMatchObject({ applied: false, state: "finished" });
    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    expect(row?.state).toBe("finished");
    expect(row?.error).toBeUndefined();
  });

  it("records a failure with its reason and its cost", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "failed",
      error: "model refused",
      tokensUsed: 1234,
      costUsd: 0.02,
    });
    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    expect(row).toMatchObject({
      state: "failed",
      error: "model refused",
      tokensUsed: 1234,
      costUsd: 0.02,
    });
    expect(row?.endedAt).toBeGreaterThanOrEqual(row!.startedAt);
  });

  it("keeps the narration to one line", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.streamTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      narration: `${"x".repeat(400)}\nsecond line`,
    });
    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    // Clamped rather than refused: a harness pasting a stack trace has made a
    // display mistake, not an error worth failing a turn over.
    expect(row!.narration!.length).toBeLessThanOrEqual(280);
    expect(row!.narration).not.toContain("\n");
  });
});

describe("every write the agent makes is signed by the agent's own key", () => {
  it("signs the turn's working signal and its record, never as the human", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId,
      outcome: "finished",
      tokensUsed: 10,
    });

    const events = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzEvents").collect(),
    );
    // 44200 is the durable per-turn record (NIP-AM). It is authored by the
    // agent, not by whoever asked — which is the whole model: an agent is
    // scoped by identity, so its work is distinguishable forever, in the log,
    // without trusting a boolean column.
    const metric = events.filter((e) => e.kind === 44200);
    expect(metric).toHaveLength(1);
    expect(metric[0].pubkey).toBe(agentPubkey("scout"));
    expect(metric[0].pubkey).not.toBe(userPubkey(ALICE));
    expect(verifyEvent({
      id: metric[0].eventId,
      pubkey: metric[0].pubkey,
      created_at: metric[0].createdAt,
      kind: metric[0].kind,
      tags: metric[0].tags,
      content: metric[0].content,
      sig: metric[0].sig,
    })).toBe(true);
    // p-gated to the agent itself: a turn record carries how long an agent
    // worked and what it cost, which is not the room's business.
    expect(metric[0].tags).toContainEqual(["p", agentPubkey("scout")]);
    expect(JSON.parse(metric[0].content)).toMatchObject({
      turn_id: "t1",
      state: "finished",
      tokens_used: 10,
    });

    // The row agrees about whose key it was, and the row is what the UI reads.
    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    expect(row?.agentPubkey).toBe(agentPubkey("scout"));
    expect(row?.lastEventId).toBe(metric[0].eventId);
  });

  it("names whoever asked on the receipt, and nobody else", async () => {
    const h = await seed();
    await attachScout(h);
    const posted = (await h.t.withIdentity(ALICE).mutation(messages.post, {
      ...h.scope,
      channelId: h.channelId,
      body: `@[Scout](${h.scoutId}) please look`,
    })) as { eventId: string };

    await startScoutTurn(h, { turnId: "t1", triggerEventId: posted.eventId });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "finished",
    });

    const metric = await h.t.run(async (ctx: Ctx) => {
      const rows = await ctx.db.query("buzzEvents").collect();
      return rows.find((e) => e.kind === 44200)!;
    });
    const named = metric.tags.filter((t: string[]) => t[0] === "p").map((t: string[]) => t[1]);
    // You asked for the work, so the receipt is yours. Two names, and no more.
    expect(named.sort()).toEqual([agentPubkey("scout"), userPubkey(ALICE)].sort());
  });

  it("does not store a beat per heartbeat", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    const before = await h.t.run(async (ctx: Ctx) =>
      (await ctx.db.query("buzzEvents").collect()).length,
    );
    for (let i = 0; i < 5; i += 1) {
      await h.t.mutation(agents.streamTurn, {
        apiKey: API_KEYS.scout,
        ...h.scope,
        channelId: h.channelId,
        turnId,
      });
    }
    const after = await h.t.run(async (ctx: Ctx) =>
      (await ctx.db.query("buzzEvents").collect()).length,
    );
    // 20002 is ephemeral by kind number, which is exactly why Buzz picked it:
    // a beat every ten seconds for the length of a turn would otherwise be
    // thousands of rows saying "still here".
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The working signal
// ---------------------------------------------------------------------------

describe("the working signal the room draws", () => {
  it("is off until an agent starts, and on while it works", async () => {
    const h = await seed();
    await attachScout(h);
    const quiet = (await h.t
      .withIdentity(ALICE)
      .query(agents.working, { ...h.scope, channelId: h.channelId })) as {
      working: boolean;
      agents: unknown[];
    };
    expect(quiet).toMatchObject({ working: false, agents: [] });

    await startScoutTurn(h, { turnId: "t1" });
    const busy = (await h.t
      .withIdentity(ALICE)
      .query(agents.working, { ...h.scope, channelId: h.channelId })) as {
      working: boolean;
      agents: { agentId: string; agentName?: string; anchorAt: number }[];
      anchorAt: number | null;
    };
    expect(busy.working).toBe(true);
    expect(busy.agents).toHaveLength(1);
    expect(busy.agents[0]).toMatchObject({ agentId: h.scoutId, agentName: "Scout" });
    expect(busy.anchorAt).toBe(busy.agents[0].anchorAt);
  });

  it("goes off the moment the turn ends", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "finished",
    });
    const after = (await h.t
      .withIdentity(ALICE)
      .query(agents.working, { ...h.scope, channelId: h.channelId })) as { working: boolean };
    expect(after.working).toBe(false);
  });

  it("stops reading as live when the harness goes quiet, with nothing written", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    await ageTurn(h, turnId, TURN_STALE_AFTER_MS + 1_000);

    const signal = (await h.t
      .withIdentity(ALICE)
      .query(agents.working, { ...h.scope, channelId: h.channelId })) as { working: boolean };
    expect(signal.working).toBe(false);

    // But the turn is still *there*, and still says what it is: a crashed
    // harness has to read as something, not vanish.
    const turns = (await h.t
      .withIdentity(ALICE)
      .query(agents.turnsFor, { ...h.scope, channelId: h.channelId })) as {
      liveness: string;
      state: string;
    }[];
    expect(turns).toHaveLength(1);
    expect(turns[0].state).toBe("started");
    expect(turns[0].liveness).toBe("stalled");

    // Nothing was written to make that true — the row's state never changed.
    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    expect(row?.state).toBe("started");
    expect(row?.endedAt).toBeUndefined();
  });

  it("drops an abandoned turn out of the read entirely, with no sweeper", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    await ageTurn(h, turnId, TURN_ABANDON_AFTER_MS + 1_000);

    const turns = (await h.t
      .withIdentity(ALICE)
      .query(agents.turnsFor, { ...h.scope, channelId: h.channelId })) as unknown[];
    // The index range is the sweeper. No cron whose failure looks like an agent
    // working very hard for three days.
    expect(turns).toEqual([]);
  });

  it("hands the client raw turns so its own clock can tick", async () => {
    const h = await seed();
    await attachScout(h);
    const { turnId } = await startScoutTurn(h, { turnId: "t1" });
    const turns = (await h.t
      .withIdentity(ALICE)
      .query(agents.turnsFor, { ...h.scope, channelId: h.channelId })) as {
      turnId: string;
      startedAt: number;
      lastActivityAt: number;
      state: "started";
      channelId: string;
      agentId: string;
      agentPubkey: string;
    }[];
    expect(turns[0].turnId).toBe(turnId);
    // A Convex query re-runs when data changes, not when time passes, so the
    // same rule has to be runnable on the client. Same function, same answer.
    expect(turnIsLive(turns[0], turns[0].lastActivityAt)).toBe(true);
    expect(turnIsLive(turns[0], turns[0].lastActivityAt + TURN_STALE_AFTER_MS)).toBe(false);
  });

  it("does not show a room's turns to somebody outside the community", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await expect(
      h.t
        .withIdentity({ subject: "user_outsider" })
        .query(agents.working, { ...h.scope, channelId: h.channelId }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("a person can stop a turn", () => {
  it("moves the record to cancelled and records who did it", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });

    const result = await h.t.withIdentity(ALICE).mutation(agents.cancelTurn, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.scoutId,
      turnId: "t1",
    });
    expect(result).toMatchObject({ applied: true, state: "cancelled" });

    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    expect(row).toMatchObject({ state: "cancelled", cancelledByActorId: ALICE.subject });
  });

  it("leaves a durable record in the room, signed by the person", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.withIdentity(ALICE).mutation(agents.cancelTurn, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.scoutId,
      turnId: "t1",
    });

    const events = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzEvents").collect(),
    );
    const audit = events.filter((e) => e.kind === 48001);
    expect(audit).toHaveLength(1);
    // A person reached into an agent's work and stopped it. That is exactly the
    // class of act that most needs a record, and the control frame the harness
    // listens for is ephemeral by design.
    expect(audit[0].pubkey).toBe(userPubkey(ALICE));
    expect(audit[0].channelId).toBe(h.channelId);
    expect(JSON.parse(audit[0].content)).toMatchObject({
      type: "turn_cancelled",
      turn_id: "t1",
      agent: agentPubkey("scout"),
    });
    // And the control frame itself left no row: 24200 is ephemeral, which is
    // why the audit entry above has to exist.
    expect(events.some((e) => e.kind === 24200)).toBe(false);
  });

  it("turns the agent's later completion into a no-op", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.withIdentity(ALICE).mutation(agents.cancelTurn, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.scoutId,
      turnId: "t1",
    });
    const late = await h.t.mutation(agents.finishTurn, {
      apiKey: API_KEYS.scout,
      ...h.scope,
      channelId: h.channelId,
      turnId: "t1",
      outcome: "finished",
    });
    expect(late).toMatchObject({ applied: false, state: "cancelled" });
  });

  it("refuses a liveness beat from a harness that did not get the message", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t.withIdentity(ALICE).mutation(agents.cancelTurn, {
      ...h.scope,
      channelId: h.channelId,
      agentId: h.scoutId,
      turnId: "t1",
    });
    // A frame already on the wire when the turn was cancelled must not
    // resurrect it. A completion is authoritative and outlives what follows.
    await expect(
      h.t.mutation(agents.streamTurn, {
        apiKey: API_KEYS.scout,
        ...h.scope,
        channelId: h.channelId,
        turnId: "t1",
      }),
    ).rejects.toThrow(/already cancelled/);
  });

  it("refuses somebody who is not in the room", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await expect(
      h.t.withIdentity(BOB).mutation(agents.cancelTurn, {
        ...h.scope,
        channelId: h.channelId,
        agentId: h.scoutId,
        turnId: "t1",
      }),
    ).rejects.toThrow(/not in this channel/);
  });

  it("does not cancel a turn just because the agent was detached", async () => {
    const h = await seed();
    await attachScout(h);
    await startScoutTurn(h, { turnId: "t1" });
    await h.t
      .withIdentity(ALICE)
      .mutation(agents.detach, { ...h.scope, channelId: h.channelId, agentId: h.scoutId });

    const row = await h.t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzTurns").unique(),
    );
    // A turn running on somebody else's machine does not stop because a row
    // changed, so claiming it did would be a claim the server cannot back. The
    // record decays on its own instead.
    expect(row?.state).toBe("started");
  });
});
