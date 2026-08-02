// Drafts — what somebody typed and did not send.
//
// A draft is the least valuable-looking thing in a chat client and the most
// expensive one to lose: it is the only text in the application that exists
// nowhere else. There is no server copy, no undo history, no event to replay.
// So every rule here is written as "what must never eat a draft", and every one
// of them is pure, because the failure mode is silent — a draft that vanishes
// looks exactly like a draft that was never typed, and nobody files a bug
// about a box that is empty.
//
// Three rules carry the weight (docs/buzz-parity/01-core-comms.md §2.5):
//
//  1. **The channel id is stored, never parsed back out of the key.** Keys are
//     opaque: a channel key is a channel id and a thread key is
//     `thread:<headId>`, and a channel id containing a colon would make the
//     inverse ambiguous. A store that has to reverse-engineer where a draft
//     belongs is a store that will one day put it in the wrong room.
//
//  2. **Renaming is one operation, not save-then-clear.** A draft key follows
//     the thing it is about, and the thing it is about can be renamed under it:
//     you reply to a message that is still optimistic, its key is
//     `thread:optimistic-…`, and then the real event id arrives. Composed from
//     a save and a clear, that is two flushes with a window in between where a
//     crash — or a second tab writing its own snapshot — leaves the draft in
//     neither key. `renameDraftEntry` is the only supported way to move one.
//
//  3. **A collision preserves both records.** When the destination key already
//     holds a draft, collapsing onto it is only safe when the two are
//     *identical in every persisted field*. Anything else is two different
//     pieces of writing and the store keeps both, because a merge policy that
//     picks a winner is a merge policy that throws away the loser.
//
// Pure: no localStorage, no React, no clock. The adapter that owns the browser
// (src/components/chat/composer/draft-store.ts) supplies `now` and the raw
// strings, which is what lets every one of these rules be tested directly.

import type { ChatScope } from "./channel-types";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A mention the composer already resolved.
 *
 * Carried on the draft so a restored draft still knows who `@Ada` was. The
 * token in `content` is the app's one mention grammar (`src/lib/mentions.ts`),
 * so this is strictly a cache — a draft whose refs were dropped still sends
 * the right thing.
 */
export type DraftMentionRef = {
  displayName: string;
  actorId: string;
  isAgent: boolean;
};

export type DraftEntry = {
  /** Markdown. The same bytes that would have been posted. */
  content: string;
  selectionStart: number;
  selectionEnd: number;
  /** Explicit — see rule 1. Never derived from the key. */
  channelId: string;
  /** ISO. Preserved across every save; only a fresh draft sets it. */
  createdAt: string;
  updatedAt: string;
  attachmentUrls: string[];
  mentionRefs?: DraftMentionRef[];
  /**
   * Always `"active"` at runtime.
   *
   * Kept as a field rather than dropped because the legacy store wrote
   * `sent:`-prefixed rows, and a reader that cannot tell an active draft from a
   * sent one restores somebody's already-posted message into their composer.
   */
  status: "active";
};

/** Draft key → entry. The whole store for one person in one community. */
export type DraftStore = Record<string, DraftEntry>;

/** What a caller hands in; timestamps and status are the store's business. */
export type DraftInput = {
  content: string;
  selectionStart?: number;
  selectionEnd?: number;
  channelId: string;
  attachmentUrls?: string[];
  mentionRefs?: DraftMentionRef[];
};

export const MAX_DRAFTS = 100;

const V2_PREFIX = "buzz-drafts.v2";
const V1_PREFIX = "buzz-drafts.v1";
const THREAD_KEY_PREFIX = "thread:";
/** Rows the legacy store wrote for messages that had already been sent. */
const SENT_KEY_PREFIX = "sent:";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The community a draft store belongs to.
 *
 * Case is preserved on the id and only the type is lowercased. The type is a
 * closed literal so its case carries no information; the id is a Convex
 * document id, where case *is* information — two ids differing only in case are
 * two different workspaces, and folding them together would merge two people's
 * drafts into one bucket.
 */
