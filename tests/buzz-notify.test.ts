import { describe, expect, it } from "vitest";
import {
  CHANNEL_MESSAGE_EVENT_KINDS,
  COMING_SOON_SLOTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_SLOT_ALERTS_ENABLED,
  DM_NOTIFIABLE_EVENT_KINDS,
  EMPTY_MUTE_STORE,
  NOTIFICATION_BODY_LIMIT,
  NOTIFY_REASON,
  RECOMMENDED_SOUND_BY_SLOT,
  SLOT_DESCRIPTIONS,
  SLOT_LABELS,
  SOUND_SLOTS,
  SUPPRESSED_REASON,
  SUPPRESSION_EXPLANATION,
  SUPPRESSION_ITEM,
  allSlotAlertsEnabled,
  channelIdFromTags,
  decide,
  formatNotificationTitle,
  hasMentionForEvent,
  isBadgeItemVisible,
  isBroadcastReply,
  isHighPriorityEventForUser,
  isNotifiableKind,
  isThreadReply,
  mergeMuteStores,
  mutedIdsOf,
  normalizeNotificationSettings,
  parseMutePayload,
  resolveNotificationChannelLabel,
  resolveSlotSound,
  setAllSlotAlertsEnabled,
  setMuted,
  setSlotAlertEnabled,
  setSlotSound,
  shouldNotifyForEvent,
  slotForEvent,
  threadReferenceFrom,
  truncateNotificationBody,
  type NotifyContext,
  type NotifyEvent,
  type NotifyRelationship,
  type SoundSlot,
} from "@/lib/buzz/notify";

// The executable half of 01-core-comms §7.
//
// Two things are being tested here and only one of them is "does each rule
// work". The other is **the order**, which §7.1 calls the specification and §10
// item 32 restates: broadcast and mention outrank a channel mute, a thread mute
// outranks participation/follow/authorship, and every suppression runs before
// any delivery decision. Every individual rule can pass while the ordering is
// wrong, and the product is then broken in the way nobody notices — a
// notification that does not arrive leaves no trace.
//
// So the ordering has its own describe block, and each case in it is
// constructed so that **two rules disagree**: whichever fires is proof of the
// order. Those are the tests that fail if somebody "simplifies" `decide` into a
// chain of ANDs.

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

const CHANNEL = "channel-1";
const OTHER_CHANNEL = "channel-2";
const ROOT = "root-1";

let seq = 0;

/** A plain top-level message in #channel-1, written by somebody else. */
function evt(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    pubkey: OTHER,
    kind: 9,
    created_at: 1_700_000_000,
    tags: [
      ["p", OTHER],
      ["h", CHANNEL],
    ],
    content: "hello",
    ...overrides,
  };
}

/** A reply, tagged the way `messageTags` tags one. */
function reply(opts: {
  root?: string;
  parent?: string;
  mentions?: string[];
  broadcast?: boolean;
  channel?: string;
  author?: string;
} = {}): NotifyEvent {
  const root = opts.root ?? ROOT;
  const parent = opts.parent ?? root;
  const tags: string[][] = [
    ["p", opts.author ?? OTHER],
    ["h", opts.channel ?? CHANNEL],
    ...(opts.mentions ?? []).map((pk) => ["p", pk]),
  ];
  if (parent === root) {
    tags.push(["e", root, "", "reply"]);
  } else {
    tags.push(["e", root, "", "root"]);
    tags.push(["e", parent, "", "reply"]);
  }
  if (opts.broadcast) tags.push(["broadcast", "1"]);
  return evt({ tags, pubkey: opts.author ?? OTHER });
}

function ctx(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    me: ME,
    settings: DEFAULT_NOTIFICATION_SETTINGS,
    ...overrides,
  };
}

const set = (...ids: string[]) => new Set(ids);

// ===========================================================================
// Tag reading
// ===========================================================================

describe("tag grammar", () => {
  it("reads a direct reply's parent and root as the same id", () => {
    expect(threadReferenceFrom(reply().tags)).toEqual({ parentId: ROOT, rootId: ROOT });
  });

  it("reads a nested reply's parent and root separately", () => {
    const nested = reply({ root: ROOT, parent: "mid" });
    expect(threadReferenceFrom(nested.tags)).toEqual({ parentId: "mid", rootId: ROOT });
  });

  it("treats an unmarked e tag as a link, not a parent", () => {
    // This is the property that keeps a reaction (an `e` tag and nothing else)
    // out of the thread graph. Lose it and every reaction reparents itself.
    expect(threadReferenceFrom([["e", ROOT]])).toEqual({ parentId: null, rootId: null });
  });

  it("takes the FIRST root marker and the LAST reply marker", () => {
    const tags = [
      ["e", "root-a", "", "root"],
      ["e", "root-b", "", "root"],
      ["e", "parent-a", "", "reply"],
      ["e", "parent-b", "", "reply"],
    ];
    expect(threadReferenceFrom(tags)).toEqual({ parentId: "parent-b", rootId: "root-a" });
  });

  it("recognises a broadcast only on the exact tag value", () => {
    expect(isBroadcastReply([["broadcast", "1"]])).toBe(true);
    expect(isBroadcastReply([["broadcast", "true"]])).toBe(false);
    expect(isBroadcastReply([["broadcast"]])).toBe(false);
  });

  it("finds a mention case-insensitively", () => {
    const event = evt({ tags: [["p", ME.toUpperCase()]] });
    expect(hasMentionForEvent(event, ME)).toBe(true);
    expect(hasMentionForEvent(event, ME.toUpperCase())).toBe(true);
  });

  it("never matches an empty reader pubkey", () => {
    // Before the key bootstrap runs the reader has no pubkey. A malformed
    // `["p", ""]` tag anywhere would otherwise notify every signed-out client.
    expect(hasMentionForEvent(evt({ tags: [["p", ""]] }), "")).toBe(false);
    expect(hasMentionForEvent(evt({ tags: [["p", ""]] }), "   ")).toBe(false);
  });

  it("reads the channel from the first h tag", () => {
    expect(channelIdFromTags([["h", CHANNEL], ["h", OTHER_CHANNEL]])).toBe(CHANNEL);
    expect(channelIdFromTags([["p", ME]])).toBeNull();
  });

  it("does not call a broadcast a thread reply", () => {
    expect(isThreadReply(reply().tags)).toBe(true);
    expect(isThreadReply(reply({ broadcast: true }).tags)).toBe(false);
    expect(isThreadReply(evt().tags)).toBe(false);
  });

  it("high priority is mention or broadcast, nothing else", () => {
    expect(isHighPriorityEventForUser(reply({ mentions: [ME] }), ME)).toBe(true);
    expect(isHighPriorityEventForUser(reply({ broadcast: true }), ME)).toBe(true);
    expect(isHighPriorityEventForUser(reply(), ME)).toBe(false);
  });
});

