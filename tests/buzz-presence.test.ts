import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS as BACKEND_HEARTBEAT_MS,
  PRESENCE_TTL_MS as BACKEND_TTL_MS,
  buzzRoomChannel,
  communitySurfaceId,
} from "../convex/buzz/presence";
import {
  EMPTY_TYPING_STATE,
  IDLE_TYPING_CLOCK,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_IDLE_TIMEOUT_MS,
  PRESENCE_TTL_HEARTBEATS,
  PRESENCE_TTL_MS,
  STATUS_DURATIONS,
  TYPING_POST_MESSAGE_SUPPRESS_MS,
  TYPING_SEND_INTERVAL_MS,
  TYPING_TTL_MS,
  USER_STATUS_PRESETS,
  activeUserStatus,
  isEmojiShortcode,
  missedHeartbeatsTolerated,
  newerUserStatus,
  noteMessageFrom,
  noteMessageSent,
  normalizeStatusDraft,
  parsePresencePreference,
  parsePresenceState,
  parseUserStatusEvent,
  presenceFromHeartbeat,
  presenceIsLive,
  pruneTyping,
  receiveTypingSignal,
  resolveAutomaticPresenceStatus,
  resolvePreferredStatus,
  shouldSendTyping,
  typingIn,
  typingKey,
  typingLabel,
  userStatusExpired,
  type TypingState,
} from "../src/lib/buzz/presence";

// `anyApi` for the same reason every other buzz suite gives: the checked-in
// `convex/_generated/api.d.ts` is a stub that predates `convex/buzz/*`, and the
// references resolve identically at runtime through convex-test's glob.
const modules = import.meta.glob("../convex/**/*.*s");
const presence = anyApi.buzz.presence;

const NOW = 1_800_000_000_000;

// ===========================================================================
// The pure rules — this is the part that is worth testing hard
// ===========================================================================

