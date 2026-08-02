// The reader's side of read state: dividers, thread markers, badge rollups.
//
// Everything here is pure, so every rule is asserted directly rather than
// inferred from a rendered screen. Two properties get special attention because
// they are the ones a single-order test passes by accident:
//
//   - **stability.** The divider must not move while somebody is reading. So the
//     tests re-run the same computation against a frontier captured at open time
//     and assert the answer does not change when the live marker advances.
//   - **order-independence.** The same window of messages arrives in different
//     orders depending on whether history or the live subscription got there
//     first, so the marker is computed over reversed input too.

import { describe, expect, it } from "vitest";

import {
  BadgeRollup,
  CONVERSATIONAL_UNREAD_KINDS,
  NO_PARENT,
  activeChannelParentResolver,
  channelContextKey,
  classifyContextKey,
  computeChannelUnreadMarker,
  computeThreadBadgeCounts,
  computeThreadUnreadMarker,
  eventReadAt,
  forcedUnreadStillLit,
  isConversationalUnreadKind,
  isEventUnread,
  makeReadStateReader,
  maxReadAt,
  messageContextKey,
  resolveEffectiveTimestamp,
  rollupChannelBadges,
  shouldRenderUnreadDivider,
  snapshotReadAt,
  threadContextKey,
  timelineUnreadOptions,
  unreadCountLabel,
  type UnreadCandidate,
} from "../src/lib/buzz/unread";
import * as protocol from "../convex/buzz/readState";
import { buildTimelineRows } from "../src/lib/buzz/timeline";
import type { ChatChannelSummary } from "../src/lib/buzz/channel-types";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function message(
  id: string,
  createdAt: number,
  pubkey: string,
  extra: Partial<UnreadCandidate> = {},
): UnreadCandidate {
  return { id, createdAt, pubkey, ...extra };
}

// ---------------------------------------------------------------------------
// The restatement
// ---------------------------------------------------------------------------

describe("the restated core does not drift from the protocol", () => {
  // `src/lib/buzz/unread.ts` cannot import `convex/buzz/readState.ts` — that
  // module pulls in Convex's server runtime, which a browser drawing a divider
  // has no use for. So a handful of definitions are restated, and this is the
  // test that makes the duplication safe rather than merely small. If somebody
  // changes one side, this fails on the same commit.
  it("agrees on the context-key grammar", () => {
    const root = "1".repeat(64);
    expect(channelContextKey(root)).toBe(protocol.channelContextKey(root));
    expect(threadContextKey(root)).toBe(protocol.threadContextKey(root));
    expect(messageContextKey(root)).toBe(protocol.messageContextKey(root));
    for (const key of [root, threadContextKey(root), messageContextKey(root)]) {
      expect(classifyContextKey(key)).toBe(protocol.classifyContextKey(key));
    }
  });

  it("agrees on which kinds may make something unread", () => {
    expect([...CONVERSATIONAL_UNREAD_KINDS].sort()).toEqual(
      [...protocol.CONVERSATIONAL_UNREAD_KINDS].sort(),
    );
    for (const kind of [undefined, 5, 7, 9, 40002, 40003, 40008, 40099, 48100]) {
      expect(isConversationalUnreadKind(kind)).toBe(protocol.isConversationalUnreadKind(kind));
    }
  });

  it("agrees on maxReadAt, the frontier and the strict comparison", () => {
    expect(maxReadAt(null, 3, undefined, 9)).toBe(protocol.maxReadAt(null, 3, undefined, 9));
    expect(maxReadAt(null, undefined)).toBe(protocol.maxReadAt(null, undefined));
    const contexts = { c: 10, "thread:x": 5 };
    expect(resolveEffectiveTimestamp(contexts, "thread:x", () => "c")).toBe(
      protocol.resolveEffectiveTimestamp(contexts, "thread:x", () => "c"),
    );
    expect(isEventUnread(10, 10)).toBe(protocol.isEventUnread(10, 10));
    expect(isEventUnread(11, 10)).toBe(protocol.isEventUnread(11, 10));
    expect(forcedUnreadStillLit(5, 5)).toBe(protocol.forcedUnreadStillLit(5, 5));
    expect(forcedUnreadStillLit(5, 6)).toBe(protocol.forcedUnreadStillLit(5, 6));
    expect(forcedUnreadStillLit(null, 6)).toBe(protocol.forcedUnreadStillLit(null, 6));
  });
});

