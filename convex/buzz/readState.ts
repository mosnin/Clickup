// Read state: what you have already seen, and what is still waiting for you.
//
// This is the most intricate subsystem in the Chat spec (01-core-comms §4) and
// almost all of the intricacy comes from one sentence: **a read marker is
// monotonic.** It only ever moves forward. That single property is what makes
// read state safe to replicate — two devices can hand each other their markers
// in any order, any number of times, and the result is the same, because `max`
// is commutative, associative and idempotent. It is also what makes "mark
// unread" impossible to express as a marker, which is why §4.4 exists and why
// forced unread is a separate overlay rather than a smaller number.
//
// The shape, in one paragraph. A reader's state is a **blob** — `{v, client_id,
// contexts}` where `contexts` maps a context key (a channel id, `thread:<root>`
// or `msg:<id>`) to a unix second — published as a NIP-78 kind 30078 event with
// `["d","read-state:<slot>"]`. 30078 is parameterized-replaceable, so the log
// already knows how to keep exactly one of them per coordinate (06-protocol §6.2)
// and `publishCore` already implements the domination rule. What this file adds
// on top is the three things replacement alone does not give you: a **merge**
// (§4.3 — blobs are max-merged, never winner-takes-all, or the last device to
// speak silently erases what the others knew), a **byte budget** (§4.3 — a blob
// that outgrows 32 KB has to shed the right entries, and the eviction order is
// load-bearing), and a **hierarchical frontier** (§4.2 — a thread's marker is
// covered by its channel's).
//
// Three structural decisions, each of which is a deviation from Buzz that the
// substrate forces, recorded here rather than discovered later.
//
//   1. **The merge happens on the server, not on each device.** Buzz's clients
//      each hold the key, decrypt the blob and merge locally; ours all talk to
//      one Convex backend that holds the key (00-decisions D2/D3). So the blob
//      is merged in the mutation, and `buzzReadState` is a *projection* of the
//      published blobs — the same relationship `buzzChannels` has to the log.
//      Every write hydrates from the events first (`hydrate`), so the row is a
//      cache that can always be rebuilt and never a second source of truth.
//
//   2. **No 5 000 ms publish debounce.** Buzz debounces because publishing is a
//      network round trip from a client that is also handling keystrokes, and
//      because every superseded blob was a row its relay kept. Here the publish
//      is the same transaction that already updated the row, and the superseded
//      blob is *hard-deleted* (06-protocol §6.3 names read state as one of the
//      two hard-delete exceptions), so the log does not grow. A debounce would
//      buy nothing and would add a window in which two tabs disagree.
//
//   3. **The published blob is plaintext.** Buzz NIP-44-encrypts it to self.
//      That protects the reader from the *relay operator*, which is a party we
//      do not have — the server here holds every private key by construction, so
//      encrypting to self would protect nothing from it. What it *would* still
//      protect against is a fellow member of the same community reading it back
//      through `log.read`, because kind 30078 is registered `gate: "open"`. So
//      this is a real, narrow leak: another member of your workspace can learn
//      which rooms you have read and when. Closing it needs either a content
//      cipher (this repo ships `@noble/hashes` and `@noble/curves` but no AEAD,
//      and hand-rolling one is worse than the leak) or `gate: "author"` on 30078
//      in `_kinds.ts`, which is one line and is not this phase's file. Recorded
//      as a gap, not as a decision that it is fine.
//
// What this file deliberately does not write: a `thread:<root>` marker. The
// format carries them and every read path honours them — an imported blob from a
// Buzz client still resolves correctly — but §4.7 replaced the single thread
// frontier with one grow-only `msg:<id>` marker per reply, precisely so that
// reading an ancestor never covers a descendant. Re-introducing a writer for the
// thread frontier would hide replies in still-collapsed branches forever
// (§10.18), which is the bug that change was made to fix.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Actor } from "../_agentAuth";
import { requireScopeAccess } from "../_authz";
// The room's own visibility rule, which is `channels.ts`'s answer and there is
// exactly one of it. Note that this makes the two modules mutually importing:
// `channels.list` needs the unread numbers from here, and the mutations here
// need that access check. Both edges are plain hoisted `async function`s used
// only inside handlers, so neither module needs the other at evaluation time and
// the cycle is inert. It is preferable to the alternative, which is a second
// answer to "may this person see this room" living in this file and drifting
// from the first the day either changes.
import { requireChannelAccess } from "./channels";
import { pubkeyFor } from "./identity";
import { publishCore, type Scope } from "./log";

// ---------------------------------------------------------------------------
// §4.1 The blob
// ---------------------------------------------------------------------------

/** Context key → unix **seconds**. Nostr speaks seconds; so does this. */
export type ReadContexts = Record<string, number>;

/** The published payload. `v` is 1 and a blob that says otherwise is not ours. */
export type ReadStateBlob = { v: 1; client_id: string; contexts: ReadContexts };

/** NIP-78 application data. Parameterized-replaceable, keyed by its `d` tag. */
export const KIND_READ_STATE = 30078;

/** The `d` tag prefix. `read-state:<32 hex>` — §6.3's recogniser is this exact shape. */
export const READ_STATE_D_PREFIX = "read-state:";
/** The `t` tag every read-state event carries, so a filter can find them all. */
export const READ_STATE_T_TAG = "read-state";

/** How many blobs one fetch pulls back. Buzz's constant, kept for parity. */
export const READ_STATE_FETCH_LIMIT = 500;
/** Seven days. `msg:`/`thread:` markers older than this are prunable. */
export const READ_STATE_HORIZON_SECONDS = 7 * 24 * 60 * 60;
/** The hard cap on keys in one blob. Validation refuses anything larger. */
export const MAX_CONTEXTS = 10_000;
/** How many `msg:`/`thread:` markers survive a prune, newest first. */
export const LOCAL_MAX_PRUNABLE_CONTEXTS = 1_000;
/**
 * 32 KB of plaintext per slot.
 *
 * NIP-44 caps plaintext at 65 535 and Buzz's relay at 256 KB; 32 KB leaves room
 * for ~1.4× ciphertext expansion. We publish plaintext today (see the header),
 * and the number is kept anyway — the budget is what forces the eviction order
 * and the multi-slot path to be exercised at all, and a budget that only bites
 * at 256 KB is a budget nobody's data ever meets and nobody's code is right for.
 */
export const READ_STATE_MAX_PLAINTEXT_BYTES = 32_768;
/** Eight slots × ~650 channel keys ≈ 5 200 channels. Past that, publish is refused. */
export const READ_STATE_MAX_SLOTS = 8;
/** A context key longer than this is dropped by `sanitizeContexts`. UTF-8 bytes. */
export const MAX_CONTEXT_KEY_BYTES = 256;
/** Markers outside `[0, 2^32-1]` are not seconds; they are a bug or an attack. */
export const MAX_MARKER_SECONDS = 4_294_967_295;