describe("the TTL / heartbeat ratio", () => {
  it("is exactly three heartbeat windows", () => {
    // 06-protocol §14 and §16.22. Written as an assertion rather than a
    // comment because it is the only thing standing between "presence is
    // reliable" and "presence flickers on a bad minute of wifi".
    expect(PRESENCE_TTL_HEARTBEATS).toBe(3);
    expect(PRESENCE_TTL_MS).toBe(3 * PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(PRESENCE_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(PRESENCE_TTL_MS).toBe(180_000);
  });

  it("does NOT change state when one beat is missed", () => {
    // The whole point of the ratio. A client that published at T and whose
    // next publish was dropped is seen again at T+2 windows; it must still be
    // online at that moment, and with room to spare.
    const oneMissed = { state: "online", updatedAt: NOW - 2 * PRESENCE_HEARTBEAT_INTERVAL_MS };
    expect(presenceIsLive(oneMissed.updatedAt, NOW)).toBe(true);
    expect(presenceFromHeartbeat(oneMissed, NOW)).toBe("online");

    // And an away client that misses one is still away, not offline — the
    // ratio must not quietly convert one state into another either.
    expect(
      presenceFromHeartbeat(
        { state: "away", updatedAt: NOW - 2 * PRESENCE_HEARTBEAT_INTERVAL_MS },
        NOW,
      ),
    ).toBe("away");

    expect(missedHeartbeatsTolerated()).toBe(2);
  });

  it("does go offline once the window is genuinely gone", () => {
    expect(
      presenceFromHeartbeat(
        { state: "online", updatedAt: NOW - 3 * PRESENCE_HEARTBEAT_INTERVAL_MS },
        NOW,
      ),
    ).toBe("offline");
    expect(presenceIsLive(NOW - PRESENCE_TTL_MS, NOW)).toBe(false);
    // The boundary is exclusive on the live side: exactly TTL old is gone.
    expect(presenceIsLive(NOW - PRESENCE_TTL_MS + 1, NOW)).toBe(true);
  });

  it("agrees with the copy the backend holds", () => {
    // The two constants are written twice on purpose (a value import across
    // the convex/src boundary is a dependency direction this repo has nowhere
    // else). This is what makes the duplication safe: drift is a red test.
    expect(BACKEND_TTL_MS).toBe(PRESENCE_TTL_MS);
    expect(BACKEND_HEARTBEAT_MS).toBe(PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(BACKEND_TTL_MS).toBe(3 * BACKEND_HEARTBEAT_MS);
  });

  it("reads no row at all as offline", () => {
    expect(presenceFromHeartbeat(null, NOW)).toBe("offline");
    expect(presenceFromHeartbeat(undefined, NOW)).toBe("offline");
  });

  it("reads a live beat with an unrecognised claim as online", () => {
    // Buzz drops an unknown status string. A *stored* beat is different: it is
    // direct evidence a client is running, and the only thing the unknown
    // string leaves open is whether the human is beside it.
    expect(parsePresenceState("busy")).toBeNull();
    expect(parsePresenceState(undefined)).toBeNull();
    expect(parsePresenceState("online")).toBe("online");
    expect(presenceFromHeartbeat({ state: "busy", updatedAt: NOW }, NOW)).toBe("online");
  });
});

describe("the away threshold", () => {
  it("turns over at exactly ten minutes of no activity", () => {
    const justUnder = {
      osIdleSeconds: null,
      lastActivityAt: NOW - PRESENCE_IDLE_TIMEOUT_MS + 1,
    };
    const exactly = { osIdleSeconds: null, lastActivityAt: NOW - PRESENCE_IDLE_TIMEOUT_MS };
    expect(PRESENCE_IDLE_TIMEOUT_MS).toBe(600_000);
    expect(resolveAutomaticPresenceStatus(justUnder, NOW)).toBe("online");
    expect(resolveAutomaticPresenceStatus(exactly, NOW)).toBe("away");
  });

  it("lets OS idle overrule in-app activity in both directions", () => {
    // Somebody typing in another application is at their desk even though this
    // tab has seen nothing for twenty minutes …
    expect(
      resolveAutomaticPresenceStatus(
        { osIdleSeconds: 5, lastActivityAt: NOW - 20 * 60_000 },
        NOW,
      ),
    ).toBe("online");
    // … and somebody whose machine has been idle for an hour is away even
    // though this tab saw a stray pointermove a second ago (a notification
    // repaint, a scripted scroll).
    expect(
      resolveAutomaticPresenceStatus({ osIdleSeconds: 3600, lastActivityAt: NOW - 1_000 }, NOW),
    ).toBe("away");
  });

  it("ignores a nonsensical OS reading rather than trusting it", () => {
    expect(
      resolveAutomaticPresenceStatus({ osIdleSeconds: NaN, lastActivityAt: NOW }, NOW),
    ).toBe("online");
    expect(
      resolveAutomaticPresenceStatus({ osIdleSeconds: -50, lastActivityAt: NOW }, NOW),
    ).toBe("online");
  });

  it("never reads a clock skew backwards as ten minutes of idleness", () => {
    // `lastActivityAt` in the future would make `now - lastActivityAt`
    // negative; clamped, so a skewed clock cannot mark somebody away.
    expect(
      resolveAutomaticPresenceStatus({ osIdleSeconds: null, lastActivityAt: NOW + 60_000 }, NOW),
    ).toBe("online");
  });
});

describe("the manual override", () => {
  it("wins over what the machine worked out", () => {
    expect(resolvePreferredStatus("away", "online")).toBe("away");
    expect(resolvePreferredStatus("offline", "online")).toBe("offline");
  });

  it("means 'stop overriding' rather than 'stay green'", () => {
    // Storing "online" is the bug this shape prevents: it would pin the dot
    // and silently disable the away timer forever.
    expect(resolvePreferredStatus("auto", "away")).toBe("away");
    expect(resolvePreferredStatus("auto", "online")).toBe("online");
    expect(parsePresencePreference("online")).toBe("auto");
    expect(parsePresencePreference(null)).toBe("auto");
    expect(parsePresencePreference("nonsense")).toBe("auto");
    expect(parsePresencePreference("offline")).toBe("offline");
  });
});

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

const ROOM = { channelId: "room_1", threadHeadId: null } as const;
const ME = "aa".repeat(32);
const ADA = "bb".repeat(32);
const SCOUT = "cc".repeat(32);

function signal(pubkey: string, at: number, over: Partial<{ channelId: string; threadHeadId: string | null; name: string; isAgent: boolean }> = {}) {
  return {
    pubkey,
    name: over.name ?? "Ada",
    isAgent: over.isAgent,
    channelId: over.channelId ?? ROOM.channelId,
    threadHeadId: over.threadHeadId ?? null,
    sentAt: at,
  };
}

function receive(state: TypingState, sig: ReturnType<typeof signal>, now: number): TypingState {
  return receiveTypingSignal(state, sig, { now, selfPubkey: ME, scope: ROOM });
}

describe("typing expiry", () => {
  it("is eight seconds, bounded by the sender's own clock", () => {
    expect(TYPING_TTL_MS).toBe(8_000);
    const state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    expect(state.entries[typingKey(ADA, null)].expiresAt).toBe(NOW + TYPING_TTL_MS);

    // Three seconds in flight: it shows for five more, not for eleven.
    const delayed = receive(EMPTY_TYPING_STATE, signal(ADA, NOW - 3_000), NOW);
    expect(delayed.entries[typingKey(ADA, null)].expiresAt).toBe(NOW + 5_000);
  });

  it("drops a signal that was already expired when it arrived", () => {
    // A publish delivered after a reconnect. Inserting it would draw a row the
    // very next prune removes, which reads as a flicker rather than a person.
    const state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW - TYPING_TTL_MS), NOW);
    expect(Object.keys(state.entries)).toHaveLength(0);
  });

  it("does not trust a sender whose clock is ahead", () => {
    const state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW + 60_000), NOW);
    expect(state.entries[typingKey(ADA, null)].expiresAt).toBe(NOW + TYPING_TTL_MS);
  });

  it("prunes on the way past, and returns the same object when nothing changed", () => {
    const state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    expect(pruneTyping(state, NOW + 1_000)).toBe(state);
    const pruned = pruneTyping(state, NOW + TYPING_TTL_MS);
    expect(Object.keys(pruned.entries)).toHaveLength(0);
  });

  it("preserves firstSeenAt across refreshes so the order is stable", () => {
    let state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    state = receive(state, signal(SCOUT, NOW + 500, { name: "Scout" }), NOW + 500);
    state = receive(state, signal(ADA, NOW + 4_000), NOW + 4_000);
    expect(typingIn(state, null).map((e) => e.name)).toEqual(["Ada", "Scout"]);
    expect(state.entries[typingKey(ADA, null)].firstSeenAt).toBe(NOW);
  });
});