export function canonicalizeScope(scope: ChatScope): string {
  return `${scope.scopeType.toLowerCase()}:${scope.scopeId}`;
}

/** `buzz-drafts.v2:<scope>:<pubkey>` — the current store. */
export function draftsStorageKey(scope: ChatScope, pubkey: string): string {
  return `${V2_PREFIX}:${canonicalizeScope(scope)}:${pubkey}`;
}

/** `buzz-drafts.v1:<pubkey>` — the pre-community store, read once and deleted. */
export function legacyDraftsStorageKey(pubkey: string): string {
  return `${V1_PREFIX}:${pubkey}`;
}

/** The key a channel composer's draft lives under. */
export function channelDraftKey(channelId: string): string {
  return channelId;
}

/** The key a thread composer's draft lives under. */
export function threadDraftKey(threadHeadId: string): string {
  return `${THREAD_KEY_PREFIX}${threadHeadId}`;
}

export function isThreadDraftKey(key: string): boolean {
  return key.startsWith(THREAD_KEY_PREFIX);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function mentionRefs(value: unknown): DraftMentionRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter(isRecord).map((row) => ({
    displayName: typeof row.displayName === "string" ? row.displayName : "",
    actorId: typeof row.actorId === "string" ? row.actorId : "",
    isAgent: row.isAgent === true,
  }));
  return rows.length ? rows : undefined;
}

/**
 * Read one row, or null if it is not a draft we can restore.
 *
 * Total and forgiving on the way in, for the same reason `normalizeAppearance`
 * is: a row written by a newer build, or half-written by a browser that died
 * mid-flush, must cost one draft rather than the whole store.
 */
function readEntry(key: string, value: unknown): DraftEntry | null {
  // Legacy `sent:` rows are dropped rather than migrated: they describe a
  // message that was already posted, and restoring one puts text back in
  // somebody's composer that they have already said.
  if (key.startsWith(SENT_KEY_PREFIX)) return null;
  if (!isRecord(value)) return null;
  if (typeof value.content !== "string") return null;
  if (typeof value.channelId !== "string" || value.channelId === "") return null;
  if (value.status !== undefined && value.status !== "active") return null;

  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  if (!createdAt || !updatedAt) return null;

  const start = typeof value.selectionStart === "number" ? value.selectionStart : value.content.length;
  const end = typeof value.selectionEnd === "number" ? value.selectionEnd : start;
  const refs = mentionRefs(value.mentionRefs);

  return {
    content: value.content,
    selectionStart: start,
    selectionEnd: end,
    channelId: value.channelId,
    createdAt,
    updatedAt,
    attachmentUrls: stringArray(value.attachmentUrls),
    ...(refs ? { mentionRefs: refs } : {}),
    status: "active",
  };
}

/** Parse a stored blob. A store that will not parse is an empty store. */
export function parseDraftStore(raw: string | null | undefined): DraftStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const store: DraftStore = {};
  for (const [key, value] of Object.entries(parsed)) {
    const entry = readEntry(key, value);
    if (entry) store[key] = entry;
  }
  return store;
}

export function serializeDraftStore(store: DraftStore): string {
  return JSON.stringify(store);
}

// ---------------------------------------------------------------------------
// Equality — the collision rule
// ---------------------------------------------------------------------------

function sameRefs(a: DraftMentionRef[] | undefined, b: DraftMentionRef[] | undefined): boolean {
  // Absent and empty are the same statement about the world; comparing them as
  // different would manufacture a collision between two drafts that are
  // byte-identical once written.
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (ref, i) =>
      ref.actorId === right[i].actorId &&
      ref.displayName === right[i].displayName &&
      ref.isAgent === right[i].isAgent,
  );
}