/**
 * How many events one channel's unread scan will look at.
 *
 * The rail shows a dot and a small number; nobody acts on the difference
 * between 143 and 144 unread. Capping is what keeps §4.5 an index *range* —
 * bounded, and bounded by what is displayable — rather than a read whose cost
 * grows with how long you were away.
 */
export const UNREAD_COUNT_CAP = 99;

// ---------------------------------------------------------------------------
// Context keys (§4.1)
// ---------------------------------------------------------------------------

export type ContextKind = "channel" | "thread" | "message";

const THREAD_PREFIX = "thread:";
const MESSAGE_PREFIX = "msg:";

/** A channel's own context key is its bare id. */
export function channelContextKey(channelId: string): string {
  return channelId;
}
export function threadContextKey(rootId: string): string {
  return `${THREAD_PREFIX}${rootId}`;
}
export function messageContextKey(messageId: string): string {
  return `${MESSAGE_PREFIX}${messageId}`;
}

/**
 * Which of the three a key is.
 *
 * The classification is what the byte budget and the pruner are built on —
 * channel keys are never evicted and never pruned, because losing one
 * resurrects that channel's badge (§10.22) — so it is a named function rather
 * than a `startsWith` at four call sites.
 */
export function classifyContextKey(key: string): ContextKind {
  if (key.startsWith(MESSAGE_PREFIX)) return "message";
  if (key.startsWith(THREAD_PREFIX)) return "thread";
  return "channel";
}

const HEX_64 = /^[0-9a-f]{64}$/;
const SLOT_ID = /^[\x21-\x7e]{1,64}$/;

/** `read-state:<slot>` with a 1–64-char printable-ASCII slot id (§4.1). */
export function isValidReadStateDTag(dTag: string): boolean {
  if (!dTag.startsWith(READ_STATE_D_PREFIX)) return false;
  return SLOT_ID.test(dTag.slice(READ_STATE_D_PREFIX.length));
}

export function readStateDTag(slotId: string): string {
  return `${READ_STATE_D_PREFIX}${slotId}`;
}

// ---------------------------------------------------------------------------
// Validation (§4.1)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this a read-state blob at all?
 *
 * Shape only — the contexts are *sanitized* separately, because the two answer
 * different questions. "Is this a blob" decides whether to look at it; "which of
 * its entries are usable" decides what to keep. Conflating them would make one
 * bad entry discard a whole device's state.
 */
export function isValidBlob(value: unknown): value is ReadStateBlob {
  if (!isPlainObject(value)) return false;
  if (value.v !== 1) return false;
  const clientId = value.client_id;
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 64) return false;
  if (!isPlainObject(value.contexts)) return false;
  return Object.keys(value.contexts).length <= MAX_CONTEXTS;
}

/**
 * The entries of a blob we are willing to keep.
 *
 * Buzz drops keys over 256 **bytes** (not characters — a key is UTF-8 on the
 * wire and a character budget would let a multibyte key through), non-integer
 * values, and values outside `[0, 2^32-1]`.
 *
 * One rule is ours and not the protocol's: keys beginning `$` or `_` are
 * dropped, because Convex reserves those and a record holding one cannot be
 * written. Sanitizing it away here is the difference between an imported blob
 * with a hostile key being *ignored* and it throwing inside somebody's
 * mark-as-read.
 */
export function sanitizeContexts(raw: unknown): ReadContexts {
  const out: ReadContexts = {};
  if (!isPlainObject(raw)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_CONTEXTS) break;
    if (key.length === 0) continue;
    if (key.startsWith("$") || key.startsWith("_")) continue;
    if (utf8Bytes(key) > MAX_CONTEXT_KEY_BYTES) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value > MAX_MARKER_SECONDS) continue;
    out[key] = value;
    kept += 1;
  }
  return out;
}

export type ParsedReadStateEvent = { slotId: string; blob: ReadStateBlob };

/**
 * A stored 30078 event, read back as one of *our own* blobs — or nothing.
 *
 * Three requirements beyond "it parses", each of which refuses a different way
 * of being confused about whose state this is: **exactly one** `d` tag (two
 * would mean two coordinates and the log picked one), **exactly one**
 * `["t","read-state"]` (so somebody else's app data at a colliding `d` is not
 * read as read state), and `pubkey === self` (a blob signed by anybody else is
 * not yours however it is tagged).
 */
export function parseReadStateEvent(
  event: { pubkey: string; tags: readonly string[][]; content: string },
  selfPubkey: string,
): ParsedReadStateEvent | null {
  if (event.pubkey !== selfPubkey) return null;
  const dTags = event.tags.filter((tag: readonly string[]) => tag[0] === "d");
  if (dTags.length !== 1) return null;
  const dTag = dTags[0][1] ?? "";
  if (!isValidReadStateDTag(dTag)) return null;
  const tTags = event.tags.filter(
    (tag: readonly string[]) => tag[0] === "t" && tag[1] === READ_STATE_T_TAG,
  );
  if (tTags.length !== 1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!isValidBlob(parsed)) return null;
  return {
    slotId: dTag.slice(READ_STATE_D_PREFIX.length),
    blob: { v: 1, client_id: parsed.client_id, contexts: sanitizeContexts(parsed.contexts) },
  };
}

// ---------------------------------------------------------------------------
// §4.2 The hierarchical frontier
// ---------------------------------------------------------------------------

/**
 * The largest non-null marker in a list. Buzz's `maxReadAt`.
 *
 * `null` means "never read", which is *not* zero: a channel read at the epoch
 * and a channel never read differ in whether a message from 1970 is unread, and
 * more importantly in whether the divider has a place to sit.
 */
export function maxReadAt(...markers: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    if (marker === null || marker === undefined) continue;
    best = best === null ? marker : Math.max(best, marker);
  }
  return best;
}

/**
 * `effective(ctx) = max(own(ctx), effective(parent(ctx)))` — §4.2.
 *
 * The thread→channel relationship is **not serialised into the blob**; it is
 * derived at evaluation time from an injected resolver, because a thread's root
 * lives in the event graph and a blob that carried it would be a second copy of
 * the graph that goes stale.
 *
 * Two properties the loop guarantees. It **only reads upward**, so a parent's
 * marker can cover a child but never the reverse — which is what "hierarchical"
 * means and why marking a channel read covers its threads. And it is
 * **cycle-guarded**: the resolver is supplied by a caller (in Buzz, by whichever
 * screen is mounted), and a resolver that ever answers in a circle must return a
 * frontier rather than hang the tab.
 */