describe("what typing refuses", () => {
  it("refuses another room's indicator and your own echo", () => {
    expect(
      Object.keys(receive(EMPTY_TYPING_STATE, signal(ADA, NOW, { channelId: "room_2" }), NOW).entries),
    ).toHaveLength(0);
    expect(Object.keys(receive(EMPTY_TYPING_STATE, signal(ME, NOW), NOW).entries)).toHaveLength(0);
  });

  it("keeps a thread's typing distinct from the channel's", () => {
    let state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    state = receive(state, signal(ADA, NOW, { threadHeadId: "ev_head" }), NOW);
    expect(Object.keys(state.entries)).toHaveLength(2);
    expect(typingIn(state, null)).toHaveLength(1);
    expect(typingIn(state, "ev_head")).toHaveLength(1);
  });
});

describe("post-message suppression", () => {
  it("removes the entry and holds the door shut for two seconds", () => {
    expect(TYPING_POST_MESSAGE_SUPPRESS_MS).toBe(2_000);
    let state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    expect(Object.keys(state.entries)).toHaveLength(1);

    state = noteMessageFrom(state, { pubkey: ADA }, NOW);
    expect(Object.keys(state.entries)).toHaveLength(0);

    // The throttled indicator already in flight when the message landed. This
    // is the exact bug the suppression exists for: without it the dots
    // re-light directly under the sentence they were announcing.
    state = receive(state, signal(ADA, NOW - 200), NOW + 200);
    expect(Object.keys(state.entries)).toHaveLength(0);

    // And it lifts, so the next thing they type still shows.
    state = receive(state, signal(ADA, NOW + 2_100), NOW + 2_100);
    expect(Object.keys(state.entries)).toHaveLength(1);
  });

  it("suppresses only the scope the message landed in", () => {
    let state = receive(EMPTY_TYPING_STATE, signal(ADA, NOW), NOW);
    state = receive(state, signal(ADA, NOW, { threadHeadId: "ev_head" }), NOW);
    state = noteMessageFrom(state, { pubkey: ADA, threadHeadId: "ev_head" }, NOW);
    expect(typingIn(state, null)).toHaveLength(1);
    expect(typingIn(state, "ev_head")).toHaveLength(0);
  });

  it("expires its own suppression records rather than growing forever", () => {
    let state = noteMessageFrom(EMPTY_TYPING_STATE, { pubkey: ADA }, NOW);
    expect(Object.keys(state.suppressedUntil)).toHaveLength(1);
    state = pruneTyping(state, NOW + TYPING_POST_MESSAGE_SUPPRESS_MS + 1);
    expect(Object.keys(state.suppressedUntil)).toHaveLength(0);
  });
});