/**
 * Are these two drafts the same record?
 *
 * Every persisted field, timestamps included. Timestamps look like noise to
 * compare on — two drafts with the same text are "the same draft", surely — but
 * they are exactly what distinguishes "this key was renamed onto its own
 * destination" from "two different sittings produced similar text". The strict
 * answer is the safe one: the only thing a false *inequality* costs is a
 * collision the caller has to resolve, while a false equality deletes writing.
 */
export function draftStatesEqual(a: DraftEntry, b: DraftEntry): boolean {
  return (
    a.content === b.content &&
    a.selectionStart === b.selectionStart &&
    a.selectionEnd === b.selectionEnd &&
    a.channelId === b.channelId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.status === b.status &&
    a.attachmentUrls.length === b.attachmentUrls.length &&
    a.attachmentUrls.every((url, i) => url === b.attachmentUrls[i]) &&
    sameRefs(a.mentionRefs, b.mentionRefs)
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getDraftEntry(store: DraftStore, key: string): DraftEntry | undefined {
  return store[key];
}

/** Most recently updated first — the order a drafts list is read in. */
export function allDraftEntries(store: DraftStore): { key: string; entry: DraftEntry }[] {
  return Object.entries(store)
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
}

/** Blank text and nothing attached — there is no draft here. */
export function draftInputIsEmpty(input: DraftInput): boolean {
  return input.content.trim() === "" && (input.attachmentUrls?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function buildEntry(previous: DraftEntry | undefined, input: DraftInput, now: string): DraftEntry {
  const refs = input.mentionRefs?.length ? input.mentionRefs : undefined;
  return {
    content: input.content,
    selectionStart: input.selectionStart ?? input.content.length,
    selectionEnd: input.selectionEnd ?? input.selectionStart ?? input.content.length,
    channelId: input.channelId,
    // Preserved: "when did I start writing this" survives every keystroke.
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    attachmentUrls: input.attachmentUrls ?? [],
    ...(refs ? { mentionRefs: refs } : {}),
    status: "active",
  };
}

/**
 * Evict down to `MAX_DRAFTS`, oldest `updatedAt` first.
 *
 * A cap rather than unbounded growth because this store shares a 5MB origin
 * quota with everything else the app persists, and a quota error is thrown by
 * the *next* write — so an uncapped drafts store eventually eats an unrelated
 * feature's ability to save.
 */
function evict(store: DraftStore): DraftStore {
  const keys = Object.keys(store);
  if (keys.length <= MAX_DRAFTS) return store;
  const keep = new Set(
    allDraftEntries(store)
      .slice(0, MAX_DRAFTS)
      .map((row) => row.key),
  );
  const next: DraftStore = {};
  for (const key of keys) if (keep.has(key)) next[key] = store[key];
  return next;
}

/**
 * Save a draft, or do nothing at all if there is nothing to save.
 *
 * Deliberately *cannot* clear: a blank input is a no-op, not a delete. This is
 * the variant for callers that are seeding a draft (restoring a failed send,
 * quoting a message) where "the text I have is empty" means "I have nothing to
 * contribute", never "throw away what is there".
 *
 * Returns the same store object when nothing changed, so an adapter can skip
 * the flush and the notify by identity.
 */
export function saveDraftEntry(
  store: DraftStore,
  key: string,
  input: DraftInput,
  now: string,
): DraftStore {
  if (draftInputIsEmpty(input)) return store;
  return evict({ ...store, [key]: buildEntry(store[key], input, now) });
}

/**
 * Save-or-clear. What a composer calls on every change.
 *
 * The composer *does* mean "delete it" when the box is empty — somebody who
 * selected all and hit backspace has withdrawn the draft — so this is the
 * variant that clears. `createdAt` is preserved whenever a row survives.
 */
export function persistDraftEntry(
  store: DraftStore,
  key: string,
  input: DraftInput,
  now: string,
): DraftStore {
  if (draftInputIsEmpty(input)) return clearDraftEntry(store, key);
  return evict({ ...store, [key]: buildEntry(store[key], input, now) });
}

/** Remove a draft. Returns the same store when there was nothing there. */
export function clearDraftEntry(store: DraftStore, key: string): DraftStore {
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

export type RenameResult = "migrated" | "collision" | "noop";

/**
 * Move a draft from one key to another, atomically.
 *
 * One store in, one store out — so the adapter performs exactly one flush and
 * one notify, and there is no moment at which the draft exists under neither
 * key. Callers must not compose this from `saveDraftEntry` + `clearDraftEntry`:
 * that is two flushes, and a second tab (or a crash) between them loses the
 * draft entirely. This is why the operation exists as a primitive at all.
 *
 * The three answers:
 *   - `noop`      — nothing at the source, or the keys are the same. Untouched.
 *   - `migrated`  — moved; or collapsed onto a destination that is identical in
 *                   every persisted field, which is the only safe collapse.
 *   - `collision` — both keys hold drafts and they differ. **Both are kept**
 *                   and the store is returned unchanged; the caller decides,
 *                   because only a person can say which of two pieces of their
 *                   own writing to discard.
 */
export function renameDraftEntry(
  store: DraftStore,
  oldKey: string,
  newKey: string,
): { store: DraftStore; result: RenameResult } {
  if (oldKey === newKey) return { store, result: "noop" };
  const source = store[oldKey];
  if (!source) return { store, result: "noop" };

  const destination = store[newKey];
  if (destination && !draftStatesEqual(source, destination)) {
    return { store, result: "collision" };
  }

  const next = { ...store };
  delete next[oldKey];
  // When the destination existed and matched, this rewrites it with an equal
  // value — the collapse the spec describes, and the reason it is safe.
  next[newKey] = source;
  return { store: next, result: "migrated" };
}

// ---------------------------------------------------------------------------
// The one-time forward migration
// ---------------------------------------------------------------------------

export type LegacyMigration = {
  store: DraftStore;
  /** True when v1 rows were adopted and the v1 key should now be deleted. */
  migrated: boolean;
};

/**
 * Fold a v1 (pre-community) store into a v2 one, at most once.
 *
 * Two guards, and both matter:
 *
 *  - **Only when no v2 store exists.** v1 has no community in its key, so its
 *    drafts belong to whichever community happens to ask first. Importing them
 *    on top of an existing v2 store would let a second community inherit
 *    somebody's drafts from a first — and the channel ids would not even
 *    resolve there.
 *  - **Only when a community is known.** Without a scope there is no v2 key to
 *    write to, so a migration attempted now would read the legacy rows and have
 *    nowhere to put them. Deleting the source afterwards is what makes this
 *    one-time; deleting it without a successful write is how the drafts die.
 *
 * The caller deletes the v1 key only after the v2 write succeeds, which is why
 * `migrated` is reported rather than assumed.
 */
export function migrateLegacyDrafts(args: {
  legacyRaw: string | null;
  currentRaw: string | null;
  hasScope: boolean;
}): LegacyMigration {
  const current = parseDraftStore(args.currentRaw);
  if (!args.hasScope) return { store: current, migrated: false };
  // "A v2 store exists" is about the *key*, not about it having rows: someone
  // who cleared their last draft has an empty v2 store, and re-importing v1
  // into it would resurrect drafts they deliberately discarded.
  if (args.currentRaw !== null && args.currentRaw !== undefined) {
    return { store: current, migrated: false };
  }
  const legacy = parseDraftStore(args.legacyRaw);
  if (Object.keys(legacy).length === 0) {
    // Nothing to adopt, but the stale key is still reported as migrated so the
    // caller deletes it and this path is never walked again.
    return { store: current, migrated: args.legacyRaw !== null };
  }
  return { store: evict(legacy), migrated: true };
}
