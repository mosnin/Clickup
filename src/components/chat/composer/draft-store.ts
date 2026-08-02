"use client";

// The browser half of drafts: localStorage, and a way for React to hear it.
//
// Everything that could be a rule lives in `src/lib/buzz/drafts.ts`. What is
// left here is the part that is genuinely about the environment, and it is
// three facts:
//
//  1. **localStorage is not reactive.** Two composers, a drafts list and a
//     badge all read the same store, so there is one module-level copy and a
//     subscriber set behind `useSyncExternalStore`. Per-hook state would let two
//     mounted composers for the same room disagree, and the one that lost would
//     overwrite the winner on its next keystroke. The snapshot is the entry
//     *object* rather than a version number: every pure write returns the same
//     object when it changed nothing, so identity is already the answer to "did
//     this move", and a counter would re-render every subscriber on every
//     keystroke in every room.
//
//  2. **A flush can fail.** Private mode throws on write, and the quota is
//     shared. A failed flush must not roll back the in-memory store: the person
//     is still typing, and the draft they can see is worth more than the one on
//     disk. So the memory copy is authoritative for the session and the disk
//     copy is best-effort.
//
//  3. **Another tab can write.** The `storage` event is the only notification
//     we get, and it fires with our own key when a sibling tab flushes. Adopting
//     it wholesale would clobber what is being typed here, so it is adopted only
//     for keys nobody in this tab currently owns.

import { useCallback, useSyncExternalStore } from "react";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  clearDraftEntry,
  draftsStorageKey,
  getDraftEntry,
  legacyDraftsStorageKey,
  migrateLegacyDrafts,
  persistDraftEntry,
  renameDraftEntry,
  serializeDraftStore,
  type DraftEntry,
  type DraftInput,
  type DraftStore,
  type RenameResult,
} from "@/lib/buzz/drafts";

let storageKey: string | null = null;
let store: DraftStore = {};
const listeners = new Set<() => void>();
/** Keys a live composer is currently editing — see fact 3. */
const owned = new Set<string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or quota — the memory copy is what the person can see */
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function commit(next: DraftStore) {
  // Identity, not deep equality: every pure write returns the same object when
  // it changed nothing, which is precisely so this can skip a flush and a
  // re-render on the keystrokes that do not move the draft.
  if (next === store) return;
  store = next;
  if (storageKey) write(storageKey, serializeDraftStore(store));
  notify();
}

/**
 * Point the store at a community and an identity.
 *
 * Idempotent, and it runs the one-time v1 migration on the way in. Switching
 * communities swaps the whole store: drafts are keyed by channel id, and a
 * channel id from another community resolves to nothing here.
 */
export function configureDraftStore(scope: ChatScope | null, pubkey: string | null) {
  const key = scope && pubkey ? draftsStorageKey(scope, pubkey) : null;
  if (key === storageKey) return;
  storageKey = key;
  if (!key || !pubkey) {
    store = {};
    notify();
    return;
  }
  const legacyKey = legacyDraftsStorageKey(pubkey);
  const { store: next, migrated } = migrateLegacyDrafts({
    legacyRaw: read(legacyKey),
    currentRaw: read(key),
    hasScope: true,
  });
  store = next;
  if (migrated) {
    // Write first, then drop the source. The other order loses every draft on
    // a browser that dies between the two calls.
    write(key, serializeDraftStore(store));
    remove(legacyKey);
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Adopt a sibling tab's flush, but never over a box somebody is typing in. */
function onStorage(event: StorageEvent) {
  if (!storageKey || event.key !== storageKey) return;
  const incoming = migrateLegacyDrafts({
    legacyRaw: null,
    currentRaw: event.newValue,
    hasScope: true,
  }).store;
  const next: DraftStore = { ...incoming };
  for (const key of owned) {
    const mine = store[key];
    if (mine) next[key] = mine;
    else delete next[key];
  }
  store = next;
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", onStorage);
}

function nowIso(): string {
  return new Date().toISOString();
}

// The imperative surface. It exists because a debounced save has to be
// flushable with an *explicit* key: the hook's `save` closes over whichever key
// is current, and the whole point of a flush is that it runs when the key is
// about to change — at which moment the closure is already the wrong one, and
// the pending text lands in the room you just walked into.

export function saveDraftNow(key: string, input: DraftInput) {
  owned.add(key);
  commit(persistDraftEntry(store, key, input, nowIso()));
}

export function clearDraftNow(key: string) {
  commit(clearDraftEntry(store, key));
  owned.delete(key);
}

export function renameDraftNow(oldKey: string, newKey: string): RenameResult {
  const { store: next, result } = renameDraftEntry(store, oldKey, newKey);
  if (result === "migrated") {
    owned.delete(oldKey);
    owned.add(newKey);
  }
  commit(next);
  return result;
}

/** Read a draft outside React — restoring one after a failed send. */
export function peekDraft(key: string): DraftEntry | undefined {
  return getDraftEntry(store, key);
}

/**
 * One composer's draft, and the three things it can do to it.
 *
 * `key` is opaque (a channel id, or `thread:<headId>`) — the composer says
 * which one it is; nothing here parses it.
 */
export function useDraft(key: string | null): {
  draft: DraftEntry | undefined;
  save: (input: DraftInput) => void;
  clear: () => void;
  rename: (newKey: string) => RenameResult;
} {
  const draft = useSyncExternalStore(
    subscribe,
    () => (key ? getDraftEntry(store, key) : undefined),
    () => undefined,
  );

  const save = useCallback(
    (input: DraftInput) => {
      if (key) saveDraftNow(key, input);
    },
    [key],
  );

  const clear = useCallback(() => {
    if (key) clearDraftNow(key);
  }, [key]);

  const rename = useCallback(
    (newKey: string): RenameResult => (key ? renameDraftNow(key, newKey) : "noop"),
    [key],
  );

  return { draft, save, clear, rename };
}

/** Test seam: forget everything, including which keys are being typed in. */
export function resetDraftStoreForTests() {
  storageKey = null;
  store = {};
  owned.clear();
  notify();
}