describe("the send throttle", () => {
  it("sends at most once per three seconds", () => {
    expect(TYPING_SEND_INTERVAL_MS).toBe(3_000);
    const first = shouldSendTyping(IDLE_TYPING_CLOCK, { scope: ROOM, now: NOW });
    expect(first.send).toBe(true);

    // Every keystroke in between is silent.
    let clock = first.clock;
    for (const offset of [10, 200, 1_500, 2_999]) {
      const attempt = shouldSendTyping(clock, { scope: ROOM, now: NOW + offset });
      expect(attempt.send).toBe(false);
      clock = attempt.clock;
    }
    expect(shouldSendTyping(clock, { scope: ROOM, now: NOW + 3_000 }).send).toBe(true);
  });

  it("resets when the room changes", () => {
    // Otherwise walking into a room and typing waits out a window that was
    // opened somewhere else, and the first thing you say arrives with no
    // indicator at all.
    const first = shouldSendTyping(IDLE_TYPING_CLOCK, { scope: ROOM, now: NOW });
    const elsewhere = shouldSendTyping(first.clock, {
      scope: { channelId: "room_2", threadHeadId: null },
      now: NOW + 10,
    });
    expect(elsewhere.send).toBe(true);
  });

  it("treats a thread as its own scope", () => {
    const first = shouldSendTyping(IDLE_TYPING_CLOCK, { scope: ROOM, now: NOW });
    const inThread = shouldSendTyping(first.clock, {
      scope: { channelId: ROOM.channelId, threadHeadId: "ev_head" },
      now: NOW + 10,
    });
    expect(inThread.send).toBe(true);
  });

  it("holds your own next announcement back after you send", () => {
    const first = shouldSendTyping(IDLE_TYPING_CLOCK, { scope: ROOM, now: NOW });
    const held = noteMessageSent(first.clock, NOW + 500);
    // The keystroke right after Enter must not re-announce you before the
    // room has even drawn what you said.
    expect(shouldSendTyping(held, { scope: ROOM, now: NOW + 520 }).send).toBe(false);
    expect(shouldSendTyping(held, { scope: ROOM, now: NOW + 2_600 }).send).toBe(true);
  });
});

describe("the typing sentence", () => {
  it("names people until naming them stops being useful", () => {
    expect(typingLabel([])).toBe("");
    expect(typingLabel(["Ada"])).toBe("Ada is typing...");
    expect(typingLabel(["Ada", "Bo"])).toBe("Ada and Bo are typing...");
    expect(typingLabel(["Ada", "Bo", "Cy"])).toBe("Ada, Bo, and Cy are typing...");
    expect(typingLabel(["Ada", "Bo", "Cy", "Di"])).toBe("Ada, Bo, and 2 others are typing...");
    expect(typingLabel(["Ada", "Bo", "Cy", "Di", "Ez"])).toBe(
      "Ada, Bo, and 3 others are typing...",
    );
  });
});