// ===========================================================================
// §7.1 — every one of the nine steps
// ===========================================================================

describe("shouldNotifyForEvent — the nine steps", () => {
  it("step 1: a broadcast reply always notifies", () => {
    const decision = shouldNotifyForEvent(reply({ broadcast: true }), ME);
    expect(decision).toMatchObject({
      notify: true,
      step: 1,
      reason: NOTIFY_REASON.BROADCAST_REPLY,
    });
  });

  it("step 2: a mention notifies", () => {
    const decision = shouldNotifyForEvent(reply({ mentions: [ME] }), ME);
    expect(decision).toMatchObject({ notify: true, step: 2, reason: NOTIFY_REASON.MENTION });
  });

  it("step 3: a muted channel suppresses", () => {
    const decision = shouldNotifyForEvent(evt(), ME, { mutedChannelIds: set(CHANNEL) });
    expect(decision).toMatchObject({
      notify: false,
      step: 3,
      reason: SUPPRESSED_REASON.CHANNEL_MUTED,
    });
  });

  it("step 3 only mutes the channel it names", () => {
    const decision = shouldNotifyForEvent(evt(), ME, { mutedChannelIds: set(OTHER_CHANNEL) });
    expect(decision.step).toBe(4);
  });

  it("step 4: a top-level message notifies", () => {
    const decision = shouldNotifyForEvent(evt(), ME);
    expect(decision).toMatchObject({ notify: true, step: 4, reason: NOTIFY_REASON.TOP_LEVEL });
  });

  it("step 5: a muted thread root suppresses", () => {
    const decision = shouldNotifyForEvent(reply(), ME, { mutedRootIds: set(ROOT) });
    expect(decision).toMatchObject({
      notify: false,
      step: 5,
      reason: SUPPRESSED_REASON.THREAD_MUTED,
    });
  });

  it("step 5 mutes by ROOT, so a nested reply is caught too", () => {
    const nested = reply({ root: ROOT, parent: "mid" });
    expect(shouldNotifyForEvent(nested, ME, { mutedRootIds: set(ROOT) }).step).toBe(5);
    // ...and muting the intermediate message is not muting the thread.
    expect(shouldNotifyForEvent(nested, ME, { mutedRootIds: set("mid") }).notify).toBe(false);
    expect(shouldNotifyForEvent(nested, ME, { mutedRootIds: set("mid") }).step).toBe(9);
  });

  it("step 6: a thread I have replied in notifies", () => {
    const decision = shouldNotifyForEvent(reply(), ME, { participatedRootIds: set(ROOT) });
    expect(decision).toMatchObject({
      notify: true,
      step: 6,
      reason: NOTIFY_REASON.PARTICIPATED,
    });
  });

  it("step 7: a thread I follow notifies", () => {
    const decision = shouldNotifyForEvent(reply(), ME, { followedRootIds: set(ROOT) });
    expect(decision).toMatchObject({ notify: true, step: 7, reason: NOTIFY_REASON.FOLLOWED });
  });

  it("step 8: a thread I started notifies", () => {
    const decision = shouldNotifyForEvent(reply(), ME, { authoredRootIds: set(ROOT) });
    expect(decision).toMatchObject({ notify: true, step: 8, reason: NOTIFY_REASON.AUTHORED });
  });

  it("step 9: a reply in somebody else's thread is silence", () => {
    const decision = shouldNotifyForEvent(reply(), ME);
    expect(decision).toMatchObject({
      notify: false,
      step: 9,
      reason: SUPPRESSED_REASON.UNRELATED_THREAD,
    });
  });

  it("an event with no h tag cannot be suppressed by a channel mute", () => {
    // Failing to suppress costs a notification somebody can mute. Failing to
    // notify costs a message nobody ever sees. The safe direction is this one.
    const homeless = evt({ tags: [["p", OTHER]] });
    expect(shouldNotifyForEvent(homeless, ME, { mutedChannelIds: set(CHANNEL) }).step).toBe(4);
  });

  it("does not check authorship — that is item 3 of the pipeline", () => {
    // `messageTags` writes the author's own key as the first `p` tag, so by
    // §7.1 every message mentions its author. The predicate is documented not
    // to care; `decide` catches it earlier. Pinning this here means the two
    // cannot silently swap responsibility.
    const mine = evt({ pubkey: ME, tags: [["p", ME], ["h", CHANNEL]] });
    expect(shouldNotifyForEvent(mine, ME)).toMatchObject({
      notify: true,
      step: 2,
      reason: NOTIFY_REASON.MENTION,
    });
  });
});

// ===========================================================================
// §7.1 — the ORDER, which is the specification
// ===========================================================================

