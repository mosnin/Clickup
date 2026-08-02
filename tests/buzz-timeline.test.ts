// The projector's executable spec.
//
// Two disciplines run through this file, and they are the reason it is as long
// as it is.
//
// **Every ordering rule is asserted in both input orders.** The same events
// reach a client from history and from the live subscription in whatever order
// the network produced, so an order-dependent fold is not a theoretical bug —
// it is the one a reader sees as a message that moved. An implementation that
// sorts late, or that keeps "the last reaction I happened to see", passes a
// single-order test perfectly and fails `expectOrderInvariant`.
//
// **The kind constants are pinned to the registry.** `timeline.ts` restates
// them rather than importing `convex/buzz/_kinds.ts` (which would drag a signing
// library into the browser bundle), so the first test below is the thing that
// makes the duplication safe.

import { describe, expect, it } from "vitest";
import { KINDS } from "../convex/buzz/_kinds";
import type { ChatMessage, ChatRow } from "@/lib/buzz/message-types";
import {
  applyEditTagOverlay,
  buildTimelineRows,
  countTopLevelTimelineRows,
  dedupeEventsById,
  describeSystemEvent,
  formatTimelineMessages,
  getDeletionTargets,
  getTargetEventId,
  getThreadReference,
  isBroadcastReply,
  describeSystemGroup,
  isTimelineContentEvent,
  isWithinGroupingWindow,
  hasSameMessageAuthor,
  projectTimeline,
  resolveAttributedPubkey,
  resolveDepths,
  sortEvents,
  startOfLocalDaySeconds,
  topLevelMessages,
  truncatePubkey,
  KIND_DELETION,
  KIND_HUDDLE_STARTED,
  KIND_NIP29_DELETE_EVENT,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  MEMBERSHIP_GROUP_WINDOW_SECONDS,
  MESSAGE_GROUPING_WINDOW_SECONDS,
  type TimelineEvent,
  type TimelineOptions,
  type TimelineRowOptions,
} from "@/lib/buzz/timeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A 64-char hex id from a short readable seed.
 *
 * Character codes rather than the seed's own letters, so a seed like `r1` still
 * produces a *valid* id. That matters more than it reads: an invalid fixture id
 * silently exempts an event from every rule that only accepts 64-char hex, and
 * the test then passes for the wrong reason.
 */
const hex = (seed: string): string =>
  [...seed]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

const ALICE = hex("aa");
const BOB = hex("bb");
const CAROL = hex("cc");
const RELAY = hex("ee");
const CHANNEL = "channel-1";

/**
 * A local-clock timestamp in seconds.
 *
 * Built from a local `Date` on purpose: day dividers are local-calendar, so a
 * fixture pinned to a UTC instant would pass in London and fail in Auckland.
 */
const at = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): number => Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);

const T0 = at(2026, 4, 2, 12, 0, 0);

type MessageOpts = {
  pubkey?: string;
  at?: number;
  body?: string;
  kind?: number;
  tags?: string[][];
  localKey?: string;
  pending?: boolean;
  failed?: boolean;
};

function message(seed: string, opts: MessageOpts = {}): TimelineEvent {
  return {
    id: hex(seed),
    pubkey: opts.pubkey ?? ALICE,
    created_at: opts.at ?? T0,
    kind: opts.kind ?? KIND_STREAM_MESSAGE_V2,
    tags: opts.tags ?? [["h", CHANNEL]],
    content: opts.body ?? `body ${seed}`,
    ...(opts.localKey ? { localKey: opts.localKey } : {}),
    ...(opts.pending ? { pending: true } : {}),
    ...(opts.failed ? { failed: true } : {}),
  };
}

function edit(
  seed: string,
  targetSeed: string,
  body: string,
  opts: { at?: number; pubkey?: string; tags?: string[][] } = {},
): TimelineEvent {
  return {
    id: hex(seed),
    pubkey: opts.pubkey ?? ALICE,
    created_at: opts.at ?? T0 + 10,
    kind: KIND_STREAM_MESSAGE_EDIT,
    tags: opts.tags ?? [
      ["h", CHANNEL],
      ["e", hex(targetSeed)],
    ],
    content: body,
  };
}

function deletion(
  seed: string,
  targetSeeds: string[],
  opts: { kind?: number; pubkey?: string; at?: number; rawTargets?: string[] } = {},
): TimelineEvent {
  const targets = opts.rawTargets ?? targetSeeds.map(hex);
  return {
    id: hex(seed),
    pubkey: opts.pubkey ?? ALICE,
    created_at: opts.at ?? T0 + 20,
    kind: opts.kind ?? KIND_DELETION,
    tags: [["h", CHANNEL], ...targets.map((t) => ["e", t])],
    content: "",
  };
}

function reaction(
  seed: string,
  targetSeed: string,
  emoji: string,
  opts: { pubkey?: string; at?: number; tags?: string[][] } = {},
): TimelineEvent {
  return {
    id: hex(seed),
    pubkey: opts.pubkey ?? BOB,
    created_at: opts.at ?? T0 + 5,
    kind: KIND_REACTION,
    tags: opts.tags ?? [
      ["h", CHANNEL],
      ["e", hex(targetSeed)],
    ],
    content: emoji,
  };
}

/** `["e", root, "", "root"]` + `["e", parent, "", "reply"]`, per §2.2. */
function replyTags(parentSeed: string, rootSeed?: string): string[][] {
  const parent = hex(parentSeed);
  const root = rootSeed ? hex(rootSeed) : parent;
  return root === parent
    ? [["h", CHANNEL], ["e", root, "", "reply"]]
    : [
        ["h", CHANNEL],
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ];
}

// ---------------------------------------------------------------------------
// The both-orders discipline
// ---------------------------------------------------------------------------

/**
 * Run `project` over the events and over their reverse, assert the two results
 * are identical, and hand back the result.
 *
 * The reverse is the cheapest adversarial order there is: it flips "first seen"
 * and "last seen" for every pass at once, so a fold that quietly depends on
 * either one cannot survive it.
 */
function expectOrderInvariant<T>(
  events: readonly TimelineEvent[],
  project: (input: readonly TimelineEvent[]) => T,
): T {
  const forward = project(events);
  const backward = project([...events].reverse());
  expect(backward).toEqual(forward);
  return forward;
}

const bodies = (messages: readonly ChatMessage[]): string[] => messages.map((m) => m.body);
const ids = (messages: readonly ChatMessage[]): string[] => messages.map((m) => m.id);
const rowTypes = (rows: readonly ChatRow[]): string[] => rows.map((r) => r.type);

function project(
  events: readonly TimelineEvent[],
  options: TimelineOptions = {},
): ChatMessage[] {
  return formatTimelineMessages(events, options);
}

function rows(
  events: readonly TimelineEvent[],
  rowOptions: TimelineRowOptions = {},
  options: TimelineOptions = {},
): ChatRow[] {
  return projectTimeline(events, options, rowOptions);
}

// ---------------------------------------------------------------------------

