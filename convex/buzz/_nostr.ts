// NIP-01: the event, its identity, and its signature.
//
// The Chat dashboard's substrate is an append-only log of signed, kind-tagged
// events — the same shape Buzz puts on the wire. We store them in Convex rather
// than in a Nostr relay, but the events themselves are real: `id` is the
// SHA-256 of the NIP-01 canonical serialization, `sig` is a BIP-340 Schnorr
// signature over that id, and an event lifted out of our log verifies in any
// Nostr tool. That is the whole point of doing it properly — "signed-ish" would
// have been half the work and none of the guarantee.
//
// Pure — no ctx, no Convex imports — so mutations, actions, tests and the
// client all use this one copy. A second implementation of `eventId` is how two
// implementations start disagreeing about what an event *is*.
//
// Why this can run in a mutation, which matters more than it looks:
// `@noble/curves` is pure JS with no Node built-ins, and BIP-340 signing with an
// explicitly supplied `aux` needs no CSPRNG. Convex mutations forbid randomness,
// so a library that reached for `crypto.getRandomValues` would have forced every
// write through a `"use node"` action and a scheduler hop — which means a window
// where an unsigned event is already in the database. Signing here instead means
// the event is signed in the same transaction that writes it, and an unsigned
// event is never observable.

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** A tag is a list of strings; the first element names it. `["e", "<id>", "", "root"]` */
export type NostrTag = string[];

/** What an author writes. No id, no sig — those are derived. */
export type UnsignedEvent = {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
};

/** What lands in the log. */
export type NostrEvent = UnsignedEvent & {
  id: string;
  sig: string;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The NIP-01 canonical serialization.
 *
 * Exactly this array, in exactly this order, with no whitespace:
 *   [0, pubkey, created_at, kind, tags, content]
 *
 * `JSON.stringify` is the specified escaping — NIP-01 defers to JSON's own
 * rules rather than inventing an escaping scheme, which is the only reason two
 * independent implementations agree on a hash at all. Do not "tidy" this into
 * a hand-rolled string builder.
 */
export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** The event id: SHA-256 of the canonical serialization, lowercase hex. */
export function eventId(event: UnsignedEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The x-only public key for a secret key, as 64 hex chars.
 *
 * "x-only" is why a Nostr pubkey is 32 bytes and not 33: BIP-340 drops the
 * parity byte. A 66-char key here means somebody handed us a compressed SEC1
 * key from a different curve library.
 */
export function publicKeyFromSecret(secretKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(normalizeKey(secretKeyHex, 32))));
}

function normalizeKey(hex: string, bytes: number): string {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== bytes * 2 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`expected ${bytes}-byte hex key, got ${clean.length / 2} bytes`);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * BIP-340 wants 32 bytes of auxiliary randomness. We have none — a Convex
 * mutation is deterministic by construction — so we derive it from the secret
 * key and the message. That is the "deterministic nonce" variant BIP-340
 * explicitly permits, and it is what RFC-6979 does for ECDSA: the nonce still
 * differs for every (key, message) pair, which is the property that actually
 * matters. All-zero aux would also be valid, but deriving costs one hash and
 * removes a whole class of "every signature shares an aux" questions.
 *
 * Signing the same event twice therefore produces the same signature. That is a
 * feature: re-signing on a retry cannot produce a second distinct-looking event.
 */
function auxFor(secretKey: Uint8Array, idHex: string): Uint8Array {
  const tag = sha256(new TextEncoder().encode("operate.to/buzz/aux"));
  const input = new Uint8Array(tag.length * 2 + secretKey.length + 32);
  input.set(tag, 0);
  input.set(tag, tag.length);
  input.set(secretKey, tag.length * 2);
  input.set(hexToBytes(idHex), tag.length * 2 + secretKey.length);
  return sha256(input);
}

/**
 * Derive the id, sign it, and return the finished event.
 *
 * The pubkey on the draft must match the secret key — signing an event that
 * claims to be from somebody else produces a signature that verifies against
 * nobody, and it would be stored as a permanently broken row. Refuse instead.
 */
export function signEvent(draft: UnsignedEvent, secretKeyHex: string): NostrEvent {
  const sk = hexToBytes(normalizeKey(secretKeyHex, 32));
  const derived = bytesToHex(schnorr.getPublicKey(sk));
  if (derived !== draft.pubkey) {
    throw new Error("refusing to sign: event pubkey does not match the signing key");
  }
  const id = eventId(draft);
  const sig = bytesToHex(schnorr.sign(id, sk, auxFor(sk, id)));
  return { ...draft, id, sig };
}

