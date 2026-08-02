import { describe, expect, it } from "vitest";
import {
  MAX_DRAFTS,
  allDraftEntries,
  canonicalizeScope,
  channelDraftKey,
  clearDraftEntry,
  draftStatesEqual,
  draftsStorageKey,
  legacyDraftsStorageKey,
  migrateLegacyDrafts,
  parseDraftStore,
  persistDraftEntry,
  renameDraftEntry,
  saveDraftEntry,
  serializeDraftStore,
  threadDraftKey,
  type DraftEntry,
  type DraftStore,
} from "@/lib/buzz/drafts";

// A draft is the only text in the application that exists in exactly one
// place. There is no server copy, no event to replay, no undo. So these tests
// are not really about a key-value store — they are about the handful of moves
// that can silently eat somebody's unsent sentence, and every one of them is
// asserted from both sides.

const T1 = "2026-08-01T10:00:00.000Z";
const T2 = "2026-08-01T10:05:00.000Z";
const T3 = "2026-08-01T10:09:00.000Z";

function entry(over: Partial<DraftEntry> = {}): DraftEntry {
  return {
    content: "half a thought",
    selectionStart: 14,
    selectionEnd: 14,
    channelId: "ch_general",
    createdAt: T1,
    updatedAt: T1,
    attachmentUrls: [],
    status: "active",
    ...over,
  };
}

describe("draft keys", () => {
  it("keeps a community's id case, and only lowercases the closed literal", () => {
    // The scope type is one of two words, so its case says nothing. The id is a
    // Convex document id, where case IS information: folding `jd7A` and `jd7a`
    // together merges two workspaces' drafts into one bucket.
    expect(canonicalizeScope({ scopeType: "workspace", scopeId: "jd7Ab9" })).toBe(
      "workspace:jd7Ab9",
    );
    expect(
      draftsStorageKey({ scopeType: "workspace", scopeId: "jd7Ab9" }, "user_1"),
    ).toBe("buzz-drafts.v2:workspace:jd7Ab9:user_1");
    expect(
      draftsStorageKey({ scopeType: "workspace", scopeId: "jd7ab9" }, "user_1"),
    ).not.toBe(
      draftsStorageKey({ scopeType: "workspace", scopeId: "jd7Ab9" }, "user_1"),
    );
  });

  it("gives a person their own bucket inside a community", () => {
    const scope = { scopeType: "user" as const, scopeId: "u_1" };
    expect(draftsStorageKey(scope, "ada")).not.toBe(draftsStorageKey(scope, "grace"));
    expect(legacyDraftsStorageKey("ada")).toBe("buzz-drafts.v1:ada");
  });

  it("keys a channel draft and a thread draft differently", () => {
    // Two half-written replies in one room must not overwrite each other.
    expect(channelDraftKey("ch_general")).toBe("ch_general");
    expect(threadDraftKey("evt_9")).toBe("thread:evt_9");
    expect(channelDraftKey("ch_general")).not.toBe(threadDraftKey("ch_general"));
  });
});

describe("reading a stored blob", () => {
  it("survives a store that will not parse", () => {
    expect(parseDraftStore("{not json")).toEqual({});
    expect(parseDraftStore(null)).toEqual({});
    expect(parseDraftStore("[]")).toEqual({});
  });

  it("drops one malformed row rather than the whole store", () => {
    const raw = JSON.stringify({
      good: entry(),
      bad: { content: 42 },
      alsoBad: { content: "x" }, // no channelId
    });
    const store = parseDraftStore(raw);
    expect(Object.keys(store)).toEqual(["good"]);
  });

  it("never resurrects a legacy `sent:` row", () => {
    // These describe a message that was already posted. Restoring one puts
    // text back in somebody's composer that they have already said.
    const raw = JSON.stringify({
      "sent:ch_general": entry({ content: "already sent this" }),
      ch_general: entry(),
    });
    expect(Object.keys(parseDraftStore(raw))).toEqual(["ch_general"]);
  });

  it("reads back the channel it stored rather than parsing the key", () => {
    // A channel id containing a colon would make `thread:x:y` ambiguous, which
    // is why the id is a field and not something to be reverse-engineered.
    const store = parseDraftStore(
      serializeDraftStore({ "thread:evt:9": entry({ channelId: "ch:odd:name" }) }),
    );
    expect(store["thread:evt:9"].channelId).toBe("ch:odd:name");
  });
});