export function resolveEffectiveTimestamp(
  contexts: Readonly<ReadContexts>,
  key: string,
  parentOf: (key: string) => string | null,
): number | null {
  let best: number | null = null;
  let current: string | null = key;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const own = contexts[current];
    if (own !== undefined) best = best === null ? own : Math.max(best, own);
    current = parentOf(current);
  }
  return best;
}

/** Channels have no parent, so effective and own coincide for them. */
export const NO_PARENT = (): null => null;

// ---------------------------------------------------------------------------
// §4.3 Merge
// ---------------------------------------------------------------------------

export type MergeResult = { contexts: ReadContexts; advanced: string[] };

/**
 * Max-merge, **never winner-takes-all** (§4.3, §10.20).
 *
 * The whole-blob-wins alternative looks equivalent when one device is writing
 * and is catastrophic when two are: the device that publishes second erases
 * every context the first knew about and the other's rail lights up again. Max
 * per key is the only merge that is order-independent, which is the property
 * that makes "any number of devices, any delivery order" safe.
 *
 * `advanced` is the keys this merge actually moved forward. It is what lets a
 * cross-device read clear a forced-unread dot here (§4.5's `drainSyncedAdvances`)
 * — an "unchanged" key must not clear anything, or re-receiving your own blob
 * would silently undo a deliberate mark-unread.
 */
export function mergeContexts(
  base: Readonly<ReadContexts>,
  incoming: Readonly<ReadContexts>,
): MergeResult {
  const contexts: ReadContexts = { ...base };
  const advanced: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const current = contexts[key];
    if (current === undefined || value > current) {
      contexts[key] = value;
      advanced.push(key);
    }
  }
  return { contexts, advanced };
}

/**
 * Advance one context. **Monotonic**: `ts <= current` never lowers the value.
 *
 * This is the invariant every other rule in this file is built on top of, and
 * it is enforced here rather than at the call sites so that there is no write
 * path — mark-read, mark-all, an imported blob, a merge — that can rewind a
 * marker. Marking something *unread* therefore cannot be a smaller number; see
 * `markChannelUnread`.
 */
export function advanceContext(
  contexts: Readonly<ReadContexts>,
  key: string,
  seconds: number,
): MergeResult {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_MARKER_SECONDS) {
    return { contexts: { ...contexts }, advanced: [] };
  }
  const current = contexts[key];
  if (current !== undefined && seconds <= current) {
    return { contexts: { ...contexts }, advanced: [] };
  }
  return { contexts: { ...contexts, [key]: seconds }, advanced: [key] };
}

// ---------------------------------------------------------------------------
// §4.3 The byte budget
// ---------------------------------------------------------------------------

/** The blob, exactly as it goes on the wire. */
export function serializeBlob(blob: ReadStateBlob): string {
  return JSON.stringify(blob);
}

export function blobBytes(blob: ReadStateBlob): number {
  return utf8Bytes(serializeBlob(blob));
}

/**
 * The byte cost of one `"key":value` pair inside the contexts object.
 *
 * Computed rather than measured-by-re-serialising because eviction is a loop:
 * re-running `JSON.stringify` over ten thousand entries per dropped key is
 * quadratic, and the blob it is measuring is the thing being trimmed *because*
 * it is large. `tests/buzz-read-state.test.ts` pins this estimate against a real
 * `JSON.stringify` — an estimate that can drift from the serializer is an
 * estimate that eventually publishes a blob one byte over the cap.
 */
function entryBytes(key: string, value: number): number {
  return utf8Bytes(JSON.stringify(key)) + 1 + String(value).length;
}

function emptyBlobBytes(clientId: string): number {
  return blobBytes({ v: 1, client_id: clientId, contexts: {} });
}

/** The serialized size of a contexts map inside a blob, without serialising it. */
export function estimateBlobBytes(clientId: string, contexts: Readonly<ReadContexts>): number {
  const entries = Object.entries(contexts);
  let total = emptyBlobBytes(clientId);
  for (const [key, value] of entries) total += entryBytes(key, value);
  // One comma between every pair of entries.
  if (entries.length > 1) total += entries.length - 1;
  return total;
}

/**
 * Fit a contexts map inside one slot, or say it cannot be done.
 *
 * The eviction order is the rule (§4.3, §10.22): **oldest `msg:` first, then
 * oldest `thread:`, and channel keys are never evicted.** The reason channel
 * keys are exempt is not that they are small — it is that dropping one
 * resurrects that channel's badge, which is a visible, wrong, unexplainable
 * unread on a room the reader has read. A dropped `msg:` marker costs at worst
 * one already-read reply looking new inside a thread nobody has open.
 *
 * `null` means even channel-keys-only does not fit, which is the caller's signal
 * to switch to the multi-slot path rather than to publish a truncated blob.
 */
export function trimContextsToBudget(
  contexts: Readonly<ReadContexts>,
  clientId: string,
  maxBytes: number = READ_STATE_MAX_PLAINTEXT_BYTES,
): ReadContexts | null {
  const kept: ReadContexts = {};
  const messages: [string, number][] = [];
  const threads: [string, number][] = [];

  for (const [key, value] of Object.entries(contexts)) {
    const kind = classifyContextKey(key);
    if (kind === "channel") kept[key] = value;
    else if (kind === "message") messages.push([key, value]);
    else threads.push([key, value]);
  }

  // Oldest first, and tie-broken on the key so two runs over the same data
  // evict the same entries. A mutation that shed a different marker depending
  // on object iteration order would publish a different blob for the same
  // input, which makes `isIdenticalToLastPublished` useless.
  const byAge = (a: [string, number], b: [string, number]): number =>
    a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  messages.sort(byAge);
  threads.sort(byAge);

  let total = emptyBlobBytes(clientId);
  let count = 0;
  const cost = (entry: [string, number]): number =>
    entryBytes(entry[0], entry[1]) + (count > 0 ? 1 : 0);

  // Channel keys go in **unconditionally**, and their cost is counted even when
  // it blows the budget — that overflow is the whole signal. Skipping them the
  // way a prunable entry is skipped would silently return a map that is over
  // the cap while claiming to be under it, and the caller would publish it.
  for (const entry of Object.entries(kept)) {
    total += cost(entry);
    count += 1;
  }
  if (total > maxBytes) return null;

  // Newest survive, so walk from the back and stop when the budget is spent.
  // Threads are offered the remaining room before messages, which is the same
  // rule as "evict oldest `msg:` first" read from the other end.
  const survivors: [string, number][] = [];
  const tryAdd = (entry: [string, number]): boolean => {
    const price = cost(entry);
    if (total + price > maxBytes) return false;
    total += price;
    count += 1;
    survivors.push(entry);
    return true;
  };
  for (const entry of [...threads].reverse()) if (!tryAdd(entry)) break;
  for (const entry of [...messages].reverse()) if (!tryAdd(entry)) break;

  const out: ReadContexts = { ...kept };
  for (const [key, value] of survivors) out[key] = value;
  return out;
}