describe("shouldNotifyForEvent — ordering (two rules disagree, the earlier wins)", () => {
  const mutedEverything: NotifyRelationship = {
    mutedChannelIds: set(CHANNEL),
    mutedRootIds: set(ROOT),
  };

  it("1 before 3: a broadcast pierces a channel mute", () => {
    // Step 1 says notify, step 3 says suppress. Step 1 wins.
    const decision = shouldNotifyForEvent(reply({ broadcast: true }), ME, mutedEverything);
    expect(decision.notify).toBe(true);
    expect(decision.step).toBe(1);
  });

  it("2 before 3: a mention pierces a channel mute", () => {
    const decision = shouldNotifyForEvent(reply({ mentions: [ME] }), ME, {
      mutedChannelIds: set(CHANNEL),
    });
    expect(decision.notify).toBe(true);
    expect(decision.step).toBe(2);
  });

  it("1 before 5: a broadcast pierces a thread mute too", () => {
    const decision = shouldNotifyForEvent(reply({ broadcast: true }), ME, {
      mutedRootIds: set(ROOT),
    });
    expect(decision.step).toBe(1);
  });

  it("2 before 5: a mention pierces a thread mute", () => {
    const decision = shouldNotifyForEvent(reply({ mentions: [ME] }), ME, {
      mutedRootIds: set(ROOT),
    });
    expect(decision.step).toBe(2);
  });

  it("3 before 4: a top-level message in a muted channel is silent", () => {
    // Step 3 says suppress, step 4 says notify. Step 3 wins — otherwise a
    // channel mute would only ever apply to replies, which is nothing anybody
    // means by muting a channel.
    const decision = shouldNotifyForEvent(evt(), ME, { mutedChannelIds: set(CHANNEL) });
    expect(decision.notify).toBe(false);
    expect(decision.step).toBe(3);
  });

  it("5 before 6: a thread mute outranks having replied there", () => {
    const decision = shouldNotifyForEvent(reply(), ME, {
      mutedRootIds: set(ROOT),
      participatedRootIds: set(ROOT),
    });
    expect(decision.notify).toBe(false);
    expect(decision.step).toBe(5);
  });

  it("5 before 7: a thread mute outranks following it", () => {
    const decision = shouldNotifyForEvent(reply(), ME, {
      mutedRootIds: set(ROOT),
      followedRootIds: set(ROOT),
    });
    expect(decision.step).toBe(5);
  });

  it("5 before 8: a thread mute outranks having started it", () => {
    // The case the control exists for. The loudest thread in a room is
    // usually one you started; if authorship outranked the mute it could
    // never be silenced.
    const decision = shouldNotifyForEvent(reply({ author: OTHER }), ME, {
      mutedRootIds: set(ROOT),
      authoredRootIds: set(ROOT),
    });
    expect(decision.notify).toBe(false);
    expect(decision.step).toBe(5);
  });

  it("6 before 7 before 8 when all three relationships hold", () => {
    const all: NotifyRelationship = {
      participatedRootIds: set(ROOT),
      followedRootIds: set(ROOT),
      authoredRootIds: set(ROOT),
    };
    expect(shouldNotifyForEvent(reply(), ME, all).step).toBe(6);
    expect(
      shouldNotifyForEvent(reply(), ME, { ...all, participatedRootIds: set() }).step,
    ).toBe(7);
    expect(
      shouldNotifyForEvent(reply(), ME, {
        ...all,
        participatedRootIds: set(),
        followedRootIds: set(),
      }).step,
    ).toBe(8);
  });

  it("the steps are visited in strictly ascending order across a battery", () => {
    // A structural check rather than a behavioural one: each case below is
    // built so that every rule from `step` onward would also have fired, so a
    // reordering shows up as a lower number than expected.
    const cases: { event: NotifyEvent; rel: NotifyRelationship; step: number }[] = [
      { event: reply({ broadcast: true, mentions: [ME] }), rel: mutedEverything, step: 1 },
      { event: reply({ mentions: [ME] }), rel: mutedEverything, step: 2 },
      { event: reply(), rel: mutedEverything, step: 3 },
      { event: evt(), rel: {}, step: 4 },
      {
        event: reply(),
        rel: {
          mutedRootIds: set(ROOT),
          participatedRootIds: set(ROOT),
          followedRootIds: set(ROOT),
          authoredRootIds: set(ROOT),
        },
        step: 5,
      },
      {
        event: reply(),
        rel: {
          participatedRootIds: set(ROOT),
          followedRootIds: set(ROOT),
          authoredRootIds: set(ROOT),
        },
        step: 6,
      },
      { event: reply(), rel: { followedRootIds: set(ROOT), authoredRootIds: set(ROOT) }, step: 7 },
      { event: reply(), rel: { authoredRootIds: set(ROOT) }, step: 8 },
      { event: reply(), rel: {}, step: 9 },
    ];
    for (const c of cases) {
      expect(shouldNotifyForEvent(c.event, ME, c.rel).step).toBe(c.step);
    }
  });
});

// ===========================================================================
// §7.6 — each of the eleven suppressions, one at a time
// ===========================================================================