describe("kind constants", () => {
  // The one test that makes restating the kinds locally safe rather than a
  // second source of truth waiting to drift.
  it("match convex/buzz/_kinds.ts by name", () => {
    const expected: Array<[number, string]> = [
      [KIND_DELETION, "KIND_DELETION"],
      [KIND_REACTION, "KIND_REACTION"],
      [KIND_STREAM_MESSAGE, "KIND_STREAM_MESSAGE"],
      [KIND_NIP29_DELETE_EVENT, "KIND_NIP29_DELETE_EVENT"],
      [KIND_STREAM_MESSAGE_V2, "KIND_STREAM_MESSAGE_V2"],
      [KIND_STREAM_MESSAGE_EDIT, "KIND_STREAM_MESSAGE_EDIT"],
      [KIND_STREAM_MESSAGE_DIFF, "KIND_STREAM_MESSAGE_DIFF"],
      [KIND_SYSTEM_MESSAGE, "KIND_SYSTEM_MESSAGE"],
      [KIND_HUDDLE_STARTED, "KIND_HUDDLE_STARTED"],
    ];
    for (const [kind, name] of expected) {
      expect(KINDS.get(kind)?.name, `kind ${kind}`).toBe(name);
    }
  });

  it("keeps the edit kind out of the visible set", () => {
    expect(isTimelineContentEvent(KIND_STREAM_MESSAGE_EDIT)).toBe(false);
    expect(isTimelineContentEvent(KIND_REACTION)).toBe(false);
    expect(isTimelineContentEvent(KIND_DELETION)).toBe(false);
    expect(isTimelineContentEvent(KIND_STREAM_MESSAGE)).toBe(true);
    expect(isTimelineContentEvent(KIND_STREAM_MESSAGE_V2)).toBe(true);
    expect(isTimelineContentEvent(KIND_STREAM_MESSAGE_DIFF)).toBe(true);
    expect(isTimelineContentEvent(KIND_SYSTEM_MESSAGE)).toBe(true);
    expect(isTimelineContentEvent(KIND_HUDDLE_STARTED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("pass 1 — deletions", () => {
  it("collects targets from both deletion kinds", () => {
    const targets = getDeletionTargets([
      deletion("d1", ["a1"]),
      deletion("d2", ["b2"], { kind: KIND_NIP29_DELETE_EVENT }),
    ]);
    expect([...targets].sort()).toEqual([hex("a1"), hex("b2")].sort());
  });

  it("accepts only 64-char hex targets", () => {
    const targets = getDeletionTargets([
      deletion("d1", [], { rawTargets: ["a1", "not-hex", "", hex("a1").slice(0, 63), hex("c3")] }),
    ]);
    expect([...targets]).toEqual([hex("c3")]);
  });

  it("normalises an uppercase target to lowercase", () => {
    const targets = getDeletionTargets([
      deletion("d1", [], { rawTargets: [hex("a1").toUpperCase()] }),
    ]);
    expect([...targets]).toEqual([hex("a1")]);
  });

  it("ignores tags that are not e tags", () => {
    const deleted: TimelineEvent = {
      id: hex("d1"),
      pubkey: ALICE,
      created_at: T0,
      kind: KIND_DELETION,
      tags: [
        ["p", hex("a1")],
        ["h", CHANNEL],
      ],
      content: "",
    };
    expect(getDeletionTargets([deleted]).size).toBe(0);
  });

  it("makes a deleted message vanish, in both input orders", () => {
    const events = [message("a1"), message("b2"), deletion("d1", ["a1"])];
    const result = expectOrderInvariant(events, (input) => bodies(project(input)));
    expect(result).toEqual(["body b2"]);
  });

  it("takes the deleted message's reactions with it", () => {
    const events = [
      message("a1"),
      message("b2"),
      reaction("r1", "a1", "🎉"),
      reaction("r2", "b2", "🎉"),
      deletion("d1", ["a1"]),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(hex("b2"));
    expect(result[0].reactions.map((r) => r.emoji)).toEqual(["🎉"]);
  });

  it("deletes via the NIP-29 marker too", () => {
    const events = [message("a1"), deletion("d1", ["a1"], { kind: KIND_NIP29_DELETE_EVENT })];
    expect(expectOrderInvariant(events, (input) => project(input))).toHaveLength(0);
  });

  it("deletes nothing when the target is not a valid event id", () => {
    const events = [message("a1"), deletion("d1", [], { rawTargets: ["a1"] })];
    expect(expectOrderInvariant(events, (input) => bodies(project(input)))).toEqual(["body a1"]);
  });
});

// ---------------------------------------------------------------------------

describe("target resolution", () => {
  it("takes the LAST valid e tag", () => {
    expect(
      getTargetEventId([
        ["e", hex("a1"), "", "root"],
        ["e", hex("b2"), "", "reply"],
      ]),
    ).toBe(hex("b2"));
  });

  it("skips trailing invalid e tags to reach the last valid one", () => {
    expect(getTargetEventId([["e", hex("a1")], ["e", "nope"], ["e", ""]])).toBe(hex("a1"));
  });

  it("is undefined when nothing valid is referenced", () => {
    expect(getTargetEventId([["h", CHANNEL]])).toBeUndefined();
    expect(getTargetEventId([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("pass 2 — edits", () => {
  it("changes the body but not the id", () => {
    const events = [message("a1", { body: "typo" }), edit("e1", "a1", "fixed")];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(hex("a1"));
    expect(result[0].renderKey).toBe(hex("a1"));
    expect(result[0].body).toBe("fixed");
    expect(result[0].edited).toBe(true);
  });

  it("does not mark an unedited message edited", () => {
    expect(project([message("a1")])[0].edited).toBe(false);
  });

  it("lets the most recent edit win, in both input orders", () => {
    const events = [
      message("a1", { body: "v0" }),
      edit("e1", "a1", "v1", { at: T0 + 10 }),
      edit("e2", "a1", "v2", { at: T0 + 20 }),
      edit("e3", "a1", "v3", { at: T0 + 15 }),
    ];
    expect(expectOrderInvariant(events, (input) => bodies(project(input)))).toEqual(["v2"]);
  });

  it("breaks a created_at tie on the lower edit id, in both input orders", () => {
    const events = [
      message("a1", { body: "v0" }),
      edit("e1", "a1", "from-e1", { at: T0 + 10 }),
      edit("f2", "a1", "from-f2", { at: T0 + 10 }),
    ];
    // hex("e1") < hex("f2") lexicographically, so e1 wins whichever arrives first.
    expect(expectOrderInvariant(events, (input) => bodies(project(input)))).toEqual(["from-e1"]);
  });

  it("ignores a deleted edit and falls back to the previous winner", () => {
    const events = [
      message("a1", { body: "v0" }),
      edit("e1", "a1", "v1", { at: T0 + 10 }),
      edit("e2", "a1", "v2", { at: T0 + 20 }),
      deletion("d1", ["e2"]),
    ];
    expect(expectOrderInvariant(events, (input) => bodies(project(input)))).toEqual(["v1"]);
  });

  it("ignores an edit of a deleted message", () => {
    const events = [
      message("a1", { body: "v0" }),
      message("b2", { body: "other" }),
      edit("e1", "a1", "resurrected", { at: T0 + 10 }),
      deletion("d1", ["a1"]),
    ];
    const result = expectOrderInvariant(events, (input) => bodies(project(input)));
    expect(result).toEqual(["other"]);
    expect(result).not.toContain("resurrected");
  });

  it("resolves the edit target from the last valid e tag", () => {
    const events = [
      message("a1", { body: "root" }),
      message("b2", { body: "reply", tags: replyTags("a1") }),
      edit("e1", "x", "edited reply", {
        tags: [
          ["h", CHANNEL],
          ["e", hex("a1"), "", "root"],
          ["e", hex("b2")],
        ],
      }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result.find((m) => m.id === hex("a1"))?.body).toBe("root");
    expect(result.find((m) => m.id === hex("b2"))?.body).toBe("edited reply");
  });

  it("never emits the edit event as its own row", () => {
    const result = project([message("a1"), edit("e1", "a1", "fixed")]);
    expect(ids(result)).toEqual([hex("a1")]);
  });
});

// ---------------------------------------------------------------------------

describe("the edit tag overlay", () => {
  const original = [
    ["h", CHANNEL],
    ["imeta", "url old.png"],
    ["p", BOB],
    ["e", hex("a1"), "", "reply"],
  ];

  it("copies the original tags when there is no edit", () => {
    const out = applyEditTagOverlay(original);
    expect(out).toEqual(original);
    // A copy, not the same arrays — the caller must not be able to mutate the
    // event it was handed.
    expect(out).not.toBe(original);
    expect(out[0]).not.toBe(original[0]);
  });

  it("swaps the media tags and preserves everything else", () => {
    const out = applyEditTagOverlay(original, [
      ["h", CHANNEL],
      ["imeta", "url new.png"],
    ]);
    expect(out).toEqual([
      ["h", CHANNEL],
      ["p", BOB],
      ["e", hex("a1"), "", "reply"],
      ["imeta", "url new.png"],
    ]);
  });

  it("drops the original media when the edit carries none", () => {
    const out = applyEditTagOverlay(original, [["h", CHANNEL]]);
    expect(out.some((tag) => tag[0] === "imeta")).toBe(false);
    expect(out).toEqual([
      ["h", CHANNEL],
      ["p", BOB],
      ["e", hex("a1"), "", "reply"],
    ]);
  });

  it("never lets an edit rewrite the room or the thread", () => {
    const out = applyEditTagOverlay(original, [
      ["h", "somewhere-else"],
      ["e", hex("ff"), "", "reply"],
      ["p", CAROL],
    ]);
    expect(out.filter((tag) => tag[0] === "h")).toEqual([["h", CHANNEL]]);
    expect(out.filter((tag) => tag[0] === "e")).toEqual([["e", hex("a1"), "", "reply"]]);
    expect(out.filter((tag) => tag[0] === "p")).toEqual([["p", BOB]]);
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.stringify(original);
    applyEditTagOverlay(original, [["imeta", "url new.png"]]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("applies through the projection", () => {
    const events = [
      message("a1", {
        tags: [
          ["h", CHANNEL],
          ["imeta", "url old.png"],
          ["p", BOB],
        ],
      }),
      edit("e1", "a1", "fixed", {
        tags: [
          ["h", CHANNEL],
          ["e", hex("a1")],
          ["imeta", "url new.png"],
        ],
      }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].tags).toEqual([
      ["h", CHANNEL],
      ["p", BOB],
      ["imeta", "url new.png"],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("§2.2 threading", () => {
  it("returns nulls when there are no e tags", () => {
    expect(getThreadReference([["h", CHANNEL]])).toEqual({ parentId: null, rootId: null });
  });

  it("treats an unmarked e tag as a mention, not a parent", () => {
    expect(getThreadReference([["e", hex("a1")]])).toEqual({ parentId: null, rootId: null });
  });

  it("uses the reply target as the root when there is no root tag", () => {
    expect(getThreadReference([["e", hex("a1"), "", "reply"]])).toEqual({
      parentId: hex("a1"),
      rootId: hex("a1"),
    });
  });

  it("takes the FIRST root and the LAST reply", () => {
    expect(
      getThreadReference([
        ["e", hex("a1"), "", "root"],
        ["e", hex("b2"), "", "root"],
        ["e", hex("c3"), "", "reply"],
        ["e", hex("d4"), "", "reply"],
      ]),
    ).toEqual({ parentId: hex("d4"), rootId: hex("a1") });
  });

  it("refuses a parent that is not a valid event id", () => {
    expect(getThreadReference([["e", "nope", "", "reply"]])).toEqual({
      parentId: null,
      rootId: null,
    });
  });

  it("recognises a broadcast reply", () => {
    expect(isBroadcastReply([["broadcast", "1"]])).toBe(true);
    expect(isBroadcastReply([["broadcast", "0"]])).toBe(false);
    expect(isBroadcastReply([["broadcast"]])).toBe(false);
    expect(isBroadcastReply([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("passes 4–5 — reactions", () => {
  it("collapses duplicate deliveries of the same reaction", () => {
    const dup = reaction("r1", "a1", "🎉");
    const events = [message("a1"), dup, { ...dup }, { ...dup }];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions).toHaveLength(1);
    expect(result[0].reactions[0].count).toBe(1);
  });

  it("collapses two distinct events carrying the same target/actor/emoji", () => {
    // The same press re-signed, or re-delivered under a new id. Presence is
    // keyed by meaning, not by event id, so it is still one press.
    const events = [
      message("a1"),
      reaction("r1", "a1", "🎉", { at: T0 + 30 }),
      reaction("r2", "a1", "🎉", { at: T0 + 10 }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions[0].count).toBe(1);
    // The EARLIEST is retained, so pill chronology cannot drift later.
    expect(result[0].reactions[0].firstAt).toBe(T0 + 10);
  });

  it("counts distinct actors", () => {
    const events = [
      message("a1"),
      reaction("r1", "a1", "🎉", { pubkey: BOB }),
      reaction("r2", "a1", "🎉", { pubkey: CAROL }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions[0].count).toBe(2);
  });

  it("orders pills earliest-first and is invariant to input order", () => {
    const events = [
      message("a1"),
      reaction("r1", "a1", "🐢", { at: T0 + 30, pubkey: BOB }),
      reaction("r2", "a1", "🎉", { at: T0 + 10, pubkey: CAROL }),
      reaction("r3", "a1", "🔥", { at: T0 + 20, pubkey: ALICE }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions.map((r) => r.emoji)).toEqual(["🎉", "🔥", "🐢"]);
  });

  it("does not reshuffle pills when somebody reacts again later", () => {
    // Retaining the LATEST timestamp would move 🎉 behind 🔥 the moment the
    // second press arrived — the row visibly reordering under the reader's
    // cursor, which is the reason the earliest is the one kept.
    const events = [
      message("a1"),
      reaction("1a", "a1", "🎉", { at: T0 + 10, pubkey: BOB }),
      reaction("2b", "a1", "🔥", { at: T0 + 20, pubkey: CAROL }),
      reaction("3c", "a1", "🎉", { at: T0 + 30, pubkey: BOB }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions.map((r) => r.emoji)).toEqual(["🎉", "🔥"]);
    expect(result[0].reactions[0].firstAt).toBe(T0 + 10);
  });

  it("breaks a firstAt tie with localeCompare, in both input orders", () => {
    const events = [
      message("a1"),
      reaction("r1", "a1", "b", { at: T0 + 10, pubkey: BOB }),
      reaction("r2", "a1", "a", { at: T0 + 10, pubkey: CAROL }),
      reaction("r3", "a1", "c", { at: T0 + 10, pubkey: ALICE }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result[0].reactions.map((r) => r.emoji)).toEqual(["a", "b", "c"]);
  });

  it("defaults empty content to +", () => {
    const events = [message("a1"), reaction("r1", "a1", "   ")];
    expect(project(events)[0].reactions[0].emoji).toBe("+");
  });

  it("resolves a shortcode against the event's NIP-30 emoji tag", () => {
    const events = [
      message("a1"),
      reaction("r1", "a1", ":party_parrot:", {
        tags: [
          ["h", CHANNEL],
          ["e", hex("a1")],
          ["emoji", "party_parrot", "https://cdn.example/parrot.gif"],
        ],
      }),
    ];
    const pill = project(events)[0].reactions[0];
    expect(pill.emoji).toBe(":party_parrot:");
    expect(pill.emojiUrl).toBe("https://cdn.example/parrot.gif");
  });

  it("leaves a unicode reaction with no url", () => {
    expect(project([message("a1"), reaction("r1", "a1", "🎉")])[0].reactions[0].emojiUrl)
      .toBeUndefined();
  });

  it("targets the LAST e tag", () => {
    const events = [
      message("a1"),
      message("b2", { tags: replyTags("a1") }),
      reaction("r1", "x", "🎉", {
        tags: [
          ["h", CHANNEL],
          ["e", hex("a1"), "", "root"],
          ["e", hex("b2")],
        ],
      }),
    ];
    const result = expectOrderInvariant(events, (input) => project(input));
    expect(result.find((m) => m.id === hex("a1"))?.reactions).toEqual([]);
    expect(result.find((m) => m.id === hex("b2"))?.reactions[0].emoji).toBe("🎉");
  });

  it("ignores a deleted reaction event", () => {
    const events = [message("a1"), reaction("r1", "a1", "🎉"), deletion("d1", ["r1"])];
    expect(expectOrderInvariant(events, (input) => project(input))[0].reactions).toEqual([]);
  });

  it("puts You first among the reactors and sets mine", () => {
    const events = [
      message("a1"),
      reaction("r1", "a1", "🎉", { pubkey: BOB, at: T0 + 1 }),
      reaction("r2", "a1", "🎉", { pubkey: ALICE, at: T0 + 2 }),
      reaction("r3", "a1", "🎉", { pubkey: CAROL, at: T0 + 3 }),
    ];
    const actors = {
      [BOB]: { pubkey: BOB, label: "Bo" },
      [CAROL]: { pubkey: CAROL, label: "Cy" },
      [ALICE]: { pubkey: ALICE, label: "Ada" },
    };
    const result = expectOrderInvariant(events, (input) =>
      project(input, { selfPubkey: ALICE, actors }),
    );
    const pill = result[0].reactions[0];
    expect(pill.mine).toBe(true);
    expect(pill.count).toBe(3);
    expect(pill.reactors).toEqual(["You", "Bo", "Cy"]);
  });

  it("does not claim a reaction is mine when there is no reader", () => {
    const events = [message("a1"), reaction("r1", "a1", "🎉", { pubkey: BOB })];
    const pill = project(events)[0].reactions[0];
    expect(pill.mine).toBe(false);
    expect(pill.reactors).toEqual([truncatePubkey(BOB)]);
  });
});

// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("honours an actor tag on a relay-signed event", () => {
    const event: TimelineEvent = {
      id: hex("a1"),
      pubkey: RELAY,
      created_at: T0,
      kind: KIND_SYSTEM_MESSAGE,
      tags: [
        ["h", CHANNEL],
        ["actor", BOB],
      ],
      content: "{}",
    };
    expect(resolveAttributedPubkey(event, RELAY)).toBe(BOB);
    const projected = project([event], { relayPubkey: RELAY })[0];
    expect(projected.pubkey).toBe(BOB);
    expect(projected.signerPubkey).toBe(RELAY);
  });

  it("ignores an actor tag when the signer is not the relay", () => {
    // Otherwise any author could draw somebody else's name on their own message.
    const event: TimelineEvent = {
      id: hex("a1"),
      pubkey: ALICE,
      created_at: T0,
      kind: KIND_STREAM_MESSAGE_V2,
      tags: [
        ["h", CHANNEL],
        ["actor", BOB],
      ],
      content: "hello",
    };
    expect(resolveAttributedPubkey(event, RELAY)).toBe(ALICE);
    const projected = project([event], { relayPubkey: RELAY, selfPubkey: BOB })[0];
    expect(projected.pubkey).toBe(ALICE);
    expect(projected.mine).toBe(false);
  });

  it("ignores an actor tag entirely when no relay identity is supplied", () => {
    const event: TimelineEvent = {
      id: hex("a1"),
      pubkey: RELAY,
      created_at: T0,
      kind: KIND_SYSTEM_MESSAGE,
      tags: [["actor", BOB]],
      content: "{}",
    };
    expect(resolveAttributedPubkey(event)).toBe(RELAY);
  });

  it("falls back to the signer when the actor tag is malformed", () => {
    const event: TimelineEvent = {
      id: hex("a1"),
      pubkey: RELAY,
      created_at: T0,
      kind: KIND_SYSTEM_MESSAGE,
      tags: [["actor", "not-a-pubkey"]],
      content: "{}",
    };
    expect(resolveAttributedPubkey(event, RELAY)).toBe(RELAY);
  });

  it("resolves labels, agent flags and roles from the directory", () => {
    const actors = new Map([
      [
        BOB,
        {
          pubkey: BOB,
          label: "Scout",
          avatarUrl: "https://cdn.example/a.png",
          isAgent: true,
          ownerLabel: "Ada",
          role: "admin",
        },
      ],
    ]);
    const projected = project([message("a1", { pubkey: BOB })], { actors })[0];
    expect(projected.author).toBe("Scout");
    expect(projected.isAgent).toBe(true);
    expect(projected.ownerLabel).toBe("Ada");
    expect(projected.role).toBe("admin");
    expect(projected.authorAvatarUrl).toBe("https://cdn.example/a.png");
  });

  it("falls back to a truncated pubkey with no directory entry", () => {
    expect(project([message("a1", { pubkey: BOB })])[0].author).toBe(truncatePubkey(BOB));
    expect(truncatePubkey(BOB)).toBe(`${BOB.slice(0, 8)}…${BOB.slice(-4)}`);
  });
});

// ---------------------------------------------------------------------------

describe("§2.7 ordering", () => {
  it("sorts by created_at ascending with an id tiebreak, in both input orders", () => {
    const events = [
      message("c3", { at: T0 + 1 }),
      message("b2", { at: T0 }),
      message("a1", { at: T0 }),
      message("d4", { at: T0 - 1 }),
    ];
    const result = expectOrderInvariant(events, (input) => sortEvents(input).map((e) => e.id));
    expect(result).toEqual([hex("d4"), hex("a1"), hex("b2"), hex("c3")]);
  });

  it("keeps the LAST occurrence when an id is delivered twice", () => {
    const stale = message("a1", { body: "stale" });
    const fresh = message("a1", { body: "fresh" });
    expect(dedupeEventsById([stale, fresh]).map((e) => e.content)).toEqual(["fresh"]);
    expect(dedupeEventsById([fresh, stale]).map((e) => e.content)).toEqual(["stale"]);
  });

  it("does not merge two unkeyed events into one row", () => {
    const a: TimelineEvent = {
      pubkey: ALICE,
      created_at: T0,
      kind: KIND_STREAM_MESSAGE_V2,
      tags: [["h", CHANNEL]],
      content: "one",
    };
    const b: TimelineEvent = { ...a, content: "two" };
    expect(dedupeEventsById([a, b])).toHaveLength(2);
  });

  it("keys an optimistic row on its local key", () => {
    const pending: TimelineEvent = {
      pubkey: ALICE,
      created_at: T0,
      kind: KIND_STREAM_MESSAGE_V2,
      tags: [["h", CHANNEL]],
      content: "sending",
      localKey: "local-1",
      pending: true,
    };
    expect(dedupeEventsById([pending, { ...pending }])).toHaveLength(1);
    const projected = project([pending])[0];
    expect(projected.renderKey).toBe("local-1");
    expect(projected.id).toBe("");
    expect(projected.pending).toBe(true);
  });

  it("keeps the local key once the event is acknowledged", () => {
    // The whole point of renderKey: the row must not remount when the ack lands.
    const acked = message("a1", { localKey: "local-1" });
    expect(project([acked])[0].renderKey).toBe("local-1");
  });

  it("marks a failed optimistic row", () => {
    const failed = message("a1", { failed: true, pending: true });
    const projected = project([failed])[0];
    expect(projected.failed).toBe(true);
    expect(projected.pending).toBe(true);
  });

  it("emits messages in sorted order regardless of input order", () => {
    const events = [
      message("c3", { at: T0 + 2 }),
      message("a1", { at: T0 }),
      message("b2", { at: T0 + 1 }),
    ];
    expect(expectOrderInvariant(events, (input) => ids(project(input)))).toEqual([
      hex("a1"),
      hex("b2"),
      hex("c3"),
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("depth", () => {
  it("is 0 for a top-level message", () => {
    expect(project([message("a1")])[0].depth).toBe(0);
  });

  it("counts a loaded ancestor chain", () => {
    const events = [
      message("a1"),
      message("b2", { tags: replyTags("a1") }),
      message("c3", { tags: replyTags("b2", "a1") }),
      message("d4", { tags: replyTags("c3", "a1") }),
    ];
    const result = expectOrderInvariant(events, (input) =>
      Object.fromEntries(project(input).map((m) => [m.id, m.depth])),
    );
    expect(result[hex("a1")]).toBe(0);
    expect(result[hex("b2")]).toBe(1);
    expect(result[hex("c3")]).toBe(2);
    expect(result[hex("d4")]).toBe(3);
  });

  it("falls back to 1 when the parent is not loaded and is the root", () => {
    const events = [message("b2", { tags: replyTags("a1") })];
    expect(project(events)[0].depth).toBe(1);
  });

  it("falls back to 2 when the parent is not loaded and differs from the root", () => {
    const events = [message("c3", { tags: replyTags("b2", "a1") })];
    expect(project(events)[0].depth).toBe(2);
  });

  it("terminates on a two-node cycle and returns a finite depth", () => {
    const depths = resolveDepths([
      { id: hex("a1"), parentId: hex("b2"), rootId: hex("b2") },
      { id: hex("b2"), parentId: hex("a1"), rootId: hex("a1") },
    ]);
    expect(depths.get(hex("a1"))).toBe(1);
    expect(depths.get(hex("b2"))).toBe(1);
  });

  it("terminates on a longer cycle, in both node orders", () => {
    const nodes = [
      { id: hex("a1"), parentId: hex("c3"), rootId: hex("f0") },
      { id: hex("b2"), parentId: hex("a1"), rootId: hex("f0") },
      { id: hex("c3"), parentId: hex("b2"), rootId: hex("f0") },
    ];
    const forward = resolveDepths(nodes);
    const backward = resolveDepths([...nodes].reverse());
    for (const node of nodes) {
      expect(Number.isFinite(forward.get(node.id))).toBe(true);
      expect(backward.get(node.id)).toBe(forward.get(node.id));
    }
  });

  it("gives a descendant of a cycle a finite depth too", () => {
    const depths = resolveDepths([
      { id: hex("a1"), parentId: hex("b2"), rootId: hex("b2") },
      { id: hex("b2"), parentId: hex("a1"), rootId: hex("a1") },
      { id: hex("c3"), parentId: hex("a1"), rootId: hex("a1") },
    ]);
    expect(Number.isFinite(depths.get(hex("c3")))).toBe(true);
  });

  it("terminates on a self-parent", () => {
    const depths = resolveDepths([{ id: hex("a1"), parentId: hex("a1"), rootId: hex("a1") }]);
    expect(depths.get(hex("a1"))).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("top-level rows and the paging count", () => {
  it("keeps top-level messages and broadcast replies", () => {
    const events = [
      message("a1"),
      message("b2", { tags: replyTags("a1") }),
      message("c3", { tags: [...replyTags("a1"), ["broadcast", "1"]] }),
    ];
    const result = expectOrderInvariant(events, (input) => ids(topLevelMessages(project(input))));
    expect(result).toEqual([hex("a1"), hex("c3")]);
  });

  it("counts visible top-level rows, not events", () => {
    const events = [
      message("a1"),
      message("b2", { tags: replyTags("a1") }),
      message("c3", { tags: replyTags("a1") }),
      edit("e1", "a1", "fixed"),
      reaction("r1", "a1", "🎉"),
      deletion("d1", ["c3"]),
      message("f6"),
    ];
    const count = expectOrderInvariant(events, (input) => countTopLevelTimelineRows(input));
    expect(count).toBe(2);
    expect(count).not.toBe(events.length);
  });

  it("counts a broadcast reply as a row", () => {
    const events = [
      message("a1"),
      message("b2", { tags: [...replyTags("a1"), ["broadcast", "1"]] }),
    ];
    expect(countTopLevelTimelineRows(events)).toBe(2);
  });

  it("agrees with the full projection", () => {
    const events = [
      message("a1"),
      message("b2", { tags: replyTags("a1") }),
      message("c3", { tags: [...replyTags("a1"), ["broadcast", "1"]] }),
      message("d4", { kind: KIND_SYSTEM_MESSAGE, body: "{}" }),
      deletion("d9", ["a1"]),
    ];
    expect(countTopLevelTimelineRows(events)).toBe(topLevelMessages(project(events)).length);
  });
});

// ---------------------------------------------------------------------------

describe("§2.10 day dividers", () => {
  it("keys a day row on the start of the local day", () => {
    const dayOne = at(2026, 4, 1, 23, 30);
    const dayTwo = at(2026, 4, 2, 0, 30);
    const result = rows([message("a1", { at: dayOne }), message("b2", { at: dayTwo })]);
    expect(rowTypes(result)).toEqual(["message", "day", "message"]);
    const day = result[1];
    expect(day.type === "day" && day.at).toBe(startOfLocalDaySeconds(dayTwo));
  });

  it("does not draw a divider above the oldest loaded day while history remains", () => {
    // Its start is the arbitrary edge of the loaded window, not the day's start.
    const result = rows([message("a1", { at: at(2026, 4, 1) })]);
    expect(rowTypes(result)).toEqual(["message"]);
  });

  it("draws the oldest divider once history is exhausted", () => {
    const result = rows([message("a1", { at: at(2026, 4, 1) })], { historyExhausted: true });
    expect(rowTypes(result)).toEqual(["day", "message"]);
  });

  it("emits one divider per day boundary, whatever order the events arrived in", () => {
    const events = [
      message("c3", { at: at(2026, 4, 3, 9) }),
      message("a1", { at: at(2026, 4, 1, 9) }),
      message("b2", { at: at(2026, 4, 2, 9) }),
      message("d4", { at: at(2026, 4, 3, 10) }),
    ];
    const result = expectOrderInvariant(events, (input) => rowTypes(rows(input)));
    expect(result).toEqual(["message", "day", "message", "day", "message", "message"]);
  });

  it("reuses the same day key when an older same-day message prepends", () => {
    const noon = at(2026, 4, 2, 12);
    const morning = at(2026, 4, 2, 9);
    const before = rows([message("a1", { at: at(2026, 4, 1) }), message("b2", { at: noon })]);
    const after = rows([
      message("a1", { at: at(2026, 4, 1) }),
      message("c3", { at: morning }),
      message("b2", { at: noon }),
    ]);
    const dayOf = (r: ChatRow[]) => r.find((row) => row.type === "day");
    expect(dayOf(after)).toEqual(dayOf(before));
  });
});

// ---------------------------------------------------------------------------

describe("§2.10 grouping", () => {
  const grouped = (result: ChatRow[]): boolean[] =>
    result.filter((r): r is Extract<ChatRow, { type: "message" }> => r.type === "message")
      .map((r) => r.grouped);

  it("groups the same author inside the window", () => {
    expect(grouped(rows([message("a1"), message("b2", { at: T0 + 60 })]))).toEqual([false, true]);
  });

  it("treats the 600-second boundary as inclusive and 601 as out", () => {
    expect(isWithinGroupingWindow(T0, T0 + MESSAGE_GROUPING_WINDOW_SECONDS)).toBe(true);
    expect(isWithinGroupingWindow(T0, T0 + MESSAGE_GROUPING_WINDOW_SECONDS + 1)).toBe(false);
    expect(
      grouped(rows([message("a1"), message("b2", { at: T0 + MESSAGE_GROUPING_WINDOW_SECONDS })])),
    ).toEqual([false, true]);
    expect(
      grouped(
        rows([message("a1"), message("b2", { at: T0 + MESSAGE_GROUPING_WINDOW_SECONDS + 1 })]),
      ),
    ).toEqual([false, false]);
  });

  it("treats a negative gap as out of window", () => {
    expect(isWithinGroupingWindow(T0, T0 - 1)).toBe(false);
  });

  it("never groups two different authors", () => {
    expect(
      grouped(rows([message("a1"), message("b2", { at: T0 + 10, pubkey: BOB })])),
    ).toEqual([false, false]);
  });

  it("never matches an empty author against another empty author", () => {
    expect(hasSameMessageAuthor({ pubkey: "" }, { pubkey: "" })).toBe(false);
    expect(hasSameMessageAuthor({ pubkey: ALICE.toUpperCase() }, { pubkey: ALICE })).toBe(true);
  });

  it("renders a pending row standalone, on either side", () => {
    const pending = message("b2", { at: T0 + 10, pending: true });
    expect(grouped(rows([message("a1"), pending]))).toEqual([false, false]);
    expect(grouped(rows([pending, message("c3", { at: T0 + 20 })]))).toEqual([false, false]);
  });

  it("resets grouping across a day divider", () => {
    const lateNight = at(2026, 4, 1, 23, 59, 30);
    const justAfter = at(2026, 4, 2, 0, 0, 30);
    const result = rows([message("a1", { at: lateNight }), message("b2", { at: justAfter })]);
    expect(rowTypes(result)).toEqual(["message", "day", "message"]);
    expect(grouped(result)).toEqual([false, false]);
  });

  it("resets grouping across a system row", () => {
    const result = rows([
      message("a1"),
      {
        id: hex("s1"),
        pubkey: RELAY,
        created_at: T0 + 10,
        kind: KIND_SYSTEM_MESSAGE,
        tags: [["h", CHANNEL]],
        content: JSON.stringify({ type: "member_joined", actor: BOB, target: BOB }),
      },
      message("c3", { at: T0 + 20 }),
    ]);
    expect(rowTypes(result)).toEqual(["message", "system", "message"]);
    expect(grouped(result)).toEqual([false, false]);
  });

  it("resets grouping across the unread divider", () => {
    const result = rows([message("a1"), message("b2", { at: T0 + 10 })], {
      firstUnreadId: hex("b2"),
    });
    expect(rowTypes(result)).toEqual(["message", "unread", "message"]);
    expect(grouped(result)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------

describe("§2.10 the unread divider", () => {
  it("sits above the first unread message", () => {
    const result = rows(
      [message("a1"), message("b2", { at: T0 + 10 }), message("c3", { at: T0 + 20 })],
      { firstUnreadId: hex("b2") },
    );
    expect(rowTypes(result)).toEqual(["message", "unread", "message", "message"]);
  });

  it("counts the rows below it when read state gives no count", () => {
    const result = rows(
      [message("a1"), message("b2", { at: T0 + 10 }), message("c3", { at: T0 + 20 })],
      { firstUnreadId: hex("b2") },
    );
    const divider = result[1];
    expect(divider.type === "unread" && divider.count).toBe(2);
  });

  it("prefers an authoritative count from read state", () => {
    const result = rows([message("a1"), message("b2", { at: T0 + 10 })], {
      firstUnreadId: hex("a1"),
      unreadCount: 47,
    });
    const divider = result[0];
    expect(divider.type === "unread" && divider.count).toBe(47);
  });

  it("is drawn at most once", () => {
    const result = rows([message("a1"), message("a1", { body: "dup" })], {
      firstUnreadId: hex("a1"),
    });
    expect(result.filter((r) => r.type === "unread")).toHaveLength(1);
  });

  it("is absent when the first unread message is not in the window", () => {
    const result = rows([message("a1")], { firstUnreadId: hex("f9") });
    expect(rowTypes(result)).toEqual(["message"]);
  });

  it("is absent when the first unread message is a thread reply", () => {
    // A thread reply does not occupy a channel row, so there is nowhere to
    // draw the line — the thread pane owns that unread, not the transcript.
    const result = rows(
      [message("a1"), message("b2", { at: T0 + 10, tags: replyTags("a1") })],
      { firstUnreadId: hex("b2") },
    );
    expect(rowTypes(result)).toEqual(["message"]);
  });
});

// ---------------------------------------------------------------------------

describe("§2.10 system rows", () => {
  const self = { name: (pk?: string) => (pk === ALICE ? "You" : "Bo"), inlineName: (pk?: string) => (pk === ALICE ? "you" : "bo") };

  it("covers the copy table", () => {
    const ctx = {
      name: (pk?: string) => (pk === ALICE ? "Ada" : pk === BOB ? "Bo" : "Cy"),
      inlineName: (pk?: string) => (pk === ALICE ? "ada" : pk === BOB ? "bo" : "cy"),
    };
    expect(
      describeSystemEvent({ type: "members_added", actor: BOB, target: ALICE, others: [CAROL] }, ctx),
    ).toBe("Ada added by bo, along with cy");
    expect(
      describeSystemEvent({ type: "members_joined", target: ALICE, others: [BOB, CAROL] }, ctx),
    ).toBe("Ada joined the channel along with bo and cy");
    expect(describeSystemEvent({ type: "member_joined", actor: ALICE, target: ALICE }, ctx)).toBe(
      "Ada joined the channel",
    );
    expect(describeSystemEvent({ type: "member_joined", actor: BOB, target: ALICE }, ctx)).toBe(
      "Ada added by bo",
    );
    expect(describeSystemEvent({ type: "member_left", actor: BOB }, ctx)).toBe(
      "Bo left the channel",
    );
    expect(describeSystemEvent({ type: "member_removed", actor: BOB, target: ALICE }, ctx)).toBe(
      "Bo removed ada from the channel",
    );
    expect(describeSystemEvent({ type: "channel_created", actor: BOB }, ctx)).toBe(
      "Bo created this channel",
    );
    expect(describeSystemEvent({ type: "channel_archived", actor: BOB }, ctx)).toBe(
      "Bo archived this channel",
    );
    expect(describeSystemEvent({ type: "channel_unarchived", actor: BOB }, ctx)).toBe(
      "Bo unarchived this channel",
    );
    expect(describeSystemEvent({ type: "message_deleted", actor: BOB }, ctx)).toBe(
      "Bo removed a message",
    );
    expect(
      describeSystemEvent({ type: "message_deleted", actor: BOB, public_reason: "spam" }, ctx),
    ).toBe("Removed by community moderators “spam”");
  });

  it("reads a blank topic as cleared, not as renamed to nothing", () => {
    expect(describeSystemEvent({ type: "topic_changed", actor: ALICE, value: "   " }, self)).toBe(
      "You cleared the topic",
    );
    expect(describeSystemEvent({ type: "topic_changed", actor: ALICE, value: "Ship it" }, self)).toBe(
      "You changed the topic to “Ship it”",
    );
    expect(describeSystemEvent({ type: "purpose_changed", actor: ALICE }, self)).toBe(
      "You cleared the purpose",
    );
  });

  it("decides self by pubkey, never by matching the string You", () => {
    // Somebody who names themselves "You" must not make the room address
    // everybody as themselves.
    const events = [
      {
        id: hex("s1"),
        pubkey: RELAY,
        created_at: T0,
        kind: KIND_SYSTEM_MESSAGE,
        tags: [["h", CHANNEL]],
        content: JSON.stringify({ type: "member_left", actor: BOB }),
      },
    ];
    const actors = { [BOB]: { pubkey: BOB, label: "You" } };
    const asAlice = rows(events, {}, { selfPubkey: ALICE, actors, relayPubkey: RELAY });
    const asBob = rows(events, {}, { selfPubkey: BOB, actors, relayPubkey: RELAY });
    const text = (r: ChatRow[]) => (r[0].type === "system" ? r[0].text : "");
    expect(text(asAlice)).toBe("You left the channel");
    expect(text(asBob)).toBe("You left the channel");
    // Same words, different reasons — and Alice's is the label, so a second
    // reader with a different label proves the resolver ran.
    const asAliceNoLabel = rows(events, {}, { selfPubkey: ALICE, relayPubkey: RELAY });
    expect(text(asAliceNoLabel)).toBe(`${truncatePubkey(BOB)} left the channel`);
  });

  it("emits a system row rather than a message row", () => {
    const result = rows(
      [
        {
          id: hex("s1"),
          pubkey: RELAY,
          created_at: T0,
          kind: KIND_SYSTEM_MESSAGE,
          tags: [["h", CHANNEL]],
          content: JSON.stringify({ type: "channel_created", actor: ALICE }),
        },
      ],
      {},
      { selfPubkey: ALICE, relayPubkey: RELAY },
    );
    expect(result).toEqual([{ type: "system", id: hex("s1"), at: T0, text: "You created this channel" }]);
  });

  it("falls back to the raw content when the payload is not JSON", () => {
    const result = rows([
      {
        id: hex("s1"),
        pubkey: RELAY,
        created_at: T0,
        kind: KIND_SYSTEM_MESSAGE,
        tags: [["h", CHANNEL]],
        content: "the relay said something new",
      },
    ]);
    expect(result[0].type === "system" && result[0].text).toBe("the relay said something new");
  });

  it("clamps a moderator's public reason", () => {
    const reason = `${"x".repeat(400)}\n\nspam`;
    const text = describeSystemEvent(
      { type: "message_deleted", actor: BOB, public_reason: reason },
      self,
    );
    expect(text.length).toBeLessThan(240);
    expect(text).not.toContain("\n");
  });

  it("says nothing for a payload type it does not know", () => {
    expect(describeSystemEvent({ type: "quantum_event" }, self)).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("§2.10 system-message grouping", () => {
  const person = (n: number): string => hex(`p${n}`);
  const PEOPLE: Record<string, { pubkey: string; label: string }> = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [person(n), { pubkey: person(n), label: `P${n}` }]),
  );
  const withPeople: TimelineOptions = { actors: PEOPLE, relayPubkey: RELAY };

  function system(seed: string, payload: Record<string, unknown>, when: number): TimelineEvent {
    return {
      id: hex(seed),
      pubkey: RELAY,
      created_at: when,
      kind: KIND_SYSTEM_MESSAGE,
      tags: [["h", CHANNEL]],
      content: JSON.stringify(payload),
    };
  }
  /** Somebody joining under their own steam: actor === target. */
  const joined = (seed: string, who: number, when: number): TimelineEvent =>
    system(seed, { type: "member_joined", actor: person(who), target: person(who) }, when);
  /** Somebody added by another member: actor !== target. */
  const addedBy = (seed: string, who: number, by: number, when: number): TimelineEvent =>
    system(seed, { type: "member_joined", actor: person(by), target: person(who) }, when);
  const left = (seed: string, who: number, when: number): TimelineEvent =>
    system(seed, { type: "member_left", actor: person(who) }, when);

  const group = (result: ChatRow[]): Extract<ChatRow, { type: "system-group" }> => {
    const row = result.find((r) => r.type === "system-group");
    if (!row || row.type !== "system-group") throw new Error("no system-group row");
    return row;
  };

  it("folds two joins exactly on the window boundary", () => {
    const events = [
      joined("j1", 1, T0),
      joined("j2", 2, T0 + MEMBERSHIP_GROUP_WINDOW_SECONDS),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system-group"]);
    expect(group(result).actors).toEqual(["P1", "P2"]);
  });

  it("does not fold two joins one second outside it", () => {
    const events = [
      joined("j1", 1, T0),
      joined("j2", 2, T0 + MEMBERSHIP_GROUP_WINDOW_SECONDS + 1),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "system"]);
  });

  it("leaves a run of one as a plain system row", () => {
    const result = rows([joined("j1", 1, T0)], {}, withPeople);
    expect(result).toEqual([
      { type: "system", id: hex("j1"), at: T0, text: "P1 joined the channel" },
    ]);
  });

  it("breaks the run on a different system kind rather than absorbing it", () => {
    const events = [
      joined("j1", 1, T0),
      system("s2", { type: "topic_changed", actor: person(5), value: "Ship it" }, T0 + 10),
      joined("j3", 2, T0 + 20),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "system", "system"]);
    expect(result.map((r) => (r.type === "system" ? r.text : ""))).toEqual([
      "P1 joined the channel",
      "P5 changed the topic to “Ship it”",
      "P2 joined the channel",
    ]);
  });

  it("breaks the run on a leave between two joins", () => {
    const events = [joined("j1", 1, T0), left("l2", 5, T0 + 10), joined("j3", 2, T0 + 20)];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "system", "system"]);
  });

  it("breaks the run on an ordinary message between two joins", () => {
    // The transcript plainly shows they did not happen together.
    const events = [
      joined("j1", 1, T0),
      message("a1", { at: T0 + 10 }),
      joined("j3", 2, T0 + 20),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "message", "system"]);
  });

  it("folds joins and adds separately even when they are adjacent", () => {
    const events = [
      joined("j1", 1, T0),
      joined("j2", 2, T0 + 10),
      addedBy("j3", 3, 5, T0 + 20),
      addedBy("j4", 4, 5, T0 + 30),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system-group", "system-group"]);
    const groups = result.filter(
      (r): r is Extract<ChatRow, { type: "system-group" }> => r.type === "system-group",
    );
    expect(groups.map((g) => g.kind)).toEqual(["joined", "added"]);
    expect(groups[0].text).toBe("P1 and P2 joined the channel");
    expect(groups[1].text).toBe("P3 and P4 added by P5");
  });

  it("refuses to fold two adds by different people", () => {
    // Folding would put one adder's name on the other's action.
    const events = [addedBy("j1", 1, 5, T0), addedBy("j2", 2, 6, T0 + 10)];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "system"]);
  });

  it("folds three joins into one row keyed on the newest", () => {
    const events = [joined("j1", 1, T0), joined("j2", 2, T0 + 10), joined("j3", 3, T0 + 20)];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(result).toEqual([
      {
        type: "system-group",
        id: hex("j3"),
        at: T0 + 20,
        kind: "joined",
        actors: ["P1", "P2", "P3"],
        text: "P1, P2 and P3 joined the channel",
      },
    ]);
  });

  it("folds leaves too", () => {
    const events = [left("l1", 1, T0), left("l2", 2, T0 + 10)];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(group(result).kind).toBe("left");
    expect(group(result).text).toBe("P1 and P2 left the channel");
  });

  it("keeps every actor but caps the sentence", () => {
    const events = [1, 2, 3, 4, 5, 6].map((n, i) => joined(`j${n}`, n, T0 + i * 10));
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    const folded = group(result);
    // The facepile gets all six; the sentence is a summary and stays one.
    expect(folded.actors).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
    expect(folded.text).toBe("P1, P2, P3 and 3 others joined the channel");
  });

  it("says 1 other rather than 1 others", () => {
    const events = [1, 2, 3, 4].map((n, i) => joined(`j${n}`, n, T0 + i * 10));
    expect(group(rows(events, {}, withPeople)).text).toBe(
      "P1, P2, P3 and 1 other joined the channel",
    );
  });

  it("addresses the reader as themselves, by pubkey", () => {
    const events = [joined("j1", 1, T0), joined("j2", 2, T0 + 10)];
    const asSecond = rows(events, {}, { ...withPeople, selfPubkey: person(2) });
    expect(group(asSecond).actors).toEqual(["P1", "You"]);
    expect(group(asSecond).text).toBe("P1 and you joined the channel");

    const asFirst = rows(events, {}, { ...withPeople, selfPubkey: person(1) });
    expect(group(asFirst).actors).toEqual(["You", "P2"]);
    expect(group(asFirst).text).toBe("You and P2 joined the channel");
  });

  it("does not fold across a day divider", () => {
    const events = [
      joined("j1", 1, at(2026, 4, 1, 23, 59, 0)),
      joined("j2", 2, at(2026, 4, 2, 0, 1, 0)),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "day", "system"]);
  });

  it("does not fold across the unread divider", () => {
    const events = [joined("j1", 1, T0), joined("j2", 2, T0 + 10)];
    const result = rows(events, { firstUnreadId: hex("j2") }, withPeople);
    expect(rowTypes(result)).toEqual(["system", "unread", "system"]);
  });

  it("anchors on the newest, so prepending older history cannot repartition", () => {
    // Grouping forwards from the oldest looks identical on a static list and
    // rewrites the screen every time paging lands. This is the test that tells
    // the two apart.
    const recent = [
      joined("j1", 1, T0),
      joined("j2", 2, T0 + 250),
      joined("j3", 3, T0 + 500),
    ];
    const before = rows(recent, {}, withPeople);
    expect(rowTypes(before)).toEqual(["system", "system-group"]);
    expect(group(before).actors).toEqual(["P2", "P3"]);

    const withHistory = [joined("j0", 4, T0 - 100), ...recent];
    const after = rows(withHistory, {}, withPeople);
    expect(rowTypes(after)).toEqual(["system-group", "system-group"]);
    // The group that was already on the screen is untouched — same id, same
    // members, same sentence.
    expect(after[1]).toEqual(before[1]);
    const older = after[0];
    expect(older.type === "system-group" && older.actors).toEqual(["P4", "P1"]);
  });

  it("resets message grouping the way a single system row does", () => {
    const events = [
      message("a1", { at: T0 }),
      joined("j1", 1, T0 + 10),
      joined("j2", 2, T0 + 20),
      message("c3", { at: T0 + 30 }),
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["message", "system-group", "message"]);
    const drawn = result.filter(
      (r): r is Extract<ChatRow, { type: "message" }> => r.type === "message",
    );
    expect(drawn.map((r) => r.grouped)).toEqual([false, false]);
  });

  it("does not fold a system event whose payload is not JSON", () => {
    const events = [
      { ...joined("j1", 1, T0), content: "something new" },
      { ...joined("j2", 2, T0 + 10), content: "something new" },
    ];
    const result = expectOrderInvariant(events, (input) => rows(input, {}, withPeople));
    expect(rowTypes(result)).toEqual(["system", "system"]);
  });

  it("composes the same sentence through describeSystemGroup directly", () => {
    // The names arrive already resolved — only the self pronoun is ever
    // lowercased, and that decision was made by the copy context, not here.
    expect(describeSystemGroup("joined", ["P1", "you"], "P5")).toBe(
      "P1 and you joined the channel",
    );
    expect(describeSystemGroup("added", ["P1", "P2"], "P5")).toBe("P1 and P2 added by P5");
    expect(describeSystemGroup("left", ["P1"], "")).toBe("P1 left the channel");
  });
});

describe("projectTimeline end to end", () => {
  const scenario: TimelineEvent[] = [
    message("a1", { at: at(2026, 4, 1, 9, 0), body: "morning" }),
    message("b2", { at: at(2026, 4, 1, 9, 5), body: "typo" }),
    edit("e1", "b2", "fixed", { at: at(2026, 4, 1, 9, 6) }),
    edit("e2", "b2", "fixed again", { at: at(2026, 4, 1, 9, 7) }),
    message("c3", { at: at(2026, 4, 1, 9, 30), body: "gone", pubkey: BOB }),
    deletion("d1", ["c3"], { at: at(2026, 4, 1, 9, 31) }),
    reaction("r1", "c3", "👻", { at: at(2026, 4, 1, 9, 32) }),
    message("f6", { at: at(2026, 4, 2, 10, 0), body: "next day", pubkey: BOB }),
    message("a7", {
      at: at(2026, 4, 2, 10, 1),
      body: "a reply",
      pubkey: CAROL,
      tags: replyTags("f6"),
    }),
    message("b8", {
      at: at(2026, 4, 2, 10, 2),
      body: "broadcast reply",
      pubkey: CAROL,
      tags: [...replyTags("f6"), ["broadcast", "1"]],
    }),
    reaction("r2", "f6", "🎉", { at: at(2026, 4, 2, 10, 3), pubkey: ALICE }),
    reaction("r3", "f6", "🔥", { at: at(2026, 4, 2, 10, 4), pubkey: CAROL }),
  ];

  it("produces the same rows in both input orders", () => {
    expectOrderInvariant(scenario, (input) =>
      rows(input, { historyExhausted: true, firstUnreadId: hex("f6") }, { selfPubkey: ALICE }),
    );
  });

  it("draws the transcript the spec describes", () => {
    const result = rows(
      scenario,
      { historyExhausted: true, firstUnreadId: hex("f6") },
      { selfPubkey: ALICE },
    );
    expect(rowTypes(result)).toEqual([
      "day",
      "message", // morning
      "message", // fixed again (grouped under morning)
      "day",
      "unread",
      "message", // next day
      "message", // broadcast reply
    ]);

    const messages = result.filter(
      (r): r is Extract<ChatRow, { type: "message" }> => r.type === "message",
    );
    expect(messages.map((r) => r.message.body)).toEqual([
      "morning",
      "fixed again",
      "next day",
      "broadcast reply",
    ]);
    // Same author, 5 minutes apart, no divider between them.
    expect(messages.map((r) => r.grouped)).toEqual([false, true, false, false]);
    // The deleted message and its reaction are both gone.
    expect(messages.some((r) => r.message.body === "gone")).toBe(false);
    // The edit kept the original's identity.
    expect(messages[1].message.id).toBe(hex("b2"));
    expect(messages[1].message.edited).toBe(true);
    // The plain thread reply is not a channel row.
    expect(messages.some((r) => r.message.body === "a reply")).toBe(false);
    // Reactions landed on the right row, earliest first, with You in front.
    expect(messages[2].message.reactions.map((r) => r.emoji)).toEqual(["🎉", "🔥"]);
    expect(messages[2].message.reactions[0].mine).toBe(true);
    expect(messages[2].message.reactions[0].reactors).toEqual(["You"]);
    // The broadcast reply is a row and still knows it is a reply.
    expect(messages[3].message.depth).toBe(1);
    expect(messages[3].message.parentId).toBe(hex("f6"));
  });

  it("highlights only the jump target", () => {
    const result = project(scenario, { highlightedId: hex("f6") });
    expect(result.filter((m) => m.highlighted).map((m) => m.id)).toEqual([hex("f6")]);
  });

  it("marks the reader's own messages", () => {
    const result = project(scenario, { selfPubkey: BOB });
    expect(result.filter((m) => m.mine).map((m) => m.body).sort()).toEqual(["next day"]);
  });

  it("draws whatever rows it is handed, which is how a thread pane reuses it", () => {
    // `projectTimeline` narrows to the channel's top-level rows; the row builder
    // itself does not, so a thread pane can hand it a reply chain and get the
    // same dividers and grouping without a second implementation of either.
    const all = formatTimelineMessages(scenario, { selfPubkey: ALICE });
    const thread = all.filter((m) => m.rootId === hex("f6") || m.id === hex("f6"));
    const result = buildTimelineRows(thread, { historyExhausted: true });
    expect(rowTypes(result)).toEqual(["day", "message", "message", "message"]);
    const drawn = result.filter(
      (r): r is Extract<ChatRow, { type: "message" }> => r.type === "message",
    );
    expect(drawn.map((r) => r.message.body)).toEqual([
      "next day",
      "a reply",
      "broadcast reply",
    ]);
    // Different authors either side of the first reply, so no grouping.
    expect(drawn.map((r) => r.grouped)).toEqual([false, false, true]);
  });

  it("survives an empty window", () => {
    expect(projectTimeline([])).toEqual([]);
    expect(countTopLevelTimelineRows([])).toBe(0);
    expect(formatTimelineMessages([])).toEqual([]);
  });
});