/**
 * Spread a contexts map across as few slots as it fits in, or `null`.
 *
 * Channel keys go **round-robin** across the slots, which keeps every slot the
 * same size as keys are added and removed; `thread:`/`msg:` entries all go into
 * the **primary** slot and are trimmed there, so a reader with an enormous
 * thread history never turns that history into extra slots that other clients
 * have to fetch.
 *
 * Deterministic by construction — the entries are sorted by key before they are
 * dealt — because a mutation has no randomness to hide behind and because two
 * runs that dealt the same data differently would republish every slot on every
 * write.
 */
export function splitContextsIntoBudgetedSlots(
  contexts: Readonly<ReadContexts>,
  clientId: string,
  maxBytes: number = READ_STATE_MAX_PLAINTEXT_BYTES,
  maxSlots: number = READ_STATE_MAX_SLOTS,
): ReadContexts[] | null {
  const channels: [string, number][] = [];
  const rest: ReadContexts = {};
  for (const [key, value] of Object.entries(contexts)) {
    if (classifyContextKey(key) === "channel") channels.push([key, value]);
    else rest[key] = value;
  }
  channels.sort((a: [string, number], b: [string, number]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );

  for (let slots = 1; slots <= maxSlots; slots += 1) {
    const buckets: ReadContexts[] = Array.from({ length: slots }, () => ({}));
    channels.forEach(([key, value]: [string, number], index: number) => {
      buckets[index % slots][key] = value;
    });
    const primary = trimContextsToBudget({ ...buckets[0], ...rest }, clientId, maxBytes);
    if (primary === null) continue;
    buckets[0] = primary;
    if (buckets.every((bucket: ReadContexts) => estimateBlobBytes(clientId, bucket) <= maxBytes)) {
      return buckets;
    }
  }
  return null;
}

/**
 * Drop stale prunable markers, then cap what survives.
 *
 * `msg:` and `thread:` markers older than the seven-day horizon are dropped,
 * and the newest 1 000 of the survivors are kept. **Channel keys are never
 * pruned** — they are small, bounded by how many rooms you are in, and losing
 * one resurrects that channel's badge.
 */
export function pruneStaleContexts(
  contexts: Readonly<ReadContexts>,
  now: number,
  horizonSeconds: number = READ_STATE_HORIZON_SECONDS,
  maxPrunable: number = LOCAL_MAX_PRUNABLE_CONTEXTS,
): ReadContexts {
  const cutoff = now - horizonSeconds;
  const out: ReadContexts = {};
  const prunable: [string, number][] = [];
  for (const [key, value] of Object.entries(contexts)) {
    if (classifyContextKey(key) === "channel") {
      out[key] = value;
      continue;
    }
    if (value < cutoff) continue;
    prunable.push([key, value]);
  }
  prunable.sort(
    (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  for (const [key, value] of prunable.slice(0, maxPrunable)) out[key] = value;
  return out;
}

/** A publish that would say exactly what the last one said is not made (§4.3). */
export function isIdenticalToLastPublished(
  next: Readonly<ReadContexts>,
  published: Readonly<ReadContexts>,
): boolean {
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== Object.keys(published).length) return false;
  for (const key of nextKeys) if (published[key] !== next[key]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// §4.4 Forced unread
// ---------------------------------------------------------------------------

/**
 * Is a forced-unread mark still in force?
 *
 * The stored value is the channel's **own marker at the moment mark-unread was
 * invoked** (`null` if there was none). The gate compares it against the marker
 * *now*: if a genuine read has advanced past the baseline — on this device or
 * another — that read wins and the dot goes out. Without the gate, marking a
 * channel unread on your laptop would keep it lit forever, including after you
 * read it on your phone, and the only way to clear it would be to mark it read
 * again on the device that marked it unread.
 *
 * Note what this is *not*: it is not a smaller marker. Markers are monotonic, so
 * a retrograde read position cannot be expressed in one at all — and it must
 * not be, because a rewind would be permanent and would apply everywhere.
 */
export function forcedUnreadStillLit(
  baseline: number | null,
  marker: number | null,
): boolean {
  if (marker === null) return true;
  if (baseline === null) return false;
  return marker <= baseline;
}

// ---------------------------------------------------------------------------
// §4.5 Marking, and what an event's read position actually is
// ---------------------------------------------------------------------------

/**
 * Buzz's `resolveChannelReadMarker`.
 *
 * `markAt` is the later of what the caller asked for and what we have observed
 * in the room; `|| null` is deliberate — a mark at second zero is not a mark.
 *
 * `clearObserved` says whether the marker actually covers the newest thing we
 * know about. It matters because of §10.11: without clearing, `latest > readAt`
 * evaluates `T > T` (false) but the channel lingers in the unread set, because
 * the monotonic guard suppressed the version bump that would have recomputed it.
 */
export function resolveChannelReadMarker(
  callerReadAt: number | null | undefined,
  observedLatest: number | null | undefined,
): { markAt: number | null; clearObserved: boolean } {
  const caller =
    typeof callerReadAt === "number" && Number.isFinite(callerReadAt)
      ? Math.floor(callerReadAt)
      : 0;
  const observed =
    typeof observedLatest === "number" && Number.isFinite(observedLatest)
      ? Math.floor(observedLatest)
      : 0;
  const markAt = Math.max(caller, observed) || null;
  const clearObserved =
    markAt !== null &&
    observedLatest !== undefined &&
    observedLatest !== null &&
    Math.floor(observedLatest) <= markAt;
  return { markAt, clearObserved };
}

/**
 * The kinds that may make a channel unread (§0.2, §10.1).
 *
 * Reactions, edits, deletions and system rows are excluded and the reason is
 * sharper than tidiness: they land *after* the last human-visible message, so
 * counting them creates an unread badge on a room where nobody said anything —
 * a phantom the reader cannot clear by reading, because there is nothing new to
 * read. §10.3 is the same bug seen from the other end: a freshly created channel
 * would otherwise open with "4 unread, 1 message".
 *
 * An **`undefined`** kind counts as conversational (§10.2). An optimistic row
 * has no kind yet, and failing closed there would drop a legitimately unread
 * message.
 */
export const CONVERSATIONAL_UNREAD_KINDS: ReadonlySet<number> = new Set([
  9, // KIND_STREAM_MESSAGE
  40002, // KIND_STREAM_MESSAGE_V2
  40008, // KIND_STREAM_MESSAGE_DIFF — a content kind, not aux (§10.5)
]);

export function isConversationalUnreadKind(kind: number | undefined): boolean {
  return kind === undefined || CONVERSATIONAL_UNREAD_KINDS.has(kind);
}

/**
 * The thread root an unread event should be resolved against, or `null`.
 *
 * Restated rather than imported from `messages.ts`, which would close a
 * three-module import cycle for eleven lines of tag reading; the drift is pinned
 * by a test that runs both over the same tags. A **broadcast** reply reads as
 * top-level, so it must not inherit its thread's marker — otherwise marking a
 * thread read would silently absorb a message the room was shown.
 */
export function resolveObservedUnreadRootId(tags: readonly string[][]): string | null {
  if (tags.some((tag: readonly string[]) => tag[0] === "broadcast" && tag[1] === "1")) return null;
  const eTags = tags.filter((tag: readonly string[]) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return null;
  const replyTags = eTags.filter((tag: readonly string[]) => tag[3] === "reply");
  const replyTag = replyTags[replyTags.length - 1];
  if (!replyTag) return null;
  const rootTag = eTags.find((tag: readonly string[]) => tag[3] === "root");
  return rootTag?.[1] ?? replyTag[1];
}

/**
 * When was this particular event read? (§4.5)
 *
 * The max of three markers, and the mix of *effective* and *own* is the trap
 * §4.2 warns about: the **channel** term folds the hierarchy (so marking a
 * channel read covers everything in it), while the thread and message terms are
 * the reader's own markers only (so evaluating a background channel's thread
 * cannot borrow the active channel's marker through a parent resolver).
 */
export function observedUnreadEventReadAt(
  channelReadAt: number | null,
  contexts: Readonly<ReadContexts>,
  eventId: string,
  rootId: string | null,
): number | null {
  return maxReadAt(
    channelReadAt,
    contexts[messageContextKey(eventId)] ?? null,
    rootId === null ? null : (contexts[threadContextKey(rootId)] ?? null),
  );
}

/** A message at **exactly** the frontier is read. Strictly greater, everywhere (§10.13). */
export function isEventUnread(createdAt: number, readAt: number | null): boolean {
  return readAt === null || createdAt > readAt;
}

// ---------------------------------------------------------------------------
// The projection row
// ---------------------------------------------------------------------------

type ReadStateRow = Doc<"buzzReadState">;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/**
 * A stable per-(community, reader) client id and slot id.
 *
 * Buzz generates both at random and keeps them in localStorage. A Convex
 * mutation has no CSPRNG, and there is no client-side store to keep them in
 * anyway — so they are *derived*, which is better than it sounds: the same
 * reader in the same community always writes at the same coordinate, so a
 * republish replaces rather than accumulates, and there is nothing to lose.
 *
 * The rotation counter is what makes slot squatting recoverable: if a blob at
 * our `d` tag ever carries somebody else's `client_id`, we move to a fresh
 * coordinate rather than clobber theirs.
 */
function derivedId(parts: readonly string[]): string {
  return bytesToHex(sha256(utf8ToBytes(parts.join("\u0000")))).slice(0, 32);
}

function clientIdFor(scope: Scope, pubkey: string): string {
  return derivedId(["buzz-read-state-client", scope.scopeType, scope.scopeId, pubkey]);
}

function slotIdFor(scope: Scope, pubkey: string, rotation: number, index: number): string {
  return derivedId([
    "buzz-read-state-slot",
    scope.scopeType,
    scope.scopeId,
    pubkey,
    String(rotation),
    String(index),
  ]);
}

async function readStateRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  pubkey: string,
): Promise<ReadStateRow | null> {
  return await ctx.db
    .query("buzzReadState")
    .withIndex("by_scope_pubkey", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("pubkey", pubkey),
    )
    .unique();
}

type Working = {
  row: ReadStateRow | null;
  contexts: ReadContexts;
  forcedUnread: Record<string, number | null>;
  clientId: string;
  rotation: number;
  publishedSlots: { slotId: string; eventId: string }[];
  publishedContexts: ReadContexts;
  publishedAt: number;
};

/**
 * Load the reader's state, **rebuilding it from the log first**.
 *
 * The row is a projection, so every write starts by re-reading the events it was
 * projected from and max-merging them back in. Three things fall out of that:
 * the row can always be rebuilt from the log after any incident; a blob written
 * by another build (or imported from a device) is picked up without a migration;
 * and multi-slot state is reassembled by the same merge that handles everything
 * else, rather than by a second code path that only runs above 5 000 channels
 * and is therefore never right.
 *
 * The read is bounded by the slots we recorded — at most eight point lookups —
 * and not by "everything this author ever wrote", which for a chat user is their
 * whole message history.
 */
async function hydrate(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  pubkey: string,
): Promise<Working> {
  const row = await readStateRow(ctx, scope, pubkey);
  const clientId = row?.clientId ?? clientIdFor(scope, pubkey);
  let rotation = row?.rotation ?? 0;
  let contexts: ReadContexts = sanitizeContexts(row?.contexts ?? {});

  for (const slot of row?.publishedSlots ?? []) {
    const event = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("eventId", slot.eventId),
      )
      .first();
    if (!event || event.deletedAt !== undefined) continue;
    const parsed = parseReadStateEvent(event, pubkey);
    if (!parsed) continue;
    // Slot squatting (§4.3, §10.19): a blob at our coordinate carrying a
    // different client_id belongs to somebody else's client. Rotate to a fresh
    // slot rather than replace theirs — two clients sharing one coordinate is
    // how both lose state, repeatedly, and neither can tell why.
    if (parsed.blob.client_id !== clientId) {
      rotation += 1;
      continue;
    }
    contexts = mergeContexts(contexts, parsed.blob.contexts).contexts;
  }

  return {
    row,
    contexts,
    forcedUnread: { ...(row?.forcedUnread ?? {}) },
    clientId,
    rotation,
    publishedSlots: [...(row?.publishedSlots ?? [])],
    publishedContexts: sanitizeContexts(row?.publishedContexts ?? {}),
    publishedAt: row?.publishedAt ?? 0,
  };
}

/** The acting principal, in the shape every write path in this app takes. */
async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

/**
 * Physically remove a superseded read-state blob and its tag rows.
 *
 * 06-protocol §6.3 names NIP-RS read state as one of exactly two coordinates
 * whose superseded payload is **hard-deleted** rather than soft-deleted, and the
 * reason is the one that applies to every heartbeat-shaped record: nothing is
 * ever asked of an old read position, so keeping one is a row per mark-as-read,
 * forever, in an append-only table. The ordering guarantee that a soft-deleted
 * head would have provided is kept instead as a **watermark** on the projection
 * row (`publishedAt`), which is what `nextPublishSecond` consults.
 */
async function deleteSlotEvent(
  ctx: MutationCtx,
  scope: Scope,
  eventId: string,
): Promise<void> {
  const event = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", eventId),
    )
    .first();
  if (!event) return;
  const tagRows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  for (const tagRow of tagRows) await ctx.db.delete(tagRow._id);
  await ctx.db.delete(event._id);
}

/**
 * The `created_at` a fresh blob must carry: `max(now, watermark + 1)` (§10.21).
 *
 * Always strictly past everything we have published, so the new blob supersedes
 * whatever a replica still holds even when two servers' clocks disagree — clock
 * skew otherwise loses writes silently, which for read state means a marker
 * quietly rewinding.
 *
 * `null` when even that would exceed the log's ±15-minute drift window. That can
 * only happen after nine hundred publishes inside one second, which Convex's
 * serialized transactions make impossible; returning `null` rather than throwing
 * keeps a mark-as-read working (the projection row is still updated) in the case
 * nobody has thought of.
 */
const MAX_TIMESTAMP_DRIFT_SECS = 900;

function nextPublishSecond(nowSeconds: number, watermark: number): number | null {
  const candidate = Math.max(nowSeconds, watermark + 1);
  return candidate > nowSeconds + MAX_TIMESTAMP_DRIFT_SECS ? null : candidate;
}

/**
 * Write the reader's state: the row, and the blobs that explain it.
 *
 * Same contract `channels.ts` holds itself to — nothing patches a projection
 * without publishing the events behind it, in the same transaction. The one
 * exception is a state whose *contexts* did not change (a forced-unread mark, a
 * re-mark of something already read): there is nothing new to say, so nothing is
 * published, which is `isIdenticalToLastPublished` doing its job (§4.3).
 */
async function persist(
  ctx: MutationCtx,
  scope: Scope,
  actor: Actor,
  pubkey: string,
  working: Working,
): Promise<void> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const pruned = pruneStaleContexts(working.contexts, nowSeconds);

  let publishedSlots = working.publishedSlots;
  let publishedContexts = working.publishedContexts;
  let publishedAt = working.publishedAt;

  if (!isIdenticalToLastPublished(pruned, working.publishedContexts)) {
    const single = trimContextsToBudget(pruned, working.clientId);
    const slots =
      single !== null
        ? [single]
        : splitContextsIntoBudgetedSlots(pruned, working.clientId);
    const createdAt = nextPublishSecond(nowSeconds, working.publishedAt);

    // A state too large for eight slots is a state we refuse to publish rather
    // than publish wrongly: a truncated blob would look authoritative to every
    // reader of the log and would quietly drop channel markers, which is the one
    // eviction the budget exists to prevent.
    if (slots !== null && createdAt !== null) {
      for (const slot of working.publishedSlots) {
        await deleteSlotEvent(ctx, scope, slot.eventId);
      }

      const written: { slotId: string; eventId: string }[] = [];
      for (let index = 0; index < slots.length; index += 1) {
        const slotId = slotIdFor(scope, pubkey, working.rotation, index);
        const blob: ReadStateBlob = {
          v: 1,
          client_id: working.clientId,
          contexts: slots[index],
        };
        const outcome = await publishCore(ctx, {
          actor,
          scope,
          kind: KIND_READ_STATE,
          tags: [
            ["d", readStateDTag(slotId)],
            ["t", READ_STATE_T_TAG],
          ],
          content: serializeBlob(blob),
          // Set deliberately, and this is one of the few callers that may:
          // replacement is decided by `created_at`, so a blob has to be able to
          // say it is newer than the one it replaces even when the wall clock
          // has not moved (§10.21).
          createdAt,
        });
        if (outcome.status === "dominated" || outcome.status === "ephemeral") {
          throw new ConvexError(
            `The chat log refused a read-state blob (${outcome.status}); nothing was written.`,
          );
        }
        written.push({ slotId, eventId: outcome.event.id });
      }

      publishedSlots = written;
      publishedContexts = slots.reduce<ReadContexts>(
        (all: ReadContexts, slot: ReadContexts) => ({ ...all, ...slot }),
        {},
      );
      publishedAt = createdAt;
    }
  }

  const patch = {
    contexts: pruned,
    forcedUnread: working.forcedUnread,
    clientId: working.clientId,
    rotation: working.rotation,
    publishedSlots,
    publishedContexts,
    publishedAt,
    updatedAt: now,
  };

  if (working.row) await ctx.db.patch(working.row._id, patch);
  else await ctx.db.insert("buzzReadState", { ...scope, pubkey, ...patch });
}

/**
 * The reader's Chat identity, or a refusal.
 *
 * Read state is keyed by the pubkey the reader's events are signed with, not by
 * their Clerk subject, because that is the identity the log speaks and the one a
 * blob is addressed to. A principal who has not been through the mint bootstrap
 * has no read state to have, and saying so is better than writing a row under a
 * key that will not exist tomorrow.
 */
async function requireReaderPubkey(
  ctx: QueryCtx | MutationCtx,
  principalType: "user" | "agent",
  principalId: string,
): Promise<string> {
  const pubkey = await pubkeyFor(ctx, principalType, principalId);
  if (!pubkey) {
    throw new ConvexError(
      principalType === "agent"
        ? "This agent has no Chat signing identity yet; read state is keyed by it. A human mints one when the agent is attached to a room."
        : "You have no Chat signing identity yet; read state is keyed by it. Open Chat once to mint one.",
    );
  }
  return pubkey;
}

// ---------------------------------------------------------------------------
// §4.9 The mark-as-read triggers
// ---------------------------------------------------------------------------

/**
 * Opening a channel, Escape, and the sidebar's "Mark as read" — one mutation,
 * three callers, one flag between them.
 *
 * `topLevelOnly` is the **passive channel-open** path and the flag matters
 * (§10.12): the caller's `readAt` is already the newest *top-level* message, so
 * the marker lands exactly there and the room's observed latest — which counts
 * thread replies — is **not** folded in. Without it, glancing at a channel
 * silently absorbs an unread reply in a thread you never opened, and the only
 * evidence is a badge that was there a second ago.
 *
 * Any mark-read clears the channel's forced-unread mark first: you cannot have
 * deliberately marked something unread and then read it and still mean it.
 */
export const markChannelRead = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    /** Unix **seconds**. Absent means "as far as the room has got". */
    readAt: v.optional(v.number()),
    topLevelOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ markedAt: number | null }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    // §4.9 marks a channel read for **members** only. A quiet no-op rather than
    // a refusal: an open room you have not joined is readable, and turning a
    // glance at one into an error would be a bug report about nothing.
    if (!membership) return { markedAt: null };

    return await markChannelReadCore(
      ctx,
      scope,
      channel,
      { actor: await userActor(ctx, subject), actorType: "user", actorId: subject },
      args,
    );
  },
});