describe("decide — the eleven suppressions", () => {
  it("1: alerts off", () => {
    const decision = decide(
      evt(),
      ctx({ settings: { ...DEFAULT_NOTIFICATION_SETTINGS, desktopEnabled: false } }),
    );
    expect(decision).toMatchObject({
      deliver: false,
      item: 1,
      reason: SUPPRESSED_REASON.ALERTS_OFF,
    });
  });

  it("1: OS permission not granted", () => {
    for (const permission of ["denied", "default", "unsupported"] as const) {
      expect(decide(evt(), ctx({ permission })).item).toBe(1);
    }
    expect(decide(evt(), ctx({ permission: "granted" })).deliver).toBe(true);
  });

  it("1: a path with no permission concept (server delivery) is not suppressed", () => {
    // Email and agent pings have no browser permission to consult. Requiring a
    // fake "granted" would be a lie every server caller has to remember.
    expect(decide(evt(), ctx()).deliver).toBe(true);
  });

  it("2: the slot is switched off", () => {
    const settings = setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "needs_action", false);
    const decision = decide(evt(), ctx({ settings }));
    expect(decision).toMatchObject({
      deliver: false,
      item: 2,
      reason: SUPPRESSED_REASON.SLOT_OFF,
      slot: "needs_action",
    });
  });

  it("2: turning off @Mentions silences a mention and nothing else", () => {
    const settings = setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "mention", false);
    expect(decide(reply({ mentions: [ME] }), ctx({ settings })).item).toBe(2);
    expect(decide(evt(), ctx({ settings })).deliver).toBe(true);
  });

  it("3: self-authored", () => {
    const decision = decide(evt({ pubkey: ME }), ctx());
    expect(decision).toMatchObject({
      deliver: false,
      item: 3,
      reason: SUPPRESSED_REASON.SELF_AUTHORED,
    });
  });

  it("3: authorship is case-insensitive", () => {
    expect(decide(evt({ pubkey: ME.toUpperCase() }), ctx()).item).toBe(3);
  });

  it("3: a reader with no pubkey yet is not the author of everything", () => {
    expect(decide(evt({ pubkey: "" }), ctx({ me: "" })).item).not.toBe(3);
  });

  it("4: already delivered this session", () => {
    const event = evt();
    const decision = decide(event, ctx({ deliveredEventIds: set(event.id) }));
    expect(decision).toMatchObject({
      deliver: false,
      item: 4,
      reason: SUPPRESSED_REASON.ALREADY_DELIVERED,
    });
  });

  it("5: the initial feed load", () => {
    const decision = decide(evt(), ctx({ initialLoad: true }));
    expect(decision).toMatchObject({
      deliver: false,
      item: 5,
      reason: SUPPRESSED_REASON.INITIAL_LOAD,
    });
  });

  it("6: backlog replayed after a reconnect", () => {
    const decision = decide(
      evt({ created_at: 1_000 }),
      ctx({ subscriptionStartedAt: 2_000 }),
    );
    expect(decision).toMatchObject({
      deliver: false,
      item: 6,
      reason: SUPPRESSED_REASON.BACKLOG_REPLAY,
    });
    // An event exactly at the subscription boundary is news, not backlog.
    expect(decide(evt({ created_at: 2_000 }), ctx({ subscriptionStartedAt: 2_000 })).deliver).toBe(
      true,
    );
  });

  it("7: the channel is the one on screen", () => {
    const decision = decide(evt(), ctx({ activeChannelId: CHANNEL }));
    expect(decision).toMatchObject({
      deliver: false,
      item: 7,
      reason: SUPPRESSED_REASON.VIEWING_CHANNEL,
    });
  });

  it("7: 'notify while viewing' opts back in", () => {
    const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, notifyWhileViewing: true };
    expect(decide(evt(), ctx({ activeChannelId: CHANNEL, settings })).deliver).toBe(true);
  });

  it("7: another room on screen suppresses nothing", () => {
    expect(decide(evt(), ctx({ activeChannelId: OTHER_CHANNEL })).deliver).toBe(true);
  });

  it("8: the channel is muted (and it is the predicate that says so)", () => {
    const decision = decide(
      evt(),
      ctx({ relationship: { mutedChannelIds: set(CHANNEL) } }),
    );
    expect(decision).toMatchObject({
      deliver: false,
      item: 8,
      reason: SUPPRESSED_REASON.CHANNEL_MUTED,
    });
    expect(decision.predicate).toMatchObject({ step: 3 });
  });

  it("9: the thread root is muted", () => {
    const decision = decide(reply(), ctx({ relationship: { mutedRootIds: set(ROOT) } }));
    expect(decision).toMatchObject({
      deliver: false,
      item: 9,
      reason: SUPPRESSED_REASON.THREAD_MUTED,
    });
    expect(decision.predicate).toMatchObject({ step: 5 });
  });

  it("10: the kind is not human-visible new content", () => {
    for (const kind of [5, 7, 9005, 40003, 40008, 40099]) {
      const decision = decide(evt({ kind }), ctx());
      expect(decision).toMatchObject({
        deliver: false,
        item: 10,
        reason: SUPPRESSED_REASON.KIND_NOT_NOTIFIABLE,
      });
    }
  });

  it("10: huddle-start notifies in a DM and nowhere else", () => {
    expect(decide(evt({ kind: 48100 }), ctx({ isDm: true })).deliver).toBe(true);
    expect(decide(evt({ kind: 48100 }), ctx({ isDm: false })).item).toBe(10);
  });

  it("10: every channel message kind is notifiable", () => {
    for (const kind of CHANNEL_MESSAGE_EVENT_KINDS) {
      expect(decide(evt({ kind }), ctx()).deliver).toBe(true);
    }
    expect(DM_NOTIFIABLE_EVENT_KINDS).toEqual([...CHANNEL_MESSAGE_EVENT_KINDS, 48100]);
    expect(isNotifiableKind(48100, true)).toBe(true);
    expect(isNotifiableKind(48100, false)).toBe(false);
  });

  it("11: a reply in a thread I have nothing to do with", () => {
    const decision = decide(reply(), ctx());
    expect(decision).toMatchObject({
      deliver: false,
      item: 11,
      reason: SUPPRESSED_REASON.UNRELATED_THREAD,
    });
    expect(decision.predicate).toMatchObject({ step: 9 });
  });

  it("every suppression reason carries its spec item number, 1 through 11", () => {
    const items = Object.values(SUPPRESSION_ITEM).sort((a, b) => a - b);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Each is nameable — "false" is not an answer to "why didn't I get it".
    for (const reason of Object.values(SUPPRESSED_REASON)) {
      expect(SUPPRESSION_EXPLANATION[reason].length).toBeGreaterThan(0);
    }
  });

  it("a delivered decision explains itself too", () => {
    const decision = decide(reply({ mentions: [ME] }), ctx());
    expect(decision.deliver).toBe(true);
    expect(decision.item).toBeNull();
    expect(decision.reason).toBe(NOTIFY_REASON.MENTION);
    expect(decision.explanation).toBe("You were mentioned.");
  });
});

