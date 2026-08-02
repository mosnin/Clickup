import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret, verifyEvent } from "../convex/buzz/_nostr";
import { sha256Hex } from "../convex/_agentAuth";
import { KINDS } from "../convex/buzz/_kinds";
import { RELAY_SEED_ENV, relayPubkeyFor } from "../convex/buzz/relay";
import {
  HUDDLE_JOINABLE_WINDOW_SECONDS,
  HUDDLE_LIFECYCLE_KINDS,
  IDLE_HUDDLE_SESSION,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_REACTION,
  KIND_HUDDLE_STARTED,
  appendCaption,
  compareHuddleEvents,
  foldHuddles,
  humansIn,
  isTransmitting,
  liveHuddle,
  nextHuddleSession,
  normalizeReaction,
  ownsHuddleLifetime,
  ownsSession,
  participantIsAgent,
  participantPubkeyOf,
  resetPreservingGeneration,
  shouldAutoEnableTranscription,
  shouldAutoEnd,
  type HuddleLogEvent,
  type HuddleSession,
} from "../src/lib/buzz/huddle";

// `anyApi` rather than the generated `api`, for the reason every other Buzz
// test states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it. The references
// resolve identically at runtime — convex-test finds them through the glob.
const modules = import.meta.glob("../convex/**/*.*s");
const huddle = anyApi.buzz.huddle;
const channels = anyApi.buzz.channels;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