/**
 * Moving a reader's marker in one room, for anybody.
 *
 * An agent has read state for the same reason a person does: without it,
 * "catch up on what I missed" means re-reading a room from the top on every
 * wake, and the unread numbers the rail draws for an agent would never fall.
 * It is keyed by the pubkey its events are signed with, exactly as a person's
 * is — there is no second store and no second shape, so an agent's marker is
 * rebuilt from the log by the same `hydrate` after an incident.
 *
 * The membership check belongs to the caller: this is reached from a surface
 * that has already resolved the room, and the two callers answer a non-member
 * differently on purpose (a person glancing at an open room is a quiet no-op).
 */
export async function markChannelReadCore(
  ctx: MutationCtx,
  scope: Scope,
  channel: Doc<"buzzChannels">,
  principal: { actor: Actor; actorType: "user" | "agent"; actorId: string },
  input: { readAt?: number; topLevelOnly?: boolean },
): Promise<{ markedAt: number | null }> {
  const pubkey = await requireReaderPubkey(ctx, principal.actorType, principal.actorId);
  const observedLatest = Math.floor(channel.lastActivityAt / 1000);
  const { markAt } = resolveChannelReadMarker(
    input.readAt,
    input.topLevelOnly === true ? undefined : observedLatest,
  );

  const working = await hydrate(ctx, scope, pubkey);
  delete working.forcedUnread[channel.channelId];
  if (markAt !== null) {
    working.contexts = advanceContext(
      working.contexts,
      channelContextKey(channel.channelId),
      markAt,
    ).contexts;
  }
  await persist(ctx, scope, principal.actor, pubkey, working);
  return { markedAt: markAt };
}