// ===========================================================================
// §7.6 — the ORDER of the pipeline
// ===========================================================================

describe("decide — ordering (a suppression that runs late does not run)", () => {
  it("1 before everything: alerts off outranks a mention", () => {
    // A mention is the loudest thing the predicate can say. The master switch
    // is still louder, or "off" would not mean off.
    const decision = decide(
      reply({ mentions: [ME] }),
      ctx({ settings: { ...DEFAULT_NOTIFICATION_SETTINGS, desktopEnabled: false } }),
    );
    expect(decision.item).toBe(1);
  });

  it("2 before 4: a disabled slot outranks the dedupe guard", () => {
    const event = evt();
    const settings = setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "needs_action", false);
    expect(decide(event, ctx({ settings, deliveredEventIds: set(event.id) })).item).toBe(2);
  });

  it("3 before the predicate: my own message is not a mention of me", () => {
    // The load-bearing one. `messageTags` puts the author's key in the first
    // `p` tag, so the predicate would return MENTION for your own words. If
    // item 3 ever moves below the predicate, you notify yourself on every
    // message you send.
    const mine = evt({ pubkey: ME, tags: [["p", ME], ["h", CHANNEL]] });
    const decision = decide(mine, ctx());
    expect(decision.item).toBe(3);
    expect(decision.reason).toBe(SUPPRESSED_REASON.SELF_AUTHORED);
    expect(decision.predicate).toBeNull();
  });

  it("3 before 8: my own message in a muted channel reads as mine", () => {
    const mine = evt({ pubkey: ME });
    expect(decide(mine, ctx({ relationship: { mutedChannelIds: set(CHANNEL) } })).item).toBe(3);
  });

  it("4 before 5: a duplicate is a duplicate even on the first load", () => {
    const event = evt();
    expect(
      decide(event, ctx({ deliveredEventIds: set(event.id), initialLoad: true })).item,
    ).toBe(4);
  });

  it("5 before 6: the initial load explains itself before the clock does", () => {
    expect(
      decide(evt({ created_at: 1_000 }), ctx({ initialLoad: true, subscriptionStartedAt: 2_000 }))
        .item,
    ).toBe(5);
  });

  it("6 before 7: replayed backlog for the open room reads as backlog", () => {
    expect(
      decide(
        evt({ created_at: 1_000 }),
        ctx({ subscriptionStartedAt: 2_000, activeChannelId: CHANNEL }),
      ).item,
    ).toBe(6);
  });

  it("7 before 8: 'you were looking at it' beats 'you muted it'", () => {
    expect(
      decide(
        evt(),
        ctx({ activeChannelId: CHANNEL, relationship: { mutedChannelIds: set(CHANNEL) } }),
      ).item,
    ).toBe(7);
  });

  it("10 before the predicate: a reaction is not a top-level message", () => {
    // A reaction carries an unmarked `e` tag, so `threadReferenceFrom` reports
    // no parent and the predicate reaches step 4 — "top-level, notify". Every
    // reaction in the room would fire. This is why item 10 is hoisted.
    const reaction = evt({ kind: 7, tags: [["e", ROOT]], content: "👍" });
    const decision = decide(reaction, ctx());
    expect(decision.item).toBe(10);
    expect(decision.predicate).toBeNull();
    // ...and the predicate on its own genuinely would have said yes.
    expect(shouldNotifyForEvent(reaction, ME).notify).toBe(true);
  });

  it("10 before the predicate even for a reaction that tags me", () => {
    const reaction = evt({ kind: 7, tags: [["e", ROOT], ["p", ME]] });
    expect(decide(reaction, ctx()).item).toBe(10);
  });

  it("the pipeline visits its items in ascending order across a battery", () => {
    const event = evt();
    const stack: NotifyContext = ctx({
      settings: setSlotAlertEnabled(
        { ...DEFAULT_NOTIFICATION_SETTINGS, desktopEnabled: false },
        "needs_action",
        false,
      ),
      deliveredEventIds: set(event.id),
      initialLoad: true,
      subscriptionStartedAt: event.created_at + 1,
      activeChannelId: CHANNEL,
      relationship: { mutedChannelIds: set(CHANNEL) },
    });
    // Every suppression from 1 to 8 applies at once. Peeling them off one at a
    // time must reveal them in order — that is the whole property.
    expect(decide(event, stack).item).toBe(1);
    const s2 = { ...stack, settings: { ...stack.settings, desktopEnabled: true } };
    expect(decide(event, s2).item).toBe(2);
    const s3 = {
      ...s2,
      settings: setSlotAlertEnabled(s2.settings, "needs_action", true),
    };
    expect(decide({ ...event, pubkey: ME }, s3).item).toBe(3);
    expect(decide(event, s3).item).toBe(4);
    const s5 = { ...s3, deliveredEventIds: set() };
    expect(decide(event, s5).item).toBe(5);
    const s6 = { ...s5, initialLoad: false };
    expect(decide(event, s6).item).toBe(6);
    const s7 = { ...s6, subscriptionStartedAt: undefined };
    expect(decide(event, s7).item).toBe(7);
    const s8 = { ...s7, activeChannelId: null };
    expect(decide(event, s8).item).toBe(8);
    const s10 = { ...s8, relationship: {} };
    expect(decide({ ...event, kind: 7 }, s10).item).toBe(10);
    expect(decide(event, s10).deliver).toBe(true);
  });
});