// ---------------------------------------------------------------------------
// Custom status
// ---------------------------------------------------------------------------

describe("custom status", () => {
  it("reads a 30315 the way Buzz does", () => {
    const parsed = parseUserStatusEvent({
      content: "  In a meeting  ",
      tags: [
        ["d", "general"],
        ["emoji", "🗣️"],
      ],
      created_at: Math.floor(NOW / 1000),
    });
    expect(parsed).toEqual({
      text: "In a meeting",
      emoji: "🗣️",
      updatedAt: Math.floor(NOW / 1000) * 1000,
      expiresAt: null,
    });
  });

  it("collapses the empty shape to null — that shape IS the clear", () => {
    expect(
      parseUserStatusEvent({ content: "   ", tags: [["d", "general"]], created_at: 1 }),
    ).toBeNull();
    expect(
      parseUserStatusEvent({ content: "", tags: [["emoji", "  "]], created_at: 1 }),
    ).toBeNull();
    // An emoji with no words is still a status.
    expect(
      parseUserStatusEvent({ content: "", tags: [["emoji", "🏖️"]], created_at: 1 })?.emoji,
    ).toBe("🏖️");
  });

  it("carries expiry as NIP-40's tag, in seconds", () => {
    const parsed = parseUserStatusEvent({
      content: "Commuting",
      tags: [
        ["d", "general"],
        ["expiration", String(Math.floor((NOW + 1_800_000) / 1000))],
      ],
      created_at: Math.floor(NOW / 1000),
    });
    expect(parsed?.expiresAt).toBe(Math.floor((NOW + 1_800_000) / 1000) * 1000);
  });

  it("ignores an unusable expiration rather than expiring immediately", () => {
    for (const value of ["", "soon", "-5", "0"]) {
      const parsed = parseUserStatusEvent({
        content: "Out sick",
        tags: [["expiration", value]],
        created_at: 1,
      });
      expect(parsed?.expiresAt).toBeNull();
    }
  });

  it("expires on read, on the boundary", () => {
    const status = { text: "In a meeting", emoji: "🗣️", updatedAt: NOW, expiresAt: NOW + 1_000 };
    expect(userStatusExpired(status, NOW + 999)).toBe(false);
    expect(activeUserStatus(status, NOW + 999)).toBe(status);
    // Exactly at the boundary it is gone: "clears at 3pm" must not still be up
    // at 3pm.
    expect(userStatusExpired(status, NOW + 1_000)).toBe(true);
    expect(activeUserStatus(status, NOW + 1_000)).toBeNull();
    expect(activeUserStatus({ ...status, expiresAt: null }, NOW + 10 ** 9)).not.toBeNull();
    expect(activeUserStatus(null, NOW)).toBeNull();
  });

  it("keeps the newest, and keeps what is on screen on a tie", () => {
    const older = { text: "Commuting", emoji: "🚌", updatedAt: NOW, expiresAt: null };
    const newer = { text: "At desk", emoji: "", updatedAt: NOW + 1_000, expiresAt: null };
    expect(newerUserStatus(older, newer)).toBe(newer);
    expect(newerUserStatus(newer, older)).toBe(newer);
    expect(newerUserStatus(newer, { ...older, updatedAt: newer.updatedAt })).toBe(newer);
    expect(newerUserStatus(newer, null)).toBe(newer);
    expect(newerUserStatus(null, newer)).toBe(newer);
  });

  it("refuses to publish whitespace, and computes the expiry from the duration", () => {
    expect(normalizeStatusDraft({ text: "   ", emoji: "  ", minutes: 30 }, NOW)).toBeNull();
    expect(normalizeStatusDraft({ text: " Out sick ", emoji: "🤒", minutes: null }, NOW)).toEqual({
      text: "Out sick",
      emoji: "🤒",
      expiresAt: null,
    });
    expect(normalizeStatusDraft({ text: "Lunch", emoji: "", minutes: 30 }, NOW)?.expiresAt).toBe(
      NOW + 1_800_000,
    );
  });

  it("ships the five presets and a 'do not clear' default", () => {
    expect(USER_STATUS_PRESETS.map((p) => p.text)).toEqual([
      "In a meeting",
      "Commuting",
      "Out sick",
      "Vacationing",
      "Working remotely",
    ]);
    expect(USER_STATUS_PRESETS.every((p) => p.emoji.length > 0)).toBe(true);
    expect(STATUS_DURATIONS[0].minutes).toBeNull();
    expect(STATUS_DURATIONS.some((d) => d.minutes === 30)).toBe(true);
  });

  it("recognises a shortcode without mistaking an emoji for one", () => {
    expect(isEmojiShortcode(":shipit:")).toBe(true);
    expect(isEmojiShortcode("🗣️")).toBe(false);
    expect(isEmojiShortcode(":not a code:")).toBe(false);
    expect(isEmojiShortcode(":unclosed")).toBe(false);
  });
});