describe("saving", () => {
  it("preserves createdAt across every subsequent save", () => {
    let store: DraftStore = {};
    store = persistDraftEntry(store, "ch_1", { content: "a", channelId: "ch_1" }, T1);
    store = persistDraftEntry(store, "ch_1", { content: "ab", channelId: "ch_1" }, T2);
    expect(store.ch_1.createdAt).toBe(T1);
    expect(store.ch_1.updatedAt).toBe(T2);
  });

  it("clears on empty through persist, and refuses to through save", () => {
    // The difference is the whole reason both exist. A composer emptied by
    // hand means "withdraw the draft"; a programmatic seed with nothing in it
    // means "I have nothing to add" and must never delete what is there.
    const seeded = persistDraftEntry({}, "ch_1", { content: "x", channelId: "ch_1" }, T1);
    expect(persistDraftEntry(seeded, "ch_1", { content: "  ", channelId: "ch_1" }, T2)).toEqual({});
    expect(saveDraftEntry(seeded, "ch_1", { content: "", channelId: "ch_1" }, T2)).toBe(seeded);
  });

  it("counts an attachment as content even with nothing typed", () => {
    const store = persistDraftEntry(
      {},
      "ch_1",
      { content: "", channelId: "ch_1", attachmentUrls: ["blob:1"] },
      T1,
    );
    expect(store.ch_1.attachmentUrls).toEqual(["blob:1"]);
  });

  it("returns the same object when nothing changed, so the caller can skip a flush", () => {
    const store: DraftStore = {};
    expect(clearDraftEntry(store, "missing")).toBe(store);
  });

  it("evicts the least recently updated once the cap is reached", () => {
    let store: DraftStore = {};
    for (let i = 0; i < MAX_DRAFTS; i += 1) {
      const stamp = `2026-08-01T10:${String(i).padStart(2, "0")}:00.000Z`;
      store = persistDraftEntry(store, `ch_${i}`, { content: `d${i}`, channelId: `ch_${i}` }, stamp);
    }
    store = persistDraftEntry(store, "ch_new", { content: "new", channelId: "ch_new" }, T3);
    expect(Object.keys(store)).toHaveLength(MAX_DRAFTS);
    expect(store.ch_new).toBeTruthy();
    expect(store.ch_0).toBeUndefined();
    expect(store.ch_99).toBeTruthy();
  });

  it("lists drafts most recently updated first", () => {
    let store: DraftStore = {};
    store = persistDraftEntry(store, "a", { content: "a", channelId: "a" }, T1);
    store = persistDraftEntry(store, "b", { content: "b", channelId: "b" }, T3);
    store = persistDraftEntry(store, "c", { content: "c", channelId: "c" }, T2);
    expect(allDraftEntries(store).map((row) => row.key)).toEqual(["b", "c", "a"]);
  });
});