// ===========================================================================
// Slots
// ===========================================================================

describe("slotForEvent", () => {
  it("maps the four agent job kinds to their slots", () => {
    const map: Record<number, SoundSlot> = {
      43002: "job_accepted",
      43003: "job_progress",
      43004: "job_result",
      43006: "job_error",
    };
    for (const [kind, slot] of Object.entries(map)) {
      expect(slotForEvent(evt({ kind: Number(kind) }), { isDm: false, mentionsMe: false })).toBe(
        slot,
      );
    }
  });

  it("a job kind outranks the room it landed in", () => {
    expect(slotForEvent(evt({ kind: 43004 }), { isDm: true, mentionsMe: true })).toBe(
      "job_result",
    );
  });

  it("a mention outranks a DM", () => {
    // Stated as a judgement call in the module: a mention should sound like a
    // mention wherever it lands, or the same event sounds different depending
    // on the room and people stop trusting the settings.
    expect(slotForEvent(evt(), { isDm: true, mentionsMe: true })).toBe("mention");
    expect(slotForEvent(evt(), { isDm: true, mentionsMe: false })).toBe("dm");
  });

  it("a thread reply gets the thread slot, a broadcast does not", () => {
    expect(slotForEvent(reply(), { isDm: false, mentionsMe: false })).toBe("thread_reply");
    expect(slotForEvent(reply({ broadcast: true }), { isDm: false, mentionsMe: false })).toBe(
      "needs_action",
    );
  });

  it("everything else falls back to needs_action", () => {
    expect(slotForEvent(evt(), { isDm: false, mentionsMe: false })).toBe("needs_action");
  });
});

// ===========================================================================
// §7.3 — settings
// ===========================================================================

describe("notification settings", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.desktopEnabled).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.homeBadgeEnabled).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyWhileViewing).toBe(false);
    expect(DEFAULT_NOTIFICATION_SETTINGS.slotAlertsSnapshot).toBeNull();
    for (const slot of SOUND_SLOTS) {
      expect(DEFAULT_NOTIFICATION_SETTINGS.sounds[slot]).toBe("flutter");
      expect(DEFAULT_SLOT_ALERTS_ENABLED[slot]).toBe(slot !== "job_progress");
    }
  });

  it("every slot has a label, a description and a recommended sound", () => {
    for (const slot of SOUND_SLOTS) {
      expect(SLOT_LABELS[slot]).toBeTruthy();
      expect(SLOT_DESCRIPTIONS[slot]).toBeTruthy();
      expect(RECOMMENDED_SOUND_BY_SLOT[slot]).toBeTruthy();
    }
    expect(RECOMMENDED_SOUND_BY_SLOT).toMatchObject({
      dm: "unison",
      mention: "ping",
      thread_reply: "doop",
      needs_action: "doodone",
      job_accepted: "boo",
      job_progress: "dng",
      job_result: "unison",
      job_error: "oh-no",
    });
  });

  it("normalizes junk back to defaults without throwing", () => {
    expect(normalizeNotificationSettings(undefined)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(normalizeNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(normalizeNotificationSettings("nonsense")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(normalizeNotificationSettings(42)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(
      normalizeNotificationSettings({ desktopEnabled: "yes", sounds: { mention: "airhorn" } }),
    ).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("keeps the valid half of a partly-broken row", () => {
    const normalized = normalizeNotificationSettings({
      notifyWhileViewing: true,
      sounds: { mention: "ping", dm: 7 },
      slotAlertsEnabled: { dm: false, mention: "loud" },
      unknownKey: "dropped",
    });
    expect(normalized.notifyWhileViewing).toBe(true);
    expect(normalized.sounds.mention).toBe("ping");
    expect(normalized.sounds.dm).toBe("flutter");
    expect(normalized.slotAlertsEnabled.dm).toBe(false);
    expect(normalized.slotAlertsEnabled.mention).toBe(true);
    expect(Object.keys(normalized)).not.toContain("unknownKey");
  });

  it("is total: every slot is present after normalization", () => {
    const normalized = normalizeNotificationSettings({ sounds: {}, slotAlertsEnabled: {} });
    for (const slot of SOUND_SLOTS) {
      expect(normalized.sounds[slot]).toBeDefined();
      expect(typeof normalized.slotAlertsEnabled[slot]).toBe("boolean");
    }
  });

  it("drops a partial snapshot entirely rather than half-restoring", () => {
    expect(normalizeNotificationSettings({ slotAlertsSnapshot: "x" }).slotAlertsSnapshot).toBeNull();
    const partial = normalizeNotificationSettings({ slotAlertsSnapshot: { dm: false } });
    expect(partial.slotAlertsSnapshot?.dm).toBe(false);
    expect(partial.slotAlertsSnapshot?.mention).toBe(true);
  });

  it("master switch off snapshots then zeroes, and on restores", () => {
    const tuned = setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "thread_reply", false);
    const off = setAllSlotAlertsEnabled(tuned, false);
    expect(off.slotAlertsEnabled.dm).toBe(false);
    expect(off.slotAlertsEnabled.mention).toBe(false);
    expect(off.slotAlertsSnapshot).not.toBeNull();

    const on = setAllSlotAlertsEnabled(off, true);
    expect(on.slotAlertsEnabled.dm).toBe(true);
    expect(on.slotAlertsEnabled.thread_reply).toBe(false); // the pick survived
    expect(on.slotAlertsSnapshot).toBeNull();
  });

  it("master switch on enables everything when the snapshot was all-off", () => {
    // Restoring an all-off snapshot faithfully makes a switch that turns on
    // and does nothing, which reads as broken.
    let settings = DEFAULT_NOTIFICATION_SETTINGS;
    for (const slot of SOUND_SLOTS) settings = setSlotAlertEnabled(settings, slot, false);
    const off = setAllSlotAlertsEnabled(settings, false);
    const on = setAllSlotAlertsEnabled(off, true);
    expect(on.slotAlertsEnabled.dm).toBe(true);
    expect(on.slotAlertsEnabled.mention).toBe(true);
  });

  it("master switch on with no snapshot at all enables everything", () => {
    const on = setAllSlotAlertsEnabled(
      { ...DEFAULT_NOTIFICATION_SETTINGS, slotAlertsSnapshot: null },
      true,
    );
    expect(on.slotAlertsEnabled.needs_action).toBe(true);
  });

  it("a manual pick clears a pending snapshot", () => {
    const off = setAllSlotAlertsEnabled(DEFAULT_NOTIFICATION_SETTINGS, false);
    expect(off.slotAlertsSnapshot).not.toBeNull();
    const picked = setSlotAlertEnabled(off, "dm", true);
    expect(picked.slotAlertsSnapshot).toBeNull();
    // ...so the next master-on does not overwrite what was just chosen.
    const on = setAllSlotAlertsEnabled(picked, true);
    expect(on.slotAlertsEnabled.dm).toBe(true);
  });

  it("the coming-soon slots are untouched by every path", () => {
    const off = setAllSlotAlertsEnabled(DEFAULT_NOTIFICATION_SETTINGS, false);
    const on = setAllSlotAlertsEnabled(off, true);
    for (const slot of COMING_SOON_SLOTS) {
      expect(off.slotAlertsEnabled[slot]).toBe(DEFAULT_SLOT_ALERTS_ENABLED[slot]);
      expect(on.slotAlertsEnabled[slot]).toBe(DEFAULT_SLOT_ALERTS_ENABLED[slot]);
      // A direct toggle is refused too — nothing emits these yet.
      expect(setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, slot, false)).toBe(
        DEFAULT_NOTIFICATION_SETTINGS,
      );
    }
    expect(COMING_SOON_SLOTS).toEqual([
      "job_accepted",
      "job_progress",
      "job_result",
      "job_error",
    ]);
  });

  it("allSlotAlertsEnabled ignores the coming-soon rows", () => {
    // job_progress defaults to off and is coming-soon, so the master switch
    // must still read as "on" out of the box or it flickers on first paint.
    expect(allSlotAlertsEnabled(DEFAULT_NOTIFICATION_SETTINGS)).toBe(true);
    expect(
      allSlotAlertsEnabled(setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "dm", false)),
    ).toBe(false);
  });

  it("sounds are per slot and resolvable", () => {
    const settings = setSlotSound(DEFAULT_NOTIFICATION_SETTINGS, "mention", "ping");
    expect(resolveSlotSound(settings, "mention")).toBe("ping");
    expect(resolveSlotSound(settings, "dm")).toBe("flutter");
  });

  it("never mutates the settings object it was given", () => {
    const before = JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS);
    setAllSlotAlertsEnabled(DEFAULT_NOTIFICATION_SETTINGS, false);
    setSlotAlertEnabled(DEFAULT_NOTIFICATION_SETTINGS, "dm", false);
    setSlotSound(DEFAULT_NOTIFICATION_SETTINGS, "dm", "ping");
    expect(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS)).toBe(before);
  });
});