// ===========================================================================
// The backend
// ===========================================================================

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "11".repeat(32),
  [BOB.subject]: "12".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

async function seedCommunity() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      const secretKey = KEYS[person.subject];
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

    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const agentSecret = "13".repeat(32);
    await ctx.db.insert("buzzKeys", {
      principalType: "agent",
      principalId: agentId,
      pubkey: publicKeyFromSecret(agentSecret),
      secretKey: agentSecret,
      createdAt: Date.now(),
    });

    return { workspaceId, agentId };
  });

  const scope = { scopeType: "workspace" as const, scopeId: ids.workspaceId };
  return { t, scope, ...ids };
}

/** Mint an agent API key the way `agentKeys.createKey` does: hash at rest. */
async function mintAgentKey(
  t: ReturnType<typeof convexTest>,
  agentId: string,
  plaintext: string,
): Promise<string> {
  const { sha256Hex } = await import("../convex/_agentAuth");
  await t.run(async (ctx: Ctx) => {
    await ctx.db.insert("agentKeys", {
      agentId: agentId as never,
      keyHash: sha256Hex(plaintext),
      keyPrefix: plaintext.slice(0, 12),
      createdAt: Date.now(),
    });
  });
  return plaintext;
}

describe("the community surface", () => {
  it("is the scope pair, joined — the shape `requireSurface` parses back", () => {
    expect(communitySurfaceId({ scopeType: "workspace", scopeId: "ws_1" })).toBe("workspace:ws_1");
    expect(communitySurfaceId({ scopeType: "user", scopeId: "user_a" })).toBe("user:user_a");
  });

  it("names an Ably room channel inside the one namespace a client may publish to", () => {
    // `realtime.publishFromClient` refuses anything outside `operate:chat:`.
    expect(buzzRoomChannel("abc")).toBe("operate:chat:buzz:abc");
    expect(buzzRoomChannel("abc").startsWith("operate:chat:")).toBe(true);
  });
});