/**
 * Shift+Escape: everything in this community, read.
 *
 * One hydrate and one publish for the whole sweep rather than one per channel —
 * a blob per room would be N events for a single gesture, and the intermediate
 * blobs describe a state the reader was never in.
 */
export const markAllChannelsRead = mutation({
  args: scopeArgs,
  handler: async (ctx, args): Promise<{ channels: number }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const pubkey = await requireReaderPubkey(ctx, "user", subject);

    const memberships = await ctx.db
      .query("buzzMemberships")
      .withIndex("by_actor", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("actorId", subject)
          .eq("removedAt", undefined),
      )
      .collect();

    const working = await hydrate(ctx, scope, pubkey);
    let marked = 0;
    for (const membership of memberships) {
      const channel = await ctx.db
        .query("buzzChannels")
        .withIndex("by_scope_channel", (q) =>
          q
            .eq("scopeType", scope.scopeType)
            .eq("scopeId", scope.scopeId)
            .eq("channelId", membership.channelId),
        )
        .unique();
      if (!channel) continue;
      delete working.forcedUnread[channel.channelId];
      const { markAt } = resolveChannelReadMarker(
        undefined,
        Math.floor(channel.lastActivityAt / 1000),
      );
      if (markAt === null) continue;
      const advanced = advanceContext(
        working.contexts,
        channelContextKey(channel.channelId),
        markAt,
      );
      working.contexts = advanced.contexts;
      marked += 1;
    }
    await persist(ctx, scope, await userActor(ctx, subject), pubkey, working);
    return { channels: marked };
  },
});