// ===========================================================================
// §7.5 — muting
// ===========================================================================

describe("mute stores", () => {
  it("rejects anything that is not version 1", () => {
    expect(parseMutePayload({ version: 2, channels: {} })).toBeNull();
    expect(parseMutePayload(null)).toBeNull();
    expect(parseMutePayload("{}")).toBeNull();
    expect(parseMutePayload({ channels: {} })).toBeNull();
  });

  it("drops malformed entries without losing the good ones", () => {
    const parsed = parseMutePayload({
      version: 1,
      channels: {
        good: { muted: true, updatedAt: 5 },
        noTime: { muted: true },
        badTime: { muted: true, updatedAt: "5" },
        notAnObject: true,
        "": { muted: true, updatedAt: 1 },
      },
    });
    expect(parsed).toEqual({ version: 1, channels: { good: { muted: true, updatedAt: 5 } } });
  });

  it("merges last-write-wins per channel", () => {
    const local = { version: 1 as const, channels: { a: { muted: true, updatedAt: 10 } } };
    const remote = {
      version: 1 as const,
      channels: { a: { muted: false, updatedAt: 20 }, b: { muted: true, updatedAt: 1 } },
    };
    const merged = mergeMuteStores(local, remote);
    expect(merged.channels.a).toEqual({ muted: false, updatedAt: 20 });
    expect(merged.channels.b).toEqual({ muted: true, updatedAt: 1 });
  });

  it("local wins a tie", () => {
    const local = { version: 1 as const, channels: { a: { muted: true, updatedAt: 10 } } };
    const remote = { version: 1 as const, channels: { a: { muted: false, updatedAt: 10 } } };
    expect(mergeMuteStores(local, remote).channels.a.muted).toBe(true);
  });

  it("keeps both sides' independent decisions", () => {
    // The reason the clock is per entry: two devices are usually both partly
    // right, and a whole-store winner throws one of them away.
    const laptop = setMuted(EMPTY_MUTE_STORE, "noise", true, 100);
    const phone = setMuted(EMPTY_MUTE_STORE, "ship", true, 101);
    expect(mutedIdsOf(mergeMuteStores(laptop, phone))).toEqual(new Set(["noise", "ship"]));
  });

  it("an unmute survives a merge with a stale mute", () => {
    const stale = setMuted(EMPTY_MUTE_STORE, "noise", true, 100);
    const fresh = setMuted(EMPTY_MUTE_STORE, "noise", false, 200);
    expect(mutedIdsOf(mergeMuteStores(stale, fresh)).has("noise")).toBe(false);
  });

  it("mutedIdsOf feeds the predicate directly", () => {
    const store = setMuted(EMPTY_MUTE_STORE, CHANNEL, true, 1);
    const decision = shouldNotifyForEvent(evt(), ME, { mutedChannelIds: mutedIdsOf(store) });
    expect(decision.reason).toBe(SUPPRESSED_REASON.CHANNEL_MUTED);
  });
});