describe("heartbeats", () => {
  it("writes one row per actor and reads it back as online", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });

    const rows = await t.run(async (ctx: Ctx) => await ctx.db.query("presence").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].surfaceType).toBe("community");
    expect(rows[0].surfaceId).toBe(communitySurfaceId(scope));
    expect(rows[0].actorType).toBe("user");
    // Presence is not a caret in a document, and it is not in the durable log.
    expect(rows[0].editing).toBe(false);

    const roster = (await t.withIdentity(BOB).query(presence.roster, scope)) as {
      actorId: string;
      status: string;
    }[];
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ actorId: ALICE.subject, status: "online" });
  });

  it("carries the away claim, and repeats do not multiply rows", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "away" });

    const rows = await t.run(async (ctx: Ctx) => await ctx.db.query("presence").collect());
    expect(rows).toHaveLength(1);
    const roster = (await t.withIdentity(ALICE).query(presence.roster, scope)) as {
      status: string;
    }[];
    expect(roster[0].status).toBe("away");
  });

  it("makes offline an absence rather than a claim", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.leave, scope);
    expect(await t.run(async (ctx: Ctx) => await ctx.db.query("presence").collect())).toHaveLength(
      0,
    );

    // …and a seeded actor with no row reads offline, so a member list can draw
    // a grey dot rather than a gap.
    const roster = (await t.withIdentity(ALICE).query(presence.roster, {
      ...scope,
      seed: [{ actorId: ALICE.subject, actorType: "user" }],
    })) as { status: string; lastSeenAt: number | null }[];
    expect(roster[0]).toMatchObject({ status: "offline", lastSeenAt: null });
  });

  it("shows a row past the TTL as gone", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.run(async (ctx: Ctx) => {
      const row = await ctx.db.query("presence").first();
      // One beat older than the whole window: two consecutive misses, which is
      // a client that has genuinely stopped.
      await ctx.db.patch(row!._id, { updatedAt: Date.now() - PRESENCE_TTL_MS - 1_000 });
    });
    expect(await t.withIdentity(ALICE).query(presence.roster, scope)).toEqual([]);
  });

  it("keeps a row that has missed exactly one beat", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.run(async (ctx: Ctx) => {
      const row = await ctx.db.query("presence").first();
      await ctx.db.patch(row!._id, {
        updatedAt: Date.now() - 2 * PRESENCE_HEARTBEAT_INTERVAL_MS,
      });
    });
    const roster = (await t.withIdentity(ALICE).query(presence.roster, scope)) as {
      status: string;
    }[];
    expect(roster).toHaveLength(1);
    expect(roster[0].status).toBe("online");
  });

  it("refuses a community the caller is not in", async () => {
    const { t, scope } = await seedCommunity();
    await expect(
      t.withIdentity(OUTSIDER).mutation(presence.heartbeat, { ...scope, state: "online" }),
    ).rejects.toThrow();
    await expect(t.withIdentity(OUTSIDER).query(presence.roster, scope)).rejects.toThrow();
  });
});