// ---------------------------------------------------------------------------
// §4.2
// ---------------------------------------------------------------------------

describe("§4.2 the hierarchical frontier", () => {
  it("folds a parent's marker into a child, and never the reverse", () => {
    const channel = "c".repeat(64);
    const root = "r".repeat(64);
    const parentOf = activeChannelParentResolver(channel);

    // The channel is read further ahead than the thread, so the thread inherits.
    const contexts = { [channel]: 100, [threadContextKey(root)]: 40 };
    expect(resolveEffectiveTimestamp(contexts, threadContextKey(root), parentOf)).toBe(100);
    // But reading the thread does not advance the channel: the fold is upward
    // only, which is what makes "mark the channel read" cover its threads while
    // "read one thread" leaves the room unread.
    expect(resolveEffectiveTimestamp(contexts, channel, parentOf)).toBe(100);
    expect(resolveEffectiveTimestamp({ [threadContextKey(root)]: 400 }, channel, parentOf)).toBe(
      null,
    );
  });

  it("degrades to the context's own value when there is no parent", () => {
    const contexts = { "thread:x": 7 };
    expect(resolveEffectiveTimestamp(contexts, "thread:x", NO_PARENT)).toBe(7);
    expect(resolveEffectiveTimestamp({}, "thread:x", NO_PARENT)).toBe(null);
  });

  it("returns a frontier rather than hanging on a resolver that runs in a circle", () => {
    const parentOf = (key: string): string => (key === "a" ? "b" : "a");
    expect(resolveEffectiveTimestamp({ a: 1, b: 9 }, "a", parentOf)).toBe(9);
  });

  it("keeps own and effective distinct — the §4.2 trap", () => {
    const active = "active".padEnd(64, "0");
    const background = "background".padEnd(64, "0");
    const root = "root".padEnd(64, "0");

    // The reader has read the ACTIVE channel to second 500 and has never read
    // the thread that lives in the BACKGROUND channel.
    const reader = makeReadStateReader(
      { [active]: 500 },
      activeChannelParentResolver(active),
    );

    // Through the effective accessor the background thread borrows the active
    // channel's marker — which is exactly the bug §10.7 names.
    expect(reader.getEffectiveTimestamp(threadContextKey(root))).toBe(500);
    // The own accessor is the one a background scan must use.
    expect(reader.getOwnTimestamp(threadContextKey(root))).toBe(null);

    // And `eventReadAt` composes them the documented way: channel effective,
    // thread/message own. Reading the active channel must not mark a reply in
    // another room read.
    expect(eventReadAt(reader, background, "e".repeat(64), root)).toBe(null);
    expect(eventReadAt(reader, active, "e".repeat(64), null)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// §4.4
// ---------------------------------------------------------------------------

describe("§4.4 forced unread is gated on its baseline", () => {
  it("stays lit until a genuine read passes the baseline", () => {
    // Marked unread while the marker stood at 100.
    expect(forcedUnreadStillLit(100, 100)).toBe(true);
    expect(forcedUnreadStillLit(100, 99)).toBe(true);
    // A read on another device advanced it. The read wins; the dot goes out.
    expect(forcedUnreadStillLit(100, 101)).toBe(false);
  });

  it("handles the never-read case in both directions", () => {
    // Nothing had ever been read when it was forced, and nothing has since.
    expect(forcedUnreadStillLit(null, null)).toBe(true);
    // Nothing had been read when it was forced, and something has since.
    expect(forcedUnreadStillLit(null, 5)).toBe(false);
    // It had been read, and the marker has somehow gone missing: still lit,
    // because there is no evidence of a read past the baseline.
    expect(forcedUnreadStillLit(5, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4.6
// ---------------------------------------------------------------------------

describe("§4.6 the channel divider and pill", () => {
  const timeline: UnreadCandidate[] = [
    message("m1", 100, BOB),
    message("m2", 200, BOB),
    message("m3", 300, BOB),
  ];

  it("is empty on an empty timeline", () => {
    expect(computeChannelUnreadMarker([], 100, false, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
  });

  it("treats every top-level message as unread when there is no frontier", () => {
    expect(computeChannelUnreadMarker(timeline, null, false, ALICE)).toEqual({
      firstUnreadMessageId: "m1",
      unreadCount: 3,
    });
  });

  it("compares strictly greater — a message exactly at the frontier is read", () => {
    expect(computeChannelUnreadMarker(timeline, 200, false, ALICE)).toEqual({
      firstUnreadMessageId: "m3",
      unreadCount: 1,
    });
    expect(computeChannelUnreadMarker(timeline, 300, false, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
  });

  it("skips thread replies even when they are newer", () => {
    const withReply = [...timeline, message("r1", 999, BOB, { parentId: "m1" })];
    expect(computeChannelUnreadMarker(withReply, 300, false, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
  });

  it("skips your own messages, case-insensitively", () => {
    const mine = [message("m1", 100, ALICE.toUpperCase()), message("m2", 200, BOB)];
    expect(computeChannelUnreadMarker(mine, null, false, ALICE)).toEqual({
      firstUnreadMessageId: "m2",
      unreadCount: 1,
    });
  });

  it("never lets a system row or a reaction inflate the pill", () => {
    const noisy = [
      message("s1", 400, BOB, { kind: 40099 }),
      message("x1", 401, BOB, { kind: 7 }),
      message("e1", 402, BOB, { kind: 40003 }),
    ];
    // A freshly created channel is `channel_created` plus N `member_joined`
    // rows; counting them reads "4 unread, 1 message" (§10.3).
    expect(computeChannelUnreadMarker(noisy, null, false, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
    // An optimistic row has no kind yet, and must still count (§10.2).
    expect(
      computeChannelUnreadMarker([message("pending", 500, BOB)], null, false, ALICE).unreadCount,
    ).toBe(1);
  });

  it("suppresses everything when the reader deliberately marked it unread", () => {
    // Including the never-read case: the sidebar says unread, and the timeline
    // showing no boundary at all is the honest reading of "I have seen these
    // and want to come back" (§10.16).
    expect(computeChannelUnreadMarker(timeline, null, true, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
    expect(computeChannelUnreadMarker(timeline, 100, true, ALICE)).toEqual({
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
  });

  it("does not move while the reader reads", () => {
    // The frontier is captured at open time and does not change as the live
    // marker advances behind it — which is the whole reason it is captured.
    const openFrontier = 100;
    const before = computeChannelUnreadMarker(timeline, openFrontier, false, ALICE);
    // ... the open marks the channel read to 300 ...
    const liveFrontier = 300;
    const afterWithLive = computeChannelUnreadMarker(timeline, liveFrontier, false, ALICE);
    const afterWithOpen = computeChannelUnreadMarker(timeline, openFrontier, false, ALICE);

    expect(before).toEqual({ firstUnreadMessageId: "m2", unreadCount: 2 });
    // Reading the live marker collapses the divider instantly (§10.8) …
    expect(afterWithLive.firstUnreadMessageId).toBe(null);
    // … and the captured one holds it exactly where it was.
    expect(afterWithOpen).toEqual(before);
  });

  it("is order-independent", () => {
    const reversed = [...timeline].reverse();
    expect(computeChannelUnreadMarker(reversed, 100, false, ALICE).unreadCount).toBe(2);
    // The oldest unread wins whichever order it arrived in.
    expect(computeChannelUnreadMarker(reversed, 100, false, ALICE).firstUnreadMessageId).toBe("m2");
  });

  it("suppresses the divider at index 0 and draws it anywhere else", () => {
    expect(shouldRenderUnreadDivider(0, "m1", "m1")).toBe(false);
    expect(shouldRenderUnreadDivider(1, "m2", "m2")).toBe(true);
    expect(shouldRenderUnreadDivider(1, "m2", "m3")).toBe(false);
    expect(shouldRenderUnreadDivider(1, "m2", null)).toBe(false);
  });

  it("labels the pill in the singular at one", () => {
    expect(unreadCountLabel(1)).toBe("1 new message");
    expect(unreadCountLabel(4)).toBe("4 new messages");
  });
});

describe("§4.6 feeding the projector", () => {
  // `buildTimelineRows` draws the divider wherever `firstUnreadId` matches, with
  // no index check of its own — so the index-0 rule has to live in what we hand
  // it, and these tests are what prove it does.
  const rows = [
    { id: "m1", createdAt: 100, pubkey: BOB },
    { id: "m2", createdAt: 200, pubkey: BOB },
    { id: "m3", createdAt: 300, pubkey: BOB },
  ];

  function chatMessages(): Parameters<typeof buildTimelineRows>[0] {
    return rows.map((row) => ({
      id: row.id,
      renderKey: row.id,
      createdAt: row.createdAt,
      pubkey: row.pubkey,
      signerPubkey: row.pubkey,
      author: "Bob",
      isAgent: false,
      body: row.id,
      tags: [],
      kind: 9,
      depth: 0,
      edited: false,
      pending: false,
      mine: false,
      reactions: [],
    }));
  }

  it("passes the divider through with the authoritative count", () => {
    const marker = computeChannelUnreadMarker(rows, 100, false, ALICE);
    const options = timelineUnreadOptions(rows, marker, { historyExhausted: true });
    expect(options).toEqual({ historyExhausted: true, firstUnreadId: "m2", unreadCount: 2 });

    const drawn = buildTimelineRows(chatMessages(), options, { selfPubkey: ALICE });
    const unreadIndex = drawn.findIndex((row) => row.type === "unread");
    const m2Index = drawn.findIndex(
      (row) => row.type === "message" && row.message.id === "m2",
    );
    expect(unreadIndex).toBeGreaterThan(-1);
    // Above the right message, and only there.
    expect(unreadIndex).toBe(m2Index - 1);
    expect(drawn.filter((row) => row.type === "unread")).toHaveLength(1);
  });

  it("withholds the divider when the first unread is the oldest row drawn", () => {
    const marker = computeChannelUnreadMarker(rows, null, false, ALICE);
    expect(marker.firstUnreadMessageId).toBe("m1");
    const options = timelineUnreadOptions(rows, marker);
    expect(options.firstUnreadId).toBeUndefined();
    expect(buildTimelineRows(chatMessages(), options).some((row) => row.type === "unread")).toBe(
      false,
    );
  });

  it("withholds it when the first unread is not in the window being drawn", () => {
    const marker = computeChannelUnreadMarker(rows, 100, false, ALICE);
    expect(timelineUnreadOptions([{ id: "m9" }], marker).firstUnreadId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §4.7
// ---------------------------------------------------------------------------

describe("§4.7 thread unreads", () => {
  const replies: UnreadCandidate[] = [
    message("r1", 10, BOB),
    message("r2", 20, BOB),
    message("r3", 30, BOB),
  ];

  it("expresses a state a single thread frontier cannot", () => {
    // The middle reply is read and the ones on either side are not. A frontier
    // at 20 would have covered r1 too.
    const getReadAt = (id: string): number | null => (id === "r2" ? 20 : null);
    expect(computeThreadUnreadMarker(replies, getReadAt, ALICE)).toEqual({
      firstUnreadReplyId: "r1",
      unreadCount: 2,
    });
  });

  it("compares strictly greater and skips your own replies", () => {
    const readAll = (): number | null => 30;
    expect(computeThreadUnreadMarker(replies, readAll, ALICE).unreadCount).toBe(0);
    const mine = [message("r1", 10, ALICE), message("r2", 20, BOB)];
    expect(computeThreadUnreadMarker(mine, () => null, ALICE.toUpperCase())).toEqual({
      firstUnreadReplyId: "r2",
      unreadCount: 1,
    });
  });

  it("ORs in the session-only per-message forced unread", () => {
    const readAll = (): number | null => 30;
    expect(
      computeThreadUnreadMarker(replies, readAll, ALICE, (id: string) => id === "r3"),
    ).toEqual({ firstUnreadReplyId: "r3", unreadCount: 1 });
  });

  it("reads the divider snapshot with .has, not ??", () => {
    // A never-read reply snapshots to `null`. The live marker has since
    // advanced past it (the on-open mark-read ran). `??` would fall through to
    // the live value and collapse the divider (§10.10).
    const snapshot = new Map<string, number | null>([["r1", null], ["r2", 20]]);
    const live = (): number | null => 999;
    expect(snapshotReadAt(snapshot, live, "r1")).toBe(null);
    expect(snapshotReadAt(snapshot, live, "r2")).toBe(20);
    // A reply that was not visible on open has no snapshot, so the live marker
    // is the honest answer for it.
    expect(snapshotReadAt(snapshot, live, "r9")).toBe(999);

    const readFromSnapshot = (id: string): number | null => snapshotReadAt(snapshot, live, id);
    expect(computeThreadUnreadMarker(replies, readFromSnapshot, ALICE)).toEqual({
      firstUnreadReplyId: "r1",
      unreadCount: 1,
    });
  });

  it("keys root badges on rootId, not on the parent chain", () => {
    const root = "R";
    const withMissingAncestor = [
      // `mid` is outside the loaded window; `leaf` still carries the true root.
      message("leaf", 50, BOB, { parentId: "mid" }),
    ].map((reply) => ({ ...reply, rootId: root }));

    const counts = computeThreadBadgeCounts(
      withMissingAncestor,
      () => null,
      ALICE,
      () => true,
    );
    expect(counts.get(root)).toBe(1);
  });

  it("gives no badge to a root the reader has no interest in, and no zeros", () => {
    const replies2 = [{ ...message("r1", 10, BOB), rootId: "R1" }, { ...message("r2", 10, BOB), rootId: "R2" }];
    const counts = computeThreadBadgeCounts(
      replies2,
      () => null,
      ALICE,
      (rootId: string) => rootId === "R1",
    );
    expect([...counts.entries()]).toEqual([["R1", 1]]);
    // Everything read: the map is empty rather than full of "0".
    expect(computeThreadBadgeCounts(replies2, () => 99, ALICE, () => true).size).toBe(0);
  });

  it("keys off nothing rather than looping on a malformed parent cycle", () => {
    const cyclic = [
      { ...message("a", 1, BOB, { parentId: "b" }) },
      { ...message("b", 2, BOB, { parentId: "a" }) },
    ];
    // No rootId on either, so neither rolls up anywhere — and, critically, the
    // count is computed without walking the chain at all.
    expect(computeThreadBadgeCounts(cyclic, () => null, ALICE, () => true).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4.8
// ---------------------------------------------------------------------------

describe("§4.8 badge rollups", () => {
  function summary(over: Partial<ChatChannelSummary>): ChatChannelSummary {
    return {
      channelId: "c",
      name: "c",
      displayName: "c",
      kind: "channel",
      visibility: "public",
      memberCount: 2,
      unread: 0,
      mentions: 0,
      muted: false,
      joined: true,
      ...over,
    };
  }

  it("is exactly the sum of its parts", () => {
    const channels = [
      summary({ channelId: "a", unread: 3, mentions: 1 }),
      summary({ channelId: "b", unread: 5, mentions: 0 }),
      summary({ channelId: "c", unread: 0, mentions: 0 }),
      summary({ channelId: "d", kind: "dm", unread: 2, mentions: 2 }),
    ];
    const rolled: BadgeRollup = rollupChannelBadges(channels);
    expect(rolled.unread).toBe(channels.reduce((sum, c) => sum + c.unread, 0));
    expect(rolled.mentions).toBe(channels.reduce((sum, c) => sum + c.mentions, 0));
    expect(rolled.unreadChannels).toBe(channels.filter((c) => c.unread > 0).length);
    expect(rolled).toEqual({ unreadChannels: 3, unread: 10, mentions: 3, appBadge: 3 });
  });

  it("keeps a muted room's unread and drops it from the OS badge", () => {
    const channels = [
      summary({ channelId: "a", unread: 4, mentions: 2, muted: true }),
      summary({ channelId: "b", unread: 1, mentions: 1 }),
    ];
    const rolled = rollupChannelBadges(channels);
    expect(rolled.unread).toBe(5);
    expect(rolled.mentions).toBe(3);
    // Muting is about not being interrupted, not about pretending nothing
    // happened — so it changes the OS badge and nothing else.
    expect(rolled.appBadge).toBe(1);
  });

  it("is empty for an empty rail", () => {
    expect(rollupChannelBadges([])).toEqual({
      unreadChannels: 0,
      unread: 0,
      mentions: 0,
      appBadge: 0,
    });
  });
});