// Fixed keys: several assertions are about *which* pubkey signed something, and
// a random key makes those pass or fail by the day.
const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};
const SCOUT_SECRET = "05".repeat(32);
const FENCED_SECRET = "06".repeat(32);
const SCOUT_API_KEY = "cua_scout_test_key";
const FENCED_API_KEY = "cua_fenced_test_key";

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

    // A list, only so that a list-restricted agent has something to be
    // restricted to. The fence is about rooms, not about this list.
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
      name: string,
      secret: string,
      apiKey: string,
      overrides: Record<string, unknown> = {},
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        ...overrides,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "agent",
        principalId: agentId,
        pubkey: publicKeyFromSecret(secret),
        secretKey: secret,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 8),
        createdAt: Date.now(),
      });
      return agentId;
    }

    const scoutId = await makeAgent("Scout", SCOUT_SECRET, SCOUT_API_KEY);
    const fencedId = await makeAgent("Fenced", FENCED_SECRET, FENCED_API_KEY, {
      allowedListIds: [listId],
    });

    return { workspaceId, scoutId, fencedId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const created = (await t
    .withIdentity(ALICE)
    .mutation(channels.create, { ...scope, name: "flight-path" })) as { channelId: string };

  // Bob and Carol are in the room; the outsider is in no workspace at all.
  for (const person of [BOB, CAROL]) {
    await t.withIdentity(person).mutation(channels.join, {
      ...scope,
      channelId: created.channelId,
    });
  }

  return { t, scope, channelId: created.channelId, ...ids };
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function eventsOfKind(t: ReturnType<typeof convexTest>, kind: number) {
  return await t.run(async (ctx: Ctx) =>
    (await ctx.db.query("buzzEvents").collect()).filter((row) => row.kind === kind),
  );
}

/** A lifecycle event, as the fold sees one. */
function ev(
  kind: number,
  overrides: Partial<HuddleLogEvent> & { h?: string; e?: string; p?: string; role?: string } = {},
): HuddleLogEvent {
  const tags: string[][] = [["h", overrides.h ?? "room"]];
  if (overrides.e) tags.push(["e", overrides.e]);
  if (overrides.p) tags.push(["p", overrides.p]);
  if (overrides.role) tags.push(["role", overrides.role]);
  return {
    id: overrides.id ?? `${kind}-${overrides.p ?? "x"}-${overrides.created_at ?? 0}`,
    pubkey: overrides.pubkey ?? "relaypub",
    kind,
    created_at: overrides.created_at ?? 1000,
    tags: overrides.tags ?? tags,
    content: overrides.content ?? "",
  };
}

// ---------------------------------------------------------------------------
// The kind registry
// ---------------------------------------------------------------------------

describe("the huddle kinds", () => {
  it("match the registry the log actually enforces", () => {
    // `src/lib/buzz/huddle.ts` restates these so a browser does not download a
    // signing library to draw a call. The duplication is only safe while it is
    // pinned, which is what this is.
    for (const [kind, expectations] of [
      [KIND_HUDDLE_STARTED, { name: "KIND_HUDDLE_STARTED", relaySigned: undefined }],
      [
        KIND_HUDDLE_PARTICIPANT_JOINED,
        { name: "KIND_HUDDLE_PARTICIPANT_JOINED", relaySigned: true },
      ],
      [KIND_HUDDLE_PARTICIPANT_LEFT, { name: "KIND_HUDDLE_PARTICIPANT_LEFT", relaySigned: true }],
      [KIND_HUDDLE_ENDED, { name: "KIND_HUDDLE_ENDED", relaySigned: true }],
      [KIND_HUDDLE_GUIDELINES, { name: "KIND_HUDDLE_GUIDELINES", relaySigned: undefined }],
      [KIND_HUDDLE_REACTION, { name: "KIND_HUDDLE_REACTION", relaySigned: undefined }],
    ] as const) {
      const spec = KINDS.get(kind as number);
      expect(spec?.name).toBe(expectations.name);
      // Every one of them is channel-scoped: a call belongs to a room, and a
      // huddle event stored community-wide would be readable by people who
      // cannot see the room it happened in.
      expect(spec?.scope).toBe("required");
      expect(spec?.relaySigned).toBe(expectations.relaySigned);
    }
    // A reaction is in the ephemeral band, so the log signs it and never
    // stores it. That is what makes a gesture a gesture.
    expect(KINDS.get(KIND_HUDDLE_REACTION)?.storage).toBe("ephemeral");
    expect(HUDDLE_LIFECYCLE_KINDS).toEqual([48100, 48101, 48102, 48103]);
  });
});

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

function advance(session: HuddleSession, ...actions: Parameters<typeof nextHuddleSession>[1][]) {
  let out = session;
  for (const action of actions) {
    const step = nextHuddleSession(out, action);
    if (!step.ok) throw new Error(`refused: ${step.reason}`);
    out = step.session;
  }
  return out;
}

describe("the six-phase machine", () => {
  it("walks the legal path, start and join", () => {
    const created = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
      { type: "confirm_media" },
      { type: "leave" },
      { type: "teardown" },
    );
    expect(created.phase).toBe("idle");

    const joined = advance(
      IDLE_HUDDLE_SESSION,
      { type: "join", parentChannelId: "room", huddleId: "h1" },
      { type: "joined", huddleId: "h1" },
    );
    expect(joined.phase).toBe("connected");
    expect(joined.isCreator).toBe(false);
  });

  it("records who started it, which is not the same as who is in it", () => {
    const starting = advance(IDLE_HUDDLE_SESSION, { type: "start", parentChannelId: "room" });
    expect(starting.phase).toBe("creating");
    expect(starting.isCreator).toBe(true);
    const joining = advance(IDLE_HUDDLE_SESSION, {
      type: "join",
      parentChannelId: "room",
      huddleId: "h1",
    });
    expect(joining.phase).toBe("connecting");
  });

  it("refuses to start a second call, benignly", () => {
    const inCall = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
    );
    const again = nextHuddleSession(inCall, { type: "start", parentChannelId: "room" });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      // Buzz's exact sentence, and **benign**: a second press of Start means
      // the same thing the first one did, so the UI swallows it. Without the
      // flag it would either show an error for a double click or hide a real
      // failure.
      expect(again.reason).toBe("cannot start huddle: already in phase connected");
      expect(again.benign).toBe(true);
    }
    const joinAgain = nextHuddleSession(inCall, {
      type: "join",
      parentChannelId: "room",
      huddleId: "h2",
    });
    expect(joinAgain.ok).toBe(false);
  });

  it("refuses audio confirmation before the log says you are in", () => {
    // The illegal edge that matters most: `active` with no huddle id means a
    // bar whose Leave button has nothing to publish.
    const connecting = advance(IDLE_HUDDLE_SESSION, {
      type: "join",
      parentChannelId: "room",
      huddleId: "h1",
    });
    const early = nextHuddleSession(connecting, { type: "confirm_media" });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.benign).toBe(false);

    expect(nextHuddleSession(IDLE_HUDDLE_SESSION, { type: "confirm_media" }).ok).toBe(false);
  });

  it("never goes backwards, and confirming twice is a no-op", () => {
    const active = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
      { type: "confirm_media" },
    );
    // A transport that reports "up" twice reconnected; it did not change phase.
    expect(advance(active, { type: "confirm_media" }).phase).toBe("active");
    // And `joined` cannot demote an active call back to connected.
    const demote = nextHuddleSession(active, { type: "joined", huddleId: "h1" });
    expect(demote.ok).toBe(false);
    if (!demote.ok) expect(demote.benign).toBe(true);
  });

  it("treats leaving twice, and leaving nothing, as nothing to report", () => {
    expect(nextHuddleSession(IDLE_HUDDLE_SESSION, { type: "leave" }).ok).toBe(false);
    const leaving = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
      { type: "leave" },
      { type: "leave" },
    );
    expect(leaving.phase).toBe("leaving");
  });
});

// ---------------------------------------------------------------------------
// The two counters
// ---------------------------------------------------------------------------