describe("agents in presence", () => {
  it("appear in the same roster as people, through the same table", async () => {
    const { t, scope, agentId } = await seedCommunity();
    const apiKey = await mintAgentKey(t, agentId, "cua_test_presence_key");

    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.mutation(presence.agentHeartbeat, { apiKey, ...scope });

    const roster = (await t.withIdentity(ALICE).query(presence.roster, scope)) as {
      actorId: string;
      actorType: string;
      name: string;
      status: string;
    }[];
    expect(roster).toHaveLength(2);
    // Agents lead, exactly as `presence.readViewers` orders them — a machine
    // at work is the news in a rail read left to right.
    expect(roster[0]).toMatchObject({
      actorId: agentId,
      actorType: "agent",
      name: "Scout",
      status: "online",
    });
    expect(roster[1].actorType).toBe("user");
  });

  it("cannot announce itself in a community it does not belong to", async () => {
    const { t, agentId } = await seedCommunity();
    const apiKey = await mintAgentKey(t, agentId, "cua_test_presence_key_2");
    await expect(
      t.mutation(presence.agentHeartbeat, {
        apiKey,
        scopeType: "user",
        scopeId: ALICE.subject,
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it("can put a community down", async () => {
    const { t, scope, agentId } = await seedCommunity();
    const apiKey = await mintAgentKey(t, agentId, "cua_test_presence_key_3");
    await t.mutation(presence.agentHeartbeat, { apiKey, ...scope });
    await t.mutation(presence.agentLeave, { apiKey, ...scope });
    expect(await t.withIdentity(ALICE).query(presence.roster, scope)).toEqual([]);
  });
});

describe("custom status, end to end", () => {
  it("is a durable event, and reaches the roster", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t
      .withIdentity(ALICE)
      .mutation(presence.setStatus, { ...scope, text: "In a meeting", emoji: "🗣️" });

    const events = await t.run(
      async (ctx: Ctx) =>
        await ctx.db
          .query("buzzEvents")
          .filter((q) => q.eq(q.field("kind"), 30315))
          .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("In a meeting");
    expect(events[0].sig).toMatch(/^[0-9a-f]{128}$/);
    expect(events[0].tags).toContainEqual(["d", "general"]);

    const roster = (await t.withIdentity(BOB).query(presence.roster, scope)) as {
      statusText: string | null;
      statusEmoji: string | null;
    }[];
    expect(roster[0]).toMatchObject({ statusText: "In a meeting", statusEmoji: "🗣️" });
  });

  it("replaces rather than accumulates", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.setStatus, { ...scope, text: "One", emoji: "" });
    await t.run(async (ctx: Ctx) => {
      // A second apart, so the newer event genuinely supersedes rather than
      // losing the equal-second tie-break.
      const row = await ctx.db.query("buzzEvents").first();
      await ctx.db.patch(row!._id, { createdAt: row!.createdAt - 5 });
    });
    await t.withIdentity(ALICE).mutation(presence.setStatus, { ...scope, text: "Two", emoji: "" });

    const status = (await t.withIdentity(ALICE).query(presence.myStatus, scope)) as {
      text: string;
    } | null;
    expect(status?.text).toBe("Two");
  });

  it("clears by publishing the empty shape, never by deleting", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.setStatus, { ...scope, text: "One", emoji: "" });
    await t.run(async (ctx: Ctx) => {
      const row = await ctx.db.query("buzzEvents").first();
      await ctx.db.patch(row!._id, { createdAt: row!.createdAt - 5 });
    });
    await t.withIdentity(ALICE).mutation(presence.clearStatus, scope);

    expect(await t.withIdentity(ALICE).query(presence.myStatus, scope)).toBeNull();
    const events = await t.run(
      async (ctx: Ctx) =>
        await ctx.db
          .query("buzzEvents")
          .filter((q) => q.eq(q.field("kind"), 30315))
          .collect(),
    );
    // Both are still there — the log is append-only, and "I took my status
    // down" is itself a fact a reader with a cached copy needs.
    expect(events).toHaveLength(2);
  });

  it("refuses the empty shape through setStatus", async () => {
    const { t, scope } = await seedCommunity();
    await expect(
      t.withIdentity(ALICE).mutation(presence.setStatus, { ...scope, text: "  ", emoji: "" }),
    ).rejects.toThrow(/clearStatus/);
  });

  it("stops showing an expired status without anything having to sweep it", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.setStatus, {
      ...scope,
      text: "Back in 5",
      emoji: "",
      expiresAt: Date.now() + 60_000,
    });
    expect(await t.withIdentity(ALICE).query(presence.myStatus, scope)).not.toBeNull();

    await t.run(async (ctx: Ctx) => {
      const row = await ctx.db
        .query("buzzEvents")
        .filter((q) => q.eq(q.field("kind"), 30315))
        .first();
      const past = Math.floor((Date.now() - 1_000) / 1000);
      await ctx.db.patch(row!._id, {
        tags: (row!.tags as string[][]).map((tag: string[]) =>
          tag[0] === "expiration" ? ["expiration", String(past)] : tag,
        ),
      });
    });

    expect(await t.withIdentity(ALICE).query(presence.myStatus, scope)).toBeNull();
    const roster = (await t.withIdentity(BOB).query(presence.roster, scope)) as {
      statusText: string | null;
    }[];
    expect(roster[0].statusText).toBeNull();
  });
});

describe("what never touches the durable log", () => {
  it("a heartbeat writes no event", async () => {
    const { t, scope } = await seedCommunity();
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "online" });
    await t.withIdentity(ALICE).mutation(presence.heartbeat, { ...scope, state: "away" });
    await t.withIdentity(ALICE).mutation(presence.leave, scope);
    // §16.22, asserted rather than described. Presence is a TTL row; typing is
    // not even that (it is an Ably action with no mutation behind it, which is
    // why there is no write here to look for).
    expect(await t.run(async (ctx: Ctx) => await ctx.db.query("buzzEvents").collect())).toEqual([]);
  });
});
