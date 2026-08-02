import { describe, expect, it } from "vitest";
import {
  eventId,
  isEphemeral,
  isParamReplaceable,
  isRegular,
  isReplaceable,
  markedTag,
  matchesFilter,
  publicKeyFromSecret,
  replacementKey,
  serializeEvent,
  signEvent,
  supersedes,
  tagValue,
  tagValues,
  verifyEvent,
  type UnsignedEvent,
} from "../convex/buzz/_nostr";

// A fixed key so every expectation in this file is reproducible.
const SK = "0000000000000000000000000000000000000000000000000000000000000007";
const PK = publicKeyFromSecret(SK);

function draft(over: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    pubkey: PK,
    created_at: 1_700_000_000,
    kind: 9,
    tags: [["h", "channel-1"]],
    content: "hello",
    ...over,
  };
}

describe("canonical serialization", () => {
  it("is the NIP-01 array, in order, with no whitespace", () => {
    expect(serializeEvent(draft())).toBe(
      `[0,"${PK}",1700000000,9,[["h","channel-1"]],"hello"]`,
    );
  });

  it("escapes content with JSON's own rules", () => {
    const s = serializeEvent(draft({ content: 'a "quote"\nand a newline' }));
    expect(s).toContain('"a \\"quote\\"\\nand a newline"');
  });

  it("produces a 32-byte id", () => {
    expect(eventId(draft())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the id when any field changes", () => {
    const base = eventId(draft());
    expect(eventId(draft({ content: "hello " }))).not.toBe(base);
    expect(eventId(draft({ created_at: 1_700_000_001 }))).not.toBe(base);
    expect(eventId(draft({ kind: 10 }))).not.toBe(base);
    expect(eventId(draft({ tags: [["h", "channel-2"]] }))).not.toBe(base);
  });
});

describe("keys", () => {
  it("derives a 32-byte x-only pubkey", () => {
    expect(PK).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a key that is not 32 bytes of hex", () => {
    expect(() => publicKeyFromSecret("abc")).toThrow(/32-byte hex/);
    expect(() => publicKeyFromSecret("z".repeat(64))).toThrow(/32-byte hex/);
  });

  it("accepts an 0x prefix and mixed case", () => {
    expect(publicKeyFromSecret(`0x${SK.toUpperCase()}`)).toBe(PK);
  });
});

describe("signing", () => {
  it("round-trips: a signed event verifies", () => {
    expect(verifyEvent(signEvent(draft(), SK))).toBe(true);
  });

  it("is deterministic, so a retry cannot mint a second distinct event", () => {
    expect(signEvent(draft(), SK).sig).toBe(signEvent(draft(), SK).sig);
  });

  it("needs no randomness — it works with globalThis.crypto removed", () => {
    // This is the property that lets an event be signed inside a Convex
    // mutation instead of a Node action, so it is worth asserting rather than
    // assuming. If a dependency bump reintroduces a CSPRNG call, this fails.
    const original = globalThis.crypto;
    // @ts-expect-error deliberately removing a global to prove independence
    delete globalThis.crypto;
    try {
      expect(verifyEvent(signEvent(draft(), SK))).toBe(true);
    } finally {
      globalThis.crypto = original;
    }
  });

  it("refuses to sign an event claiming a different author", () => {
    const impostor = draft({ pubkey: "a".repeat(64) });
    expect(() => signEvent(impostor, SK)).toThrow(/does not match/);
  });

  it("rejects a tampered content", () => {
    const event = signEvent(draft(), SK);
    expect(verifyEvent({ ...event, content: "goodbye" })).toBe(false);
  });

  it("rejects a valid signature over a substituted id", () => {
    // The attack the id-first check exists for: keep a real signature, swap the
    // body. The signature still verifies against the id it was made for, so
    // only recomputing the id from the content catches it.
    const real = signEvent(draft(), SK);
    const forged = { ...real, content: "goodbye", id: real.id, sig: real.sig };
    expect(verifyEvent(forged)).toBe(false);
  });

  it("rejects a signature from another key", () => {
    const other = "0000000000000000000000000000000000000000000000000000000000000009";
    const event = signEvent(draft(), SK);
    expect(verifyEvent({ ...event, pubkey: publicKeyFromSecret(other) })).toBe(false);
  });

  it("survives malformed hex without throwing", () => {
    const event = signEvent(draft(), SK);
    expect(verifyEvent({ ...event, sig: "nope" })).toBe(false);
    expect(verifyEvent({ ...event, pubkey: "nope" })).toBe(false);
  });
});

describe("tags", () => {
  const event = draft({
    tags: [
      ["e", "root-id", "", "root"],
      ["e", "reply-id", "", "reply"],
      ["p", "alice"],
      ["p", "bob"],
    ],
  });

  it("reads the first value of a named tag", () => {
    expect(tagValue(event, "e")).toBe("root-id");
    expect(tagValue(event, "missing")).toBeUndefined();
  });

  it("reads every value of a repeated tag, in order", () => {
    expect(tagValues(event, "p")).toEqual(["alice", "bob"]);
    expect(tagValues(event, "missing")).toEqual([]);
  });

  it("reads NIP-10 markers, so a reply is not rendered as a root", () => {
    expect(markedTag(event, "e", "root")).toBe("root-id");
    expect(markedTag(event, "e", "reply")).toBe("reply-id");
    expect(markedTag(event, "e", "mention")).toBeUndefined();
  });
});

describe("kind classification", () => {
  it("partitions the kind space totally and disjointly", () => {
    for (const kind of [0, 1, 3, 7, 9, 9999, 10000, 19999, 20000, 29999, 30000, 39999, 40002, 46001]) {
      const classes = [
        isReplaceable(kind),
        isEphemeral(kind),
        isParamReplaceable(kind),
        isRegular(kind),
      ].filter(Boolean);
      expect(classes, `kind ${kind} landed in ${classes.length} classes`).toHaveLength(1);
    }
  });

  it("puts the ranges where NIP-01 says", () => {
    expect(isReplaceable(0)).toBe(true);
    expect(isReplaceable(3)).toBe(true);
    expect(isReplaceable(10002)).toBe(true);
    expect(isEphemeral(20001)).toBe(true);
    expect(isParamReplaceable(30023)).toBe(true);
    expect(isRegular(9)).toBe(true);
    expect(isRegular(40002)).toBe(true);
  });
});

describe("replacement", () => {
  it("keys replaceable events on (kind, pubkey)", () => {
    expect(replacementKey(draft({ kind: 10002 }))).toBe(`10002:${PK}`);
  });

  it("keys parameterized-replaceable events on (kind, pubkey, d)", () => {
    expect(replacementKey(draft({ kind: 30023, tags: [["d", "slug"]] }))).toBe(
      `30023:${PK}:slug`,
    );
  });

  it("treats a missing d tag as the empty string, not as 'never replaces'", () => {
    // Otherwise an author who omits `d` accumulates duplicates the spec calls
    // one event.
    expect(replacementKey(draft({ kind: 30023, tags: [] }))).toBe(`30023:${PK}:`);
  });

  it("does not key regular events", () => {
    expect(replacementKey(draft({ kind: 9 }))).toBeNull();
  });

  it("prefers the later event", () => {
    const older = signEvent(draft({ kind: 10002, created_at: 100 }), SK);
    const newer = signEvent(draft({ kind: 10002, created_at: 200 }), SK);
    expect(supersedes(newer, older)).toBe(true);
    expect(supersedes(older, newer)).toBe(false);
  });

  it("breaks a same-second tie on the lower id, so two logs cannot diverge", () => {
    const a = signEvent(draft({ kind: 10002, created_at: 100, content: "a" }), SK);
    const b = signEvent(draft({ kind: 10002, created_at: 100, content: "b" }), SK);
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    expect(supersedes(low, high)).toBe(true);
    expect(supersedes(high, low)).toBe(false);
  });
});

describe("filter matching", () => {
  const event = signEvent(
    draft({
      kind: 9,
      created_at: 1_000,
      tags: [
        ["h", "channel-1"],
        ["p", "alice"],
      ],
    }),
    SK,
  );

  it("matches an empty filter", () => {
    expect(matchesFilter(event, {})).toBe(true);
  });

  it("filters on ids, authors and kinds", () => {
    expect(matchesFilter(event, { ids: [event.id] })).toBe(true);
    expect(matchesFilter(event, { ids: ["other"] })).toBe(false);
    expect(matchesFilter(event, { authors: [PK] })).toBe(true);
    expect(matchesFilter(event, { authors: ["other"] })).toBe(false);
    expect(matchesFilter(event, { kinds: [9, 10] })).toBe(true);
    expect(matchesFilter(event, { kinds: [10] })).toBe(false);
  });

  it("treats since/until as inclusive bounds", () => {
    expect(matchesFilter(event, { since: 1_000 })).toBe(true);
    expect(matchesFilter(event, { since: 1_001 })).toBe(false);
    expect(matchesFilter(event, { until: 1_000 })).toBe(true);
    expect(matchesFilter(event, { until: 999 })).toBe(false);
  });

  it("ORs within a tag condition and ANDs across conditions", () => {
    // The rule people get backwards. Two values of #h mean "either channel",
    // and adding #p narrows it further.
    expect(matchesFilter(event, { "#h": ["channel-1", "channel-2"] })).toBe(true);
    expect(matchesFilter(event, { "#h": ["channel-2"] })).toBe(false);
    expect(matchesFilter(event, { "#h": ["channel-1"], "#p": ["alice"] })).toBe(true);
    expect(matchesFilter(event, { "#h": ["channel-1"], "#p": ["bob"] })).toBe(false);
  });

  it("fails a tag condition the event has no tag for", () => {
    expect(matchesFilter(event, { "#zzz": ["anything"] })).toBe(false);
  });
});