// ===========================================================================
// §7.4 — formatting
// ===========================================================================

describe("notification formatting", () => {
  it("falls back when the body is blank", () => {
    expect(truncateNotificationBody("   ", "Sent an attachment")).toBe("Sent an attachment");
    expect(truncateNotificationBody("", "x")).toBe("x");
  });

  it("never exceeds the limit it advertises", () => {
    const long = "a".repeat(500);
    const out = truncateNotificationBody(long, "x");
    expect(out.length).toBe(NOTIFICATION_BODY_LIMIT);
    expect(out.endsWith("...")).toBe(true);
  });

  it("leaves a body at exactly the limit alone", () => {
    const exact = "b".repeat(NOTIFICATION_BODY_LIMIT);
    expect(truncateNotificationBody(exact, "x")).toBe(exact);
  });

  it("trims the cut before the ellipsis so there is no dangling space", () => {
    const body = `${"c".repeat(130)} ${"d".repeat(40)}`;
    expect(truncateNotificationBody(body, "x")).not.toContain(" ...");
  });

  it("resolves a channel label or degrades to null", () => {
    const channels = [{ channelId: CHANNEL, name: "ship" }];
    expect(resolveNotificationChannelLabel(CHANNEL, channels)).toBe("#ship");
    expect(resolveNotificationChannelLabel(OTHER_CHANNEL, channels)).toBeNull();
    expect(resolveNotificationChannelLabel(null, channels)).toBeNull();
  });

  it("builds a title with or without a room", () => {
    expect(formatNotificationTitle({ prefix: "Ada", channelLabel: "#ship" })).toBe("Ada in #ship");
    expect(formatNotificationTitle({ prefix: "Ada", channelLabel: null })).toBe("Ada");
    expect(formatNotificationTitle({ prefix: "Ada" })).toBe("Ada");
  });
});

// ===========================================================================
// §7.5 — the home badge, which is a DIFFERENT rule
// ===========================================================================

describe("home badge", () => {
  const muted = set(CHANNEL);

  it("skips a muted channel's items", () => {
    expect(
      isBadgeItemVisible(
        { channelId: CHANNEL, category: "needs_action" },
        DEFAULT_NOTIFICATION_SETTINGS,
        muted,
      ),
    ).toBe(false);
  });

  it("but never a mention", () => {
    expect(
      isBadgeItemVisible(
        { channelId: CHANNEL, category: "mention" },
        DEFAULT_NOTIFICATION_SETTINGS,
        muted,
      ),
    ).toBe(true);
  });

  it("the whole badge switches off", () => {
    expect(
      isBadgeItemVisible(
        { channelId: OTHER_CHANNEL, category: "mention" },
        { ...DEFAULT_NOTIFICATION_SETTINGS, homeBadgeEnabled: false },
        muted,
      ),
    ).toBe(false);
  });

  it("an item with no channel is always visible", () => {
    expect(
      isBadgeItemVisible(
        { channelId: null, category: "needs_action" },
        DEFAULT_NOTIFICATION_SETTINGS,
        muted,
      ),
    ).toBe(true);
  });

  it("differs from the live rule on a broadcast, deliberately", () => {
    // §7.1 step 1 lets a broadcast pierce a channel mute. The badge has no
    // broadcast category at all — it classifies into mention / needs_action —
    // so the same event is silent on the badge and loud in the live path.
    // Two rules, not one rule with an exception.
    const broadcast = reply({ broadcast: true });
    expect(shouldNotifyForEvent(broadcast, ME, { mutedChannelIds: muted }).notify).toBe(true);
    expect(
      isBadgeItemVisible(
        { channelId: CHANNEL, category: "needs_action" },
        DEFAULT_NOTIFICATION_SETTINGS,
        muted,
      ),
    ).toBe(false);
  });
});

// ===========================================================================
// End to end: the sentences the support desk actually hears
// ===========================================================================

describe("the questions this exists to answer", () => {
  it("\"why didn't I get the mention?\" — because the channel was on screen", () => {
    const decision = decide(reply({ mentions: [ME] }), ctx({ activeChannelId: CHANNEL }));
    expect(decision.deliver).toBe(false);
    expect(decision.explanation).toContain("open");
  });

  it("\"why did I get that? I muted the channel\" — because you were named", () => {
    const decision = decide(
      reply({ mentions: [ME] }),
      ctx({ relationship: { mutedChannelIds: set(CHANNEL) } }),
    );
    expect(decision.deliver).toBe(true);
    expect(decision.explanation).toBe("You were mentioned.");
  });

  it("\"the thread I started went quiet\" — because you muted the thread", () => {
    const decision = decide(
      reply(),
      ctx({ relationship: { mutedRootIds: set(ROOT), authoredRootIds: set(ROOT) } }),
    );
    expect(decision.reason).toBe(SUPPRESSED_REASON.THREAD_MUTED);
    expect(decision.explanation).toBe("That thread is muted.");
  });

  it("\"nothing at all arrives\" — because alerts are off", () => {
    const decision = decide(
      evt(),
      ctx({ settings: { ...DEFAULT_NOTIFICATION_SETTINGS, desktopEnabled: false } }),
    );
    expect(decision.explanation).toContain("turned off");
  });

  it("an ordinary new message in a room you are in arrives", () => {
    const decision = decide(evt(), ctx({ permission: "granted", activeChannelId: null }));
    expect(decision).toMatchObject({
      deliver: true,
      reason: NOTIFY_REASON.TOP_LEVEL,
      slot: "needs_action",
      item: null,
    });
  });
});