describe("the generation counters", () => {
  it("huddleGeneration: a rejoin to the same room invalidates the first attempt", () => {
    const first = advance(IDLE_HUDDLE_SESSION, { type: "join", parentChannelId: "room", huddleId: "h1" });
    const generation = first.huddleGeneration;
    // Hang up, dial the same room again.
    const second = advance(
      first,
      { type: "leave" },
      { type: "teardown" },
      { type: "join", parentChannelId: "room", huddleId: "h1" },
    );

    // **This is the case an id comparison alone cannot catch.** Same room, same
    // huddle id, different attempt — without the counter the first attempt's
    // slow result would commit into the second attempt's session, or its
    // failure would tear down a call that is already up.
    expect(ownsHuddleLifetime(second, "h1", generation)).toBe(false);
    expect(ownsHuddleLifetime(second, "h1", second.huddleGeneration)).toBe(true);
  });

  it("huddleGeneration: it survives a teardown, so a stale result never looks current", () => {
    const after = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
      { type: "teardown" },
    );
    // Resetting the counter is the bug it exists to prevent: a producer from
    // the call that just ended captured generation 1, and a fresh session
    // starting again at 1 would look current to it.
    expect(after.huddleGeneration).toBe(1);
    expect(after.phase).toBe("idle");
  });

  it("sessionGeneration: a teardown stops a producer that is mid-chunk", () => {
    const live = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
    );
    const captured = live.sessionGeneration;
    expect(ownsSession(live, captured)).toBe(true);

    const gone = advance(live, { type: "teardown" });
    // Without this, a caption tap whose final chunk was in flight at hangup
    // posts one more line into a call the person has already left — invisible
    // in testing because it needs a real audio chunk mid-flight.
    expect(ownsSession(gone, captured)).toBe(false);
  });

  it("sessionGeneration: replacing the capture pipeline is not a rejoin", () => {
    const live = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
    );
    const beforeHuddle = live.huddleGeneration;
    const beforeSession = live.sessionGeneration;

    // Switching input mode, or picking a different microphone, replaces the
    // capture gate — the producers must stop, the *call* must not.
    const switched = advance(live, { type: "set_input_mode", mode: "push_to_talk" });
    expect(switched.sessionGeneration).toBe(beforeSession + 1);
    expect(switched.huddleGeneration).toBe(beforeHuddle);
    expect(switched.phase).toBe("connected");

    const redevice = advance(switched, { type: "set_input_device", deviceId: "mic-2" });
    expect(redevice.sessionGeneration).toBe(switched.sessionGeneration + 1);
    expect(redevice.huddleGeneration).toBe(beforeHuddle);

    // And the other way round: a rejoin moves the huddle counter without
    // pretending the pipelines were replaced.
    const rejoined = advance(
      redevice,
      { type: "leave" },
      { type: "teardown" },
      { type: "join", parentChannelId: "room", huddleId: "h1" },
    );
    expect(rejoined.huddleGeneration).toBe(beforeHuddle + 1);
  });

  it("keeps the preferences that describe the machine rather than the call", () => {
    const tuned = advance(
      IDLE_HUDDLE_SESSION,
      { type: "start", parentChannelId: "room" },
      { type: "joined", huddleId: "h1" },
      { type: "set_speaker_muted", muted: true },
      { type: "set_input_mode", mode: "push_to_talk" },
      { type: "set_gain", gain: 0.4 },
      { type: "set_input_device", deviceId: "mic-2" },
      { type: "set_transcription", enabled: true, byUser: true },
    );
    const reset = resetPreservingGeneration(tuned);
    // Somebody who silenced agent speech in one call did not ask to hear it in
    // the next one.
    expect(reset.speakerMuted).toBe(true);
    expect(reset.inputMode).toBe("push_to_talk");
    expect(reset.gain).toBe(0.4);
    expect(reset.inputDeviceId).toBe("mic-2");
    // The call's own state does not survive, including the caption choice: the
    // next call is a different conversation with different people in it.
    expect(reset.huddleId).toBeNull();
    expect(reset.transcriptionEnabled).toBe(false);
    expect(reset.transcriptionUserControlled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Microphone gating
// ---------------------------------------------------------------------------

describe("what is actually transmitting", () => {
  const live = advance(
    IDLE_HUDDLE_SESSION,
    { type: "start", parentChannelId: "room" },
    { type: "joined", huddleId: "h1" },
  );

  it("sends nothing when there is no audio path at all", () => {
    // The property the null transport depends on: with no provider nothing is
    // transmitting, whatever the mute button says.
    expect(isTransmitting(live, false)).toBe(false);
  });

  it("mute outranks push to talk", () => {
    const ptt = advance(live, { type: "set_input_mode", mode: "push_to_talk" });
    expect(isTransmitting(ptt, true)).toBe(false);
    const held = advance(ptt, { type: "set_push_to_talk", held: true });
    expect(isTransmitting(held, true)).toBe(true);
    const muted = advance(held, { type: "set_mic_muted", muted: true });
    // "Force mute (overrides PTT)": somebody who pressed mute has said
    // something stronger than somebody holding a key.
    expect(isTransmitting(muted, true)).toBe(false);
  });

  it("ignores the push-to-talk key outside push-to-talk mode", () => {
    // A stray Ctrl+Space must not be able to mute somebody who never opted
    // into a key.
    const stray = advance(live, { type: "set_push_to_talk", held: true });
    expect(stray.pushToTalkHeld).toBe(false);
    expect(isTransmitting(stray, true)).toBe(true);
  });

  it("drops the held key when the mode changes", () => {
    const held = advance(
      live,
      { type: "set_input_mode", mode: "push_to_talk" },
      { type: "set_push_to_talk", held: true },
    );
    const back = advance(held, { type: "set_input_mode", mode: "voice_activity" });
    expect(back.pushToTalkHeld).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Captions turning themselves on
// ---------------------------------------------------------------------------

describe("the transcription auto-enable rule", () => {
  const live = advance(
    IDLE_HUDDLE_SESSION,
    { type: "start", parentChannelId: "room" },
    { type: "joined", huddleId: "h1" },
  );

  it("turns on once for a machine, and only once", () => {
    expect(shouldAutoEnableTranscription(live, false)).toBe(false);
    expect(shouldAutoEnableTranscription(live, true)).toBe(true);
    const on = advance(live, { type: "set_transcription", enabled: true, byUser: false });
    expect(shouldAutoEnableTranscription(on, true)).toBe(false);
  });

  it("never overrides somebody who touched the control", () => {
    const off = advance(live, { type: "set_transcription", enabled: false, byUser: true });
    // A room with a machine in it must not overrule the person every time.
    expect(shouldAutoEnableTranscription(off, true)).toBe(false);
  });

  it("does not turn itself back off when the last machine leaves", () => {
    const on = advance(live, { type: "set_transcription", enabled: true, byUser: false });
    // Deliberate: an automatic on is a suggestion, an automatic off would
    // delete text somebody is reading.
    expect(on.transcriptionEnabled).toBe(true);
    expect(shouldAutoEnableTranscription(on, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Folding the log
// ---------------------------------------------------------------------------

const NOW = 10_000_000_000;
const NOW_SECS = Math.floor(NOW / 1000);

describe("reconstructing a huddle from its events", () => {
  it("builds a roster from the deltas, in causal order", () => {
    const events = [
      ev(KIND_HUDDLE_PARTICIPANT_LEFT, { e: "h1", p: "bob", created_at: NOW_SECS - 5 }),
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h1", p: "bob", created_at: NOW_SECS - 10 }),
      ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice", created_at: NOW_SECS - 10 }),
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h1", p: "alice", created_at: NOW_SECS - 10 }),
    ];
    const [snapshot] = foldHuddles(events, NOW);
    expect(snapshot.huddleId).toBe("h1");
    expect(snapshot.startedByPubkey).toBe("alice");
    expect(snapshot.live).toBe(true);
    expect(snapshot.participants.map((p) => p.pubkey)).toEqual(["alice"]);
    expect(snapshot.inferred).toBe(false);
  });

  it("orders start before join before left before end inside one second", () => {
    // Delivery order is not causal order: a short call, or a reconnect replay,
    // hands over four events stamped with the same second. Without the kind
    // tie-break the roster depends on which arrived first.
    const same = NOW_SECS - 1;
    const shuffled = [
      ev(KIND_HUDDLE_ENDED, { e: "h1", created_at: same }),
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h1", p: "alice", created_at: same }),
      ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice", created_at: same }),
    ];
    expect([...shuffled].sort(compareHuddleEvents).map((e2) => e2.kind)).toEqual([
      KIND_HUDDLE_STARTED,
      KIND_HUDDLE_PARTICIPANT_JOINED,
      KIND_HUDDLE_ENDED,
    ]);
    const [snapshot] = foldHuddles(shuffled, NOW);
    expect(snapshot.live).toBe(false);
    expect(snapshot.endReason).toBe("ended");
  });

  it("remembers that a call ended, so a late leave cannot resurrect it", () => {
    const events = [
      ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice", created_at: NOW_SECS - 20 }),
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h1", p: "alice", created_at: NOW_SECS - 19 }),
      ev(KIND_HUDDLE_ENDED, { e: "h1", created_at: NOW_SECS - 10 }),
      // A relay-signed leave that sorts after the end. Applying it would leave
      // a phantom call with one person in it.
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h1", p: "bob", created_at: NOW_SECS - 5 }),
    ];
    const [snapshot] = foldHuddles(events, NOW);
    expect(snapshot.live).toBe(false);
    expect(snapshot.participants).toEqual([]);
    expect(snapshot.participantCount).toBe(0);
  });

  it("infers a call whose announcement scrolled out of the window", () => {
    // The read window is bounded; a long call's 48100 falls out of it. Refusing
    // to draw the call would be how a room stops showing a huddle that is very
    // much happening.
    const [snapshot] = foldHuddles(
      [ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h9", p: "bob", created_at: NOW_SECS - 30 })],
      NOW,
    );
    expect(snapshot.inferred).toBe(true);
    expect(snapshot.startedByPubkey).toBeNull();
    expect(snapshot.participantCount).toBeGreaterThanOrEqual(1);
  });

  it("floors an inferred roster at one rather than drawing an empty call", () => {
    const [snapshot] = foldHuddles(
      [
        ev(KIND_HUDDLE_PARTICIPANT_JOINED, { e: "h9", p: "bob", created_at: NOW_SECS - 30 }),
        ev(KIND_HUDDLE_PARTICIPANT_LEFT, { e: "h9", p: "bob", created_at: NOW_SECS - 20 }),
      ],
      NOW,
    );
    // Everyone we saw has left, but we never saw the start, so the roster is
    // incomplete rather than empty — "0 people" on a call somebody is
    // demonstrably in is worse than a low number.
    expect(snapshot.participants).toEqual([]);
    expect(snapshot.participantCount).toBe(1);
  });

  it("decays a stale call rather than stranding the room in 'in progress'", () => {
    const events = [
      ev(KIND_HUDDLE_STARTED, {
        id: "h1",
        pubkey: "alice",
        created_at: NOW_SECS - HUDDLE_JOINABLE_WINDOW_SECONDS - 1,
      }),
      ev(KIND_HUDDLE_PARTICIPANT_JOINED, {
        e: "h1",
        p: "alice",
        created_at: NOW_SECS - HUDDLE_JOINABLE_WINDOW_SECONDS - 1,
      }),
    ];
    // No 48103 ever arrived — the last laptop lid closed. Without the decay
    // rule this room says "call in progress" forever, with a Join button that
    // connects to nobody.
    const [expired] = foldHuddles(events, NOW);
    expect(expired.live).toBe(false);
    expect(expired.endReason).toBe("expired");
    expect(expired.endedAt).toBeNull();
    expect(liveHuddle([expired])).toBeNull();

    // One second inside the window and it is still a call.
    const fresh = foldHuddles(
      events.map((event) => ({
        ...event,
        created_at: NOW_SECS - HUDDLE_JOINABLE_WINDOW_SECONDS + 1,
      })),
      NOW,
    );
    expect(fresh[0].live).toBe(true);
    expect(fresh[0].endReason).toBeNull();
  });

  it("reads the participant off the p tag, never off the signer", () => {
    // 48101–48103 are relay-signed, so `pubkey` is the community relay. A
    // consumer that reads it shows the relay in the roster.
    const joined = ev(KIND_HUDDLE_PARTICIPANT_JOINED, {
      e: "h1",
      p: "bob",
      role: "bot",
      pubkey: "the-relay",
    });
    expect(participantPubkeyOf(joined)).toBe("bob");
    expect(participantIsAgent(joined)).toBe(true);
    // A start is signed by its author, and carries no `p`.
    const started = ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice" });
    expect(participantPubkeyOf(started)).toBe("alice");
    expect(participantIsAgent(started)).toBe(false);
  });

  it("ignores an event with no room", () => {
    // A channel-scoped kind with no `h` cannot exist in the log at all, and a
    // fold that accepted one would build a call with no room to be in.
    expect(foldHuddles([{ ...ev(KIND_HUDDLE_STARTED, { id: "h1" }), tags: [] }], NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The auto-end rule
// ---------------------------------------------------------------------------

describe("the last human out ends the call", () => {
  function callWith(participants: { pubkey: string; role: string }[]) {
    const events: HuddleLogEvent[] = [
      ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice", created_at: NOW_SECS - 60 }),
      ...participants.map((participant, index) =>
        ev(KIND_HUDDLE_PARTICIPANT_JOINED, {
          e: "h1",
          p: participant.pubkey,
          role: participant.role,
          created_at: NOW_SECS - 50 + index,
        }),
      ),
    ];
    return foldHuddles(events, NOW)[0];
  }

  it("does not end while another person is still in it", () => {
    const call = callWith([
      { pubkey: "alice", role: "human" },
      { pubkey: "bob", role: "human" },
    ]);
    expect(humansIn(call)).toHaveLength(2);
    expect(shouldAutoEnd(call, "alice")).toBe(false);
  });

  it("ends when the only remaining human leaves, machines notwithstanding", () => {
    const call = callWith([
      { pubkey: "alice", role: "human" },
      { pubkey: "scout", role: "bot" },
      { pubkey: "reader", role: "bot" },
    ]);
    // Two machines alone in a call is not a call — it is two processes holding
    // a room open that nobody can hear.
    expect(shouldAutoEnd(call, "alice")).toBe(true);
  });

  it("does not end because a machine left", () => {
    const call = callWith([
      { pubkey: "alice", role: "human" },
      { pubkey: "scout", role: "bot" },
    ]);
    expect(shouldAutoEnd(call, "scout")).toBe(false);
  });

  it("refuses to end a call it cannot see, which is the fail-safe direction", () => {
    // Buzz defaults its human count to 2 rather than 1 on a fetch failure, so a
    // transient error can never end everybody's huddle. Ours reaches the same
    // place structurally: no snapshot, no roster, no ending.
    expect(shouldAutoEnd(null, "alice")).toBe(false);
    const call = callWith([{ pubkey: "alice", role: "human" }]);
    // Somebody who is not in it leaving is not the last human leaving.
    expect(shouldAutoEnd(call, "stranger")).toBe(false);
    const ended = foldHuddles(
      [
        ev(KIND_HUDDLE_STARTED, { id: "h1", pubkey: "alice", created_at: NOW_SECS - 60 }),
        ev(KIND_HUDDLE_ENDED, { e: "h1", created_at: NOW_SECS - 10 }),
      ],
      NOW,
    )[0];
    expect(shouldAutoEnd(ended, "alice")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reactions and captions, as values
// ---------------------------------------------------------------------------

describe("reactions and captions", () => {
  it("clamps a reaction to an emoji rather than a message", () => {
    expect(normalizeReaction("  👍 ")).toBe("👍");
    expect(normalizeReaction("   ")).toBeNull();
    expect([...(normalizeReaction("a".repeat(200)) as string)]).toHaveLength(64);
  });

  it("keeps a transcript bounded, dropping the oldest", () => {
    let lines: ReturnType<typeof appendCaption> = [];
    for (let index = 0; index < 250; index += 1) {
      lines = appendCaption(lines, {
        huddleId: "h1",
        pubkey: "alice",
        name: "Alice",
        isAgent: false,
        text: `line ${index}`,
        at: index,
      });
    }
    // A pane, not an archive: a two-hour call must not be a tab that dies.
    expect(lines).toHaveLength(200);
    expect(lines[lines.length - 1].text).toBe("line 249");
  });
});

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

describe("starting a huddle", () => {
  it("puts the whole call on the log, signed by the right principals", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as {
      huddleId: string;
      created: boolean;
    };
    expect(started.created).toBe(true);

    const starts = await eventsOfKind(t, KIND_HUDDLE_STARTED);
    expect(starts).toHaveLength(1);
    // **The huddle's id is the id of the event that announced it.** No uuid, no
    // counter, nothing a client could collide on purpose.
    expect(starts[0].eventId).toBe(started.huddleId);
    // Signed by the person who started it, and it verifies as a real Nostr
    // event — not "Nostr-flavoured".
    expect(starts[0].pubkey).toBe(pubkeyOf(ALICE));
    expect(
      verifyEvent({
        id: starts[0].eventId,
        pubkey: starts[0].pubkey,
        created_at: starts[0].createdAt,
        kind: starts[0].kind,
        tags: starts[0].tags,
        content: starts[0].content,
        sig: starts[0].sig,
      }),
    ).toBe(true);

    // The join is signed by the **community relay**, with the participant in
    // the `p` tag — a member must not be able to write "Bob left".
    const joins = await eventsOfKind(t, KIND_HUDDLE_PARTICIPANT_JOINED);
    expect(joins).toHaveLength(1);
    expect(joins[0].pubkey).toBe(relayPubkeyFor(scope));
    expect(joins[0].tags).toContainEqual(["p", pubkeyOf(ALICE)]);
    expect(joins[0].tags).toContainEqual(["role", "human"]);
    expect(joins[0].tags).toContainEqual(["e", started.huddleId]);
    expect(joins[0].tags).toContainEqual(["h", channelId]);

    // The briefing agents read, published before anybody could have joined.
    const guidelines = await eventsOfKind(t, KIND_HUDDLE_GUIDELINES);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0].createdAt).toBeLessThanOrEqual(joins[0].createdAt);
    expect(guidelines[0].pubkey).toBe(pubkeyOf(ALICE));
  });

  it("returns the call that is already running instead of opening a second one", async () => {
    const { t, scope, channelId } = await seed();
    const first = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    const second = (await t
      .withIdentity(BOB)
      .mutation(huddle.start, { ...scope, channelId })) as {
      huddleId: string;
      created: boolean;
    };
    // Two calls in one room split a conversation with no way for anybody to
    // tell which one the others are in.
    expect(second.created).toBe(false);
    expect(second.huddleId).toBe(first.huddleId);
    expect(await eventsOfKind(t, KIND_HUDDLE_STARTED)).toHaveLength(1);
  });

  it("is visible to the room, with names resolved", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    const view = (await t
      .withIdentity(BOB)
      .query(huddle.forChannel, { ...scope, channelId })) as {
      huddles: { huddleId: string; participants: { pubkey: string }[] }[];
      names: Record<string, { name: string; isAgent: boolean }>;
      viewerPubkey: string;
    };
    expect(view.huddles[0].huddleId).toBe(started.huddleId);
    expect(view.viewerPubkey).toBe(pubkeyOf(BOB));
    expect(view.names[pubkeyOf(ALICE)]).toEqual({ name: ALICE.subject, isAgent: false });
  });
});

describe("joining and leaving", () => {
  it("is idempotent, and a second join writes nothing", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    const first = (await t
      .withIdentity(BOB)
      .mutation(huddle.join, { ...scope, channelId, huddleId: started.huddleId })) as {
      joined: boolean;
    };
    const again = (await t
      .withIdentity(BOB)
      .mutation(huddle.join, { ...scope, channelId, huddleId: started.huddleId })) as {
      joined: boolean;
    };
    expect(first.joined).toBe(true);
    expect(again.joined).toBe(false);
    expect(await eventsOfKind(t, KIND_HUDDLE_PARTICIPANT_JOINED)).toHaveLength(2);
  });

  it("ends the call when the last human leaves, and never before", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    await t
      .withIdentity(BOB)
      .mutation(huddle.join, { ...scope, channelId, huddleId: started.huddleId });

    const bobOut = (await t
      .withIdentity(BOB)
      .mutation(huddle.leave, { ...scope, channelId, huddleId: started.huddleId })) as {
      ended: boolean;
    };
    expect(bobOut.ended).toBe(false);
    expect(await eventsOfKind(t, KIND_HUDDLE_ENDED)).toHaveLength(0);

    const aliceOut = (await t
      .withIdentity(ALICE)
      .mutation(huddle.leave, { ...scope, channelId, huddleId: started.huddleId })) as {
      ended: boolean;
    };
    expect(aliceOut.ended).toBe(true);
    const ends = await eventsOfKind(t, KIND_HUDDLE_ENDED);
    expect(ends).toHaveLength(1);
    // The end is relay-signed too: a member writing "this call is over" would
    // be a member hanging up on everybody.
    expect(ends[0].pubkey).toBe(relayPubkeyFor(scope));
    expect(ends[0].tags).toContainEqual(["e", started.huddleId]);
  });

  it("refuses to rejoin a call that has ended", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    await t
      .withIdentity(ALICE)
      .mutation(huddle.leave, { ...scope, channelId, huddleId: started.huddleId });
    await expect(
      t.withIdentity(BOB).mutation(huddle.join, {
        ...scope,
        channelId,
        huddleId: started.huddleId,
      }),
    ).rejects.toThrow(/has ended/);
  });

  it("lets whoever started it end it for everybody, and nobody else", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(BOB)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    await t
      .withIdentity(CAROL)
      .mutation(huddle.join, { ...scope, channelId, huddleId: started.huddleId });

    await expect(
      t.withIdentity(CAROL).mutation(huddle.end, {
        ...scope,
        channelId,
        huddleId: started.huddleId,
      }),
    ).rejects.toThrow(/started this huddle/);

    // The workspace owner is the "creator vanished" escape hatch, and it is the
    // same bar every other act that changes what everyone sees uses.
    const ended = (await t
      .withIdentity(ALICE)
      .mutation(huddle.end, { ...scope, channelId, huddleId: started.huddleId })) as {
      ended: boolean;
    };
    expect(ended.ended).toBe(true);
  });
});

describe("the tenancy fence", () => {
  it("refuses somebody who is not in the community", async () => {
    const { t, scope, channelId } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).mutation(huddle.start, { ...scope, channelId }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER).query(huddle.forChannel, { ...scope, channelId }),
    ).rejects.toThrow();
  });

  it("refuses somebody in the community who is not in the room", async () => {
    const { t, scope } = await seed();
    // A private room Bob is not in. He cannot see it, so he cannot huddle in it
    // — and the refusal is "not found", because whether a private room exists
    // is itself what a private room is keeping.
    const secret = (await t
      .withIdentity(ALICE)
      .mutation(channels.create, { ...scope, name: "acquisition", visibility: "private" })) as {
      channelId: string;
    };
    await expect(
      t.withIdentity(BOB).mutation(huddle.start, { ...scope, channelId: secret.channelId }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses an agent whose key belongs to another community", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    const otherScope = { scopeType: "user" as const, scopeId: ALICE.subject };
    await expect(
      t.mutation(huddle.agentJoin, {
        apiKey: SCOUT_API_KEY,
        ...otherScope,
        channelId,
        huddleId: started.huddleId,
      }),
    ).rejects.toThrow(/does not belong to that community/);
  });
});

describe("an agent in the call", () => {
  it("joins exactly the way a person does", async () => {
    const { t, scope, channelId, scoutId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId, agentIds: [scoutId] })) as {
      huddleId: string;
      agentsInvited: string[];
      agentErrors: { error: string }[];
    };
    expect(started.agentErrors).toEqual([]);
    expect(started.agentsInvited).toEqual([scoutId]);

    const joins = await eventsOfKind(t, KIND_HUDDLE_PARTICIPANT_JOINED);
    const scoutJoin = joins.find((row) =>
      row.tags.some((tag: string[]) => tag[1] === publicKeyFromSecret(SCOUT_SECRET)),
    );
    // Same kind, same relay signature, same `p` tag, same `e` tag. One boolean
    // different — which is what puts a machine in the participant list beside
    // people rather than in a panel about machines.
    expect(scoutJoin).toBeDefined();
    expect(scoutJoin?.pubkey).toBe(relayPubkeyFor(scope));
    expect(scoutJoin?.tags).toContainEqual(["role", "bot"]);

    // And it was put in the *room* as well, through the one write path for
    // that fact — an agent in a call it cannot read the room of would hear the
    // audio and see none of the conversation.
    const membership = await t.run(async (ctx: Ctx) => {
      const rows = await ctx.db.query("buzzMemberships").collect();
      return rows.find(
        (row: { channelId: string; actorId: string }) =>
          row.channelId === channelId && row.actorId === scoutId,
      );
    });
    expect(membership?.role).toBe("bot");
  });

  it("joins under its own key, and its leaving does not end the call", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    // The agent has to be in the room before it can be in a call there.
    await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: (await scoutIdOf(t)) as string, actorType: "agent" }],
      role: "bot",
    });

    const joined = (await t.mutation(huddle.agentJoin, {
      apiKey: SCOUT_API_KEY,
      ...scope,
      channelId,
      huddleId: started.huddleId,
    })) as { joined: boolean };
    expect(joined.joined).toBe(true);

    const left = (await t.mutation(huddle.agentLeave, {
      apiKey: SCOUT_API_KEY,
      ...scope,
      channelId,
      huddleId: started.huddleId,
    })) as { ended: boolean };
    // Alice is still in it. A machine leaving is not the last human leaving.
    expect(left.ended).toBe(false);
  });

  it("refuses a list-restricted agent, and says why", async () => {
    const { t, scope, channelId, fencedId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId, agentIds: [fencedId] })) as {
      agentsInvited: string[];
      agentErrors: { agentId: string; error: string }[];
    };
    // Skipped with a reason rather than fatal: refusing the whole call because
    // one machine is fenced would be a worse answer to a problem the person can
    // see and fix.
    expect(started.agentsInvited).toEqual([]);
    expect(started.agentErrors[0].agentId).toBe(fencedId);
    expect(started.agentErrors[0].error).toMatch(/restricted to specific lists/);
  });
});

describe("reactions", () => {
  it("are signed and never stored", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    await t.withIdentity(ALICE).mutation(huddle.react, {
      ...scope,
      channelId,
      huddleId: started.huddleId,
      emoji: "👍",
    });
    // 24810 is in the ephemeral band: signed, handed back for fan-out, never
    // written. A permanent record of every thumbs-up in every call would be a
    // table growing at the rate of a gesture.
    expect(await eventsOfKind(t, KIND_HUDDLE_REACTION)).toHaveLength(0);
  });

  it("refuse somebody who is not in the call", async () => {
    const { t, scope, channelId } = await seed();
    const started = (await t
      .withIdentity(ALICE)
      .mutation(huddle.start, { ...scope, channelId })) as { huddleId: string };
    await expect(
      t.withIdentity(BOB).mutation(huddle.react, {
        ...scope,
        channelId,
        huddleId: started.huddleId,
        emoji: "👍",
      }),
    ).rejects.toThrow(/not in this huddle/);
  });
});

/** The seeded agent's id, read back rather than threaded through every call. */
async function scoutIdOf(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("agents").collect();
    return rows.find((row) => row.name === "Scout")?._id;
  });
}