/**
 * The sidebar's "Mark unread".
 *
 * Note what it does **not** touch: the contexts. A marker cannot be lowered
 * (§4.4), so this records a separate fact — "I deliberately want this room to
 * read as unread, and here is where my marker stood when I said so" — and
 * `forcedUnreadStillLit` decides later whether it still applies. Writing a
 * smaller timestamp instead would be a rewind: permanent, invisible, and applied
 * on every device the reader owns.
 */
export const markChannelUnread = mutation({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args): Promise<{ baseline: number | null }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, channel, membership } = await requireChannelAccess(
      ctx,
      scope,
      args.channelId,
    );
    if (!membership) throw new ConvexError("You are not in this channel");

    const pubkey = await requireReaderPubkey(ctx, "user", subject);
    const working = await hydrate(ctx, scope, pubkey);
    const baseline = working.contexts[channelContextKey(channel.channelId)] ?? null;
    working.forcedUnread[channel.channelId] = baseline;
    await persist(ctx, scope, await userActor(ctx, subject), pubkey, working);
    return { baseline };
  },
});

/**
 * Per-message markers: the message more-menu, and opening a thread.
 *
 * A batch because opening a thread marks **every visible reply** read at once
 * (§4.9) — and only the visible ones, never the whole subtree, or a reply in a
 * still-collapsed branch loses its badge before anybody sees it (§10.18).
 *
 * One grow-only marker per reply rather than one frontier per thread is what
 * makes the state expressible at all: with a single frontier, reading r2 marks
 * r1 and r3 read too, and there is no way to say "I read the middle one".
 */
export const markMessagesRead = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    messages: v.array(v.object({ messageId: v.string(), readAt: v.number() })),
  },
  handler: async (ctx, args): Promise<{ marked: number }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, membership } = await requireChannelAccess(ctx, scope, args.channelId);
    if (!membership) return { marked: 0 };
    if (args.messages.length > 500) {
      throw new ConvexError("Too many messages in one mark-as-read");
    }

    const pubkey = await requireReaderPubkey(ctx, "user", subject);
    const working = await hydrate(ctx, scope, pubkey);
    let marked = 0;
    for (const entry of args.messages) {
      // A non-hex id is not an event id, and a `msg:` key that names nothing is
      // a key that survives seven days of pruning to cover nothing.
      if (!HEX_64.test(entry.messageId)) continue;
      const advanced = advanceContext(
        working.contexts,
        messageContextKey(entry.messageId),
        Math.floor(entry.readAt),
      );
      working.contexts = advanced.contexts;
      if (advanced.advanced.length > 0) marked += 1;
    }
    await persist(ctx, scope, await userActor(ctx, subject), pubkey, working);
    return { marked };
  },
});

/**
 * Merge blobs that came from somewhere else.
 *
 * The cross-device path, and the only caller that hands this file a blob it did
 * not write: an identity imported by `nsec`, a second deployment, an export
 * replayed back. Everything about it is the merge rules doing their job —
 * max-merge so nothing is lost in either direction, sanitisation so a hostile
 * blob cannot write a key we cannot store, and `advanced` draining into the
 * forced-unread map so that a read that happened on the other device clears the
 * dot here (§4.5's cross-device convergence).
 */