describe("the atomic rename", () => {
  // Where a draft gets silently eaten. A key follows the thing it is about,
  // and that thing can be renamed underneath it — you reply in a thread whose
  // head is still optimistic (`thread:optimistic-…`) and then the real event id
  // arrives. Composed from a save and a clear, that is two flushes with a
  // window in between where the draft exists under neither key.

  it("moves the draft and leaves nothing behind", () => {
    const store = { "thread:optimistic-1": entry({ content: "my reply" }) };
    const { store: next, result } = renameDraftEntry(
      store,
      "thread:optimistic-1",
      "thread:evt_77",
    );
    expect(result).toBe("migrated");
    expect(next["thread:optimistic-1"]).toBeUndefined();
    expect(next["thread:evt_77"].content).toBe("my reply");
    // And the input is untouched — one store in, one store out, so the adapter
    // performs exactly one flush.
    expect(store["thread:optimistic-1"]).toBeTruthy();
  });

  it("does nothing when there is no draft to move, or the keys are the same", () => {
    const store = { a: entry() };
    expect(renameDraftEntry(store, "missing", "b")).toEqual({ store, result: "noop" });
    expect(renameDraftEntry(store, "a", "a")).toEqual({ store, result: "noop" });
  });

  it("collapses onto a destination that is identical in every persisted field", () => {
    // The only safe collapse: two records that would serialize to the same
    // bytes are one record, so dropping either loses nothing.
    const twin = entry();
    const { store: next, result } = renameDraftEntry(
      { old: twin, new: { ...twin } },
      "old",
      "new",
    );
    expect(result).toBe("migrated");
    expect(Object.keys(next)).toEqual(["new"]);
  });

  it("preserves BOTH records when the destination differs", () => {
    // The rule that matters. A merge policy that picks a winner is a merge
    // policy that throws away the loser, and only the person who typed them
    // can say which one to discard.
    const store = {
      old: entry({ content: "the one I typed in the thread" }),
      new: entry({ content: "the one I typed in the room" }),
    };
    const { store: next, result } = renameDraftEntry(store, "old", "new");
    expect(result).toBe("collision");
    expect(next).toBe(store);
    expect(next.old.content).toBe("the one I typed in the thread");
    expect(next.new.content).toBe("the one I typed in the room");
  });

  it("treats a difference in any single persisted field as a collision", () => {
    const base = entry();
    const variants: Partial<DraftEntry>[] = [
      { content: "different" },
      { selectionStart: 1 },
      { selectionEnd: 2 },
      { channelId: "ch_other" },
      { createdAt: T2 },
      { updatedAt: T2 },
      { attachmentUrls: ["blob:1"] },
      { mentionRefs: [{ displayName: "Ada", actorId: "u1", isAgent: false }] },
    ];
    for (const over of variants) {
      const store = { old: base, new: entry(over) };
      expect(renameDraftEntry(store, "old", "new").result).toBe("collision");
    }
  });

  it("does not manufacture a collision out of absent-versus-empty mentions", () => {
    // Both forms serialize identically, so calling them different would block
    // a rename that is entirely safe.
    const a = entry();
    const b = entry({ mentionRefs: [] });
    expect(draftStatesEqual(a, b)).toBe(true);
    expect(renameDraftEntry({ old: a, new: b }, "old", "new").result).toBe("migrated");
  });
});

describe("the one-time forward migration", () => {
  const legacy = serializeDraftStore({ ch_1: entry({ content: "from before" }) });

  it("adopts v1 drafts when there is no v2 store and a community is known", () => {
    const { store, migrated } = migrateLegacyDrafts({
      legacyRaw: legacy,
      currentRaw: null,
      hasScope: true,
    });
    expect(migrated).toBe(true);
    expect(store.ch_1.content).toBe("from before");
  });

  it("refuses to run without a community, so nothing is read and then dropped", () => {
    // v1 keys carry no community. Reading them with nowhere to write them is
    // how the source gets deleted and the drafts go with it.
    const { store, migrated } = migrateLegacyDrafts({
      legacyRaw: legacy,
      currentRaw: null,
      hasScope: false,
    });
    expect(migrated).toBe(false);
    expect(store).toEqual({});
  });

  it("never imports the same legacy bucket into a second community", () => {
    // The v1 drafts belong to whichever community asked first. A second one
    // inheriting them would show somebody drafts whose channel ids do not even
    // resolve there.
    const { store, migrated } = migrateLegacyDrafts({
      legacyRaw: legacy,
      currentRaw: serializeDraftStore({ ch_9: entry({ content: "mine" }) }),
      hasScope: true,
    });
    expect(migrated).toBe(false);
    expect(store.ch_1).toBeUndefined();
    expect(store.ch_9.content).toBe("mine");
  });

  it("does not resurrect v1 drafts into a v2 store somebody has emptied", () => {
    // An empty v2 store is a store, not an absence: its owner cleared their
    // last draft on purpose.
    const { store, migrated } = migrateLegacyDrafts({
      legacyRaw: legacy,
      currentRaw: "{}",
      hasScope: true,
    });
    expect(migrated).toBe(false);
    expect(store).toEqual({});
  });

  it("reports a stale empty v1 key as migrated so it stops being read", () => {
    const { store, migrated } = migrateLegacyDrafts({
      legacyRaw: "{}",
      currentRaw: null,
      hasScope: true,
    });
    expect(migrated).toBe(true);
    expect(store).toEqual({});
  });

  it("does not claim a migration when there was no legacy key at all", () => {
    expect(
      migrateLegacyDrafts({ legacyRaw: null, currentRaw: null, hasScope: true }),
    ).toEqual({ store: {}, migrated: false });
  });
});