/**
 * Verify an event end to end: the id must be the hash of its own content, and
 * the signature must be over that id by that pubkey.
 *
 * Checking the id first is not an optimization — a valid signature over a
 * *different* id would otherwise pass while the stored content says something
 * else entirely.
 */
export function verifyEvent(event: NostrEvent): boolean {
  try {
    if (eventId(event) !== event.id) return false;
    return schnorr.verify(
      hexToBytes(normalizeKey(event.sig, 64)),
      event.id,
      hexToBytes(normalizeKey(event.pubkey, 32)),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** The first value of the first tag with this name, or undefined. */
export function tagValue(event: UnsignedEvent, name: string): string | undefined {
  const tag = event.tags.find((t) => t[0] === name);
  return tag?.[1];
}

/** Every value for a repeated tag, in order. `p` tags on a DM, for instance. */
export function tagValues(event: UnsignedEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]);
}

/**
 * NIP-10 markers: an `e` tag carries its role in position 3
 * (`["e", id, relay, "root" | "reply" | "mention"]`).
 *
 * Buzz threads are root/reply, and a client that ignores the marker renders a
 * reply as a top-level message — which is why this is a named function rather
 * than an index into an array at each call site.
 */
export function markedTag(
  event: UnsignedEvent,
  name: string,
  marker: string,
): string | undefined {
  return event.tags.find((t) => t[0] === name && t[3] === marker)?.[1];
}

// ---------------------------------------------------------------------------
// Kind classification (NIP-01 §Kinds)
// ---------------------------------------------------------------------------

/** 10000–19999 and 0, 3: one event per (pubkey, kind); newer replaces older. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** 20000–29999: fanned out, never stored, never audited. Presence, typing. */
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/** 30000–39999: one event per (pubkey, kind, `d` tag). */
export function isParamReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** Everything else: kept forever, in order. Messages live here. */
export function isRegular(kind: number): boolean {
  return !isReplaceable(kind) && !isEphemeral(kind) && !isParamReplaceable(kind);
}

/**
 * The replacement key for an event, or null if it never replaces anything.
 *
 * Parameterized-replaceable events key on their `d` tag, and a missing `d` is
 * treated as the empty string rather than as "not replaceable" — otherwise an
 * author who omits `d` accumulates duplicates that the spec says are one event.
 */
export function replacementKey(event: UnsignedEvent): string | null {
  if (isReplaceable(event.kind)) return `${event.kind}:${event.pubkey}`;
  if (isParamReplaceable(event.kind)) {
    return `${event.kind}:${event.pubkey}:${tagValue(event, "d") ?? ""}`;
  }
  return null;
}

/**
 * Does `candidate` supersede `existing`? Later `created_at` wins; on a tie the
 * *lower* id wins.
 *
 * The tie-break looks arbitrary and is load-bearing: two relays handed the same
 * pair of same-second events must independently keep the same one, or the two
 * logs silently diverge and never reconcile. Timestamps collide constantly —
 * they are seconds, and a client that writes twice in one second is ordinary.
 */
export function supersedes(candidate: NostrEvent, existing: NostrEvent): boolean {
  if (candidate.created_at !== existing.created_at) {
    return candidate.created_at > existing.created_at;
  }
  return candidate.id < existing.id;
}

// ---------------------------------------------------------------------------
// Filters (NIP-01 REQ)
// ---------------------------------------------------------------------------

export type NostrFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /** Tag filters: `#e`, `#p`, `#h`, … Each is a set of acceptable values. */
  [tagFilter: `#${string}`]: string[] | undefined | number[] | number | string[];
};

/**
 * Does an event match a filter?
 *
 * The rule that surprises people: conditions AND together, values within one
 * condition OR together. `{kinds: [9], "#h": ["a", "b"]}` means "a message in a
 * or b", not "a message in a and in b". Getting this backwards produces a
 * subscription that silently returns nothing.
 */
export function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(wanted)) continue;
    const name = key.slice(1);
    const present = tagValues(event, name);
    if (!(wanted as string[]).some((v) => present.includes(v))) return false;
  }
  return true;
}