export const importBlobs = mutation({
  args: { ...scopeArgs, blobs: v.array(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ advanced: string[]; cleared: string[] }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const pubkey = await requireReaderPubkey(ctx, "user", subject);
    if (args.blobs.length > READ_STATE_MAX_SLOTS) {
      throw new ConvexError(`At most ${READ_STATE_MAX_SLOTS} blobs at a time`);
    }

    const working = await hydrate(ctx, scope, pubkey);
    const advanced = new Set<string>();
    for (const raw of args.blobs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ConvexError("That is not a read-state blob");
      }
      if (!isValidBlob(parsed)) throw new ConvexError("That is not a read-state blob");
      const merged = mergeContexts(working.contexts, sanitizeContexts(parsed.contexts));
      working.contexts = merged.contexts;
      for (const key of merged.advanced) advanced.add(key);
    }

    // Drain the advances into the forced-unread map: a channel that was read
    // elsewhere is not unread here, whatever this device asked for earlier.
    const cleared: string[] = [];
    for (const key of advanced) {
      if (classifyContextKey(key) !== "channel") continue;
      if (!(key in working.forcedUnread)) continue;
      const baseline = working.forcedUnread[key];
      if (forcedUnreadStillLit(baseline, working.contexts[key] ?? null)) continue;
      delete working.forcedUnread[key];
      cleared.push(key);
    }

    await persist(ctx, scope, await userActor(ctx, subject), pubkey, working);
    return { advanced: [...advanced], cleared };
  },
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The reader's own read state, for the client's divider and frontier maths.
 *
 * Only ever your own — the pubkey comes from the session, so there is no
 * argument in which one member could ask for another's. That matters more here
 * than it looks: a read-state blob is a minute-by-minute record of what somebody
 * has been reading.
 */
export const forCurrentUser = query({
  args: scopeArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{
    pubkey: string | null;
    contexts: ReadContexts;
    forcedUnread: Record<string, number | null>;
  }> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const pubkey = await pubkeyFor(ctx, "user", subject);
    if (!pubkey) return { pubkey: null, contexts: {}, forcedUnread: {} };
    const row = await readStateRow(ctx, scope, pubkey);
    return {
      pubkey,
      contexts: row?.contexts ?? {},
      forcedUnread: row?.forcedUnread ?? {},
    };
  },
});

// ---------------------------------------------------------------------------
// §4.5 The sidebar algorithm
// ---------------------------------------------------------------------------

/** The two numbers a rail row draws (`src/lib/buzz/channel-types.ts`). */
export type ChannelUnread = { unread: number; mentions: number };

const NOTHING_UNREAD: ChannelUnread = { unread: 0, mentions: 0 };

/** What `unreadForChannels` needs to know about a room. */
export type UnreadChannelInput = {
  channelId: string;
  channelType: "stream" | "forum" | "dm";
  /** Milliseconds, as the channel row stores it. */
  lastActivityAt: number;
  /** Rooms you are not in do not badge, so they are not scanned. */
  joined: boolean;
};

/**
 * Unread and mention counts for a rail, in bounded index ranges.
 *
 * The shape of the cost is the whole point of this function. The existing Work
 * side answers the same question by `.collect()`ing each channel's entire
 * history per row, which is fine at Work volume and would be fatal here. What
 * this does instead:
 *
 *   - **one** read for the reader's read state, whatever the room count;
 *   - **nothing at all** for a room you have not joined, or whose newest
 *     activity is already covered by your marker — `lastActivityAt` is
 *     denormalized onto the channel row precisely so that "is there anything
 *     new" is answerable without opening the room;
 *   - for the rooms that survive that, **one index range** each, starting at
 *     `marker + 1` and taking at most `UNREAD_COUNT_CAP + 1` rows.
 *
 * So it is an index range, and it is bounded by what a badge can display rather
 * than by how long the reader was away. What it is *not* is a single range
 * across every room: unread is per-reader and per-room, and there is no
 * aggregate anywhere to range over. A room with a hundred thousand messages you
 * have never opened costs a hundred rows here, once.
 *
 * `since = marker + 1` because NIP-01's `since` is inclusive (§10.25) — without
 * the `+ 1` the last-read message comes back as unread. The `> readAt` check
 * below is the belt to that suspenders.
 */
export async function unreadForChannels(
  ctx: QueryCtx,
  scope: Scope,
  readerPubkey: string | null,
  channels: readonly UnreadChannelInput[],
  options: { activeChannelId?: string } = {},
): Promise<Map<string, ChannelUnread>> {
  const out = new Map<string, ChannelUnread>();
  for (const channel of channels) out.set(channel.channelId, NOTHING_UNREAD);
  // A principal with no signing identity has read nothing and written nothing;
  // it is the half-second before the mint bootstrap finishes, and lighting up
  // every room for it would be a number that changes under the reader.
  if (!readerPubkey) return out;

  const row = await readStateRow(ctx, scope, readerPubkey);
  const contexts: Readonly<ReadContexts> = row?.contexts ?? {};
  const forced: Readonly<Record<string, number | null>> = row?.forcedUnread ?? {};

  for (const channel of channels) {
    // The active room is skipped (§4.5): the mark-as-read for it is in flight,
    // and a badge on the thing you are looking at is a badge that flickers.
    if (options.activeChannelId === channel.channelId) continue;
    if (!channel.joined) continue;

    const marker = contexts[channelContextKey(channel.channelId)] ?? null;

    if (channel.channelId in forced) {
      if (forcedUnreadStillLit(forced[channel.channelId], marker)) {
        // Dot tier only, and never a mention: a deliberate mark-unread is a
        // note to yourself, not something somebody addressed to you.
        out.set(channel.channelId, { unread: 1, mentions: 0 });
        continue;
      }
    }

    if (marker !== null && Math.floor(channel.lastActivityAt / 1000) <= marker) continue;

    const rows = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_channel", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", channel.channelId)
          .eq("supersededAt", undefined)
          .gte("createdAt", marker === null ? 0 : marker + 1),
      )
      .order("desc")
      .take(UNREAD_COUNT_CAP + 1);

    let unread = 0;
    let mentions = 0;
    for (const event of rows) {
      if (event.deletedAt !== undefined) continue;
      if (!isConversationalUnreadKind(event.kind)) continue;
      // §10.14: you know about your own posts. Compared on the signing pubkey
      // rather than on anything a tag claims.
      if (event.pubkey === readerPubkey) continue;

      const rootId = resolveObservedUnreadRootId(event.tags);
      const readAt = observedUnreadEventReadAt(marker, contexts, event.eventId, rootId);
      if (!isEventUnread(event.createdAt, readAt)) continue;

      unread += 1;
      // §4.8: a plain channel message lights the dot but does not add to the
      // number — the number is reserved for things addressed to you. In a DM
      // every message is; elsewhere it takes a `p` tag naming you.
      if (
        channel.channelType === "dm" ||
        event.tags.some((tag: string[]) => tag[0] === "p" && tag[1] === readerPubkey)
      ) {
        mentions += 1;
      }
    }

    if (unread === 0) continue;
    out.set(channel.channelId, {
      unread: Math.min(unread, UNREAD_COUNT_CAP),
      mentions: Math.min(mentions, UNREAD_COUNT_CAP),
    });
  }

  return out;
}
