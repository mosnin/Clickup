import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  AGENT_NOTE_GROUP_WINDOW_SECONDS,
  PULSE_TABS,
  applyReactionState,
  getReplyParent,
  groupAgentNotes,
  isProjectComment,
  normalizePulseTab,
  noteSnippet,
  projectPulse,
  pulseAudience,
  pulseEmptyState,
  pulseQueryKey,
  reactionStates,
  selectPulseNotes,
  sortPulseNotes,
  toggleNoteIdInSet,
  visibleRefetchInterval,
  withoutProjectComments,
  type PulseNote,
  type PulseTab,
} from "@/lib/buzz/pulse";

// `anyApi` for the same reason every other Chat suite gives: the generated
// `api` is a checked-in stub that predates `convex/buzz/*`.
const modules = import.meta.glob("../convex/**/*.*s");
const pulse = anyApi.buzz.pulse;
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;


const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;
type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
type Feed = {
  viewerPubkey: string;
  notes: Event[];
  reactions: Event[];
  contactPubkeys: string[];
  agentPubkeys: string[];
  likedNoteIds: string[];
  agentCount: number;
  authors: { pubkey: string; name: string; isAgent: boolean }[];
};

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  // Creating a room publishes relay-signed state, so the community relay seed
  // is not optional for the suite. Fixed, so the derived pubkey is the same on
  // every run.
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

// ---------------------------------------------------------------------------
// Pure derivation (§3.1, §3.2)
// ---------------------------------------------------------------------------

let nextId = 0;
function note(over: Partial<PulseNote> = {}): PulseNote {
  nextId += 1;
  return {
    id: over.id ?? `n${nextId}`,
    pubkey: "aa",
    createdAt: 1000,
    content: "hello",
    tags: [],
    ...over,
  };
}

describe("tabs", () => {
  it("lands an unknown ?tab= on a real tab rather than an empty screen", () => {
    expect(normalizePulseTab("agents")).toBe("agents");
    expect(normalizePulseTab("nonsense")).toBe("everyone");
    expect(normalizePulseTab(null)).toBe("everyone");
  });

  it("shows the composer everywhere except search and agents", () => {
    const composers = PULSE_TABS.filter((t) => t.composer).map((t) => t.id);
    expect(composers).toEqual(["everyone", "following", "liked", "mine"]);
  });

  it("distinguishes no agents from no agent notes", () => {
    expect(pulseEmptyState("agents", { agentCount: 0 })).toMatch(/No agents registered/);
    expect(pulseEmptyState("agents", { agentCount: 3 })).toMatch(/No agent notes/);
  });
});

describe("project comments", () => {
  it("drops any note carrying a 30617 coordinate, on every feed", () => {
    const comment = note({ tags: [["a", "30617:aa:repo"]] });
    const ordinary = note({ tags: [["a", "30621:aa:project"]] });
    expect(isProjectComment(comment.tags)).toBe(true);
    expect(isProjectComment(ordinary.tags)).toBe(false);
    expect(withoutProjectComments([comment, ordinary])).toEqual([ordinary]);
    // Not just "everyone" — every tab strips them.
    for (const tab of ["everyone", "mine"] as PulseTab[]) {
      const audience = pulseAudience({ viewerPubkey: "aa" });
      expect(selectPulseNotes(tab, [comment, ordinary], audience)).toEqual([ordinary]);
    }
  });
});

describe("reply parents", () => {
  it("prefers a reply marker, then an unmarked tag, then root", () => {
    expect(
      getReplyParent([
        ["e", "root", "", "root"],
        ["e", "parent", "", "reply"],
      ]),
    ).toBe("parent");
    // Positional NIP-10: the immediate parent is last.
    expect(getReplyParent([["e", "root"], ["e", "parent"]])).toBe("parent");
    expect(getReplyParent([["e", "root", "", "root"]])).toBe("root");
    expect(getReplyParent([["p", "aa"]])).toBeNull();
  });

  it("collapses whitespace and cuts a snippet at 120 characters", () => {
    expect(noteSnippet("a\n\n  b   c")).toBe("a b c");
    const long = "x".repeat(400);
    expect(noteSnippet(long)).toHaveLength(120);
    expect(noteSnippet(long).endsWith("…")).toBe(true);
  });
});

describe("per-tab selection", () => {
  const viewer = "aa";
  const contact = "bb";
  const agent = "cc";
  const stranger = "dd";
  const audience = pulseAudience({
    viewerPubkey: viewer,
    contactPubkeys: [contact],
    agentPubkeys: [agent],
    likedNoteIds: ["liked"],
  });
  const notes = [
    note({ id: "mine", pubkey: viewer }),
    note({ id: "contact", pubkey: contact }),
    note({ id: "agent", pubkey: agent }),
    note({ id: "liked", pubkey: stranger }),
  ];

  it("never invents a row: every result is one of the inputs", () => {
    for (const tab of PULSE_TABS.map((t) => t.id)) {
      for (const row of selectPulseNotes(tab, notes, audience)) {
        expect(notes).toContain(row);
      }
    }
  });

  it("narrows each tab to its own audience", () => {
    const ids = (tab: PulseTab) => selectPulseNotes(tab, notes, audience).map((n) => n.id);
    expect(ids("everyone")).toEqual(["mine", "contact", "agent", "liked"]);
    expect(ids("following")).toEqual(["contact"]);
    expect(ids("agents")).toEqual(["agent"]);
    expect(ids("mine")).toEqual(["mine"]);
    expect(ids("liked")).toEqual(["liked"]);
    // Not wired to a backend, and deliberately not the everyone feed.
    expect(ids("search")).toEqual([]);
  });

  it("keeps an unfollowed agent out of Following", () => {
    expect(
      selectPulseNotes("following", [note({ pubkey: agent })], audience),
    ).toEqual([]);
    const following = pulseAudience({
      viewerPubkey: viewer,
      contactPubkeys: [agent],
      agentPubkeys: [agent],
    });
    // …and lets it in once the viewer actually follows it.
    expect(selectPulseNotes("following", [note({ pubkey: agent })], following)).toHaveLength(1);
  });

  it("shows nobody's notes as 'mine' when the reader has no identity", () => {
    const anonymous = pulseAudience({});
    expect(selectPulseNotes("mine", [note({ pubkey: "" })], anonymous)).toEqual([]);
  });
});

describe("ordering", () => {
  it("sorts newest first and breaks a tie on id, in both input orders", () => {
    const rows = [
      note({ id: "b", createdAt: 100 }),
      note({ id: "a", createdAt: 100 }),
      note({ id: "c", createdAt: 200 }),
    ];
    const forwards = sortPulseNotes(rows).map((n) => n.id);
    const backwards = sortPulseNotes([...rows].reverse()).map((n) => n.id);
    expect(forwards).toEqual(["c", "a", "b"]);
    expect(forwards).toEqual(backwards);
  });
});

describe("agent note grouping", () => {
  const agent = "cc";
  const other = "dd";

  it("folds a burst into one card, anchored on the newest", () => {
    const rows = [
      note({ id: "n1", pubkey: agent, createdAt: 1000 }),
      note({ id: "n2", pubkey: agent, createdAt: 900 }),
      note({ id: "n3", pubkey: agent, createdAt: 800 }),
    ];
    const [group] = groupAgentNotes(rows);
    expect(group.notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(group.latestAt).toBe(1000);
    expect(group.earliestAt).toBe(800);
    expect(group.key).toBe(`${agent}-1000`);
  });

  it("measures the window from the anchor, so a card cannot grow without bound", () => {
    // Every consecutive gap is 200 s, well inside the window, so a chain
    // comparison would fold all four into one card spanning 600 s. Measured
    // from the anchor, the run closes at the first note more than 300 s from
    // it, and the next note anchors a new one.
    const rows = [
      note({ id: "n1", pubkey: agent, createdAt: 1000 }),
      note({ id: "n2", pubkey: agent, createdAt: 800 }),
      note({ id: "n3", pubkey: agent, createdAt: 600 }),
      note({ id: "n4", pubkey: agent, createdAt: 400 }),
    ];
    const groups = groupAgentNotes(rows, AGENT_NOTE_GROUP_WINDOW_SECONDS);
    expect(groups.map((g) => g.notes.map((n) => n.id))).toEqual([
      ["n1", "n2"],
      ["n3", "n4"],
    ]);
  });

  it("breaks a run on a different agent", () => {
    const groups = groupAgentNotes([
      note({ id: "n1", pubkey: agent, createdAt: 1000 }),
      note({ id: "n2", pubkey: other, createdAt: 990 }),
      note({ id: "n3", pubkey: agent, createdAt: 980 }),
    ]);
    expect(groups.map((g) => g.pubkey)).toEqual([agent, other, agent]);
  });

  it("absorbs older history rather than repartitioning what is on screen", () => {
    const page = [
      note({ id: "n1", pubkey: agent, createdAt: 1000 }),
      note({ id: "n2", pubkey: agent, createdAt: 950 }),
    ];
    const before = groupAgentNotes(page);
    // Paging older history appends notes at the end of a newest-first list.
    const older = [...page, note({ id: "n3", pubkey: agent, createdAt: 900 })];
    const after = groupAgentNotes(older);
    // The group that was already drawn keeps its identity and its anchor; the
    // older note joins it rather than re-splitting the run.
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].latestAt).toBe(before[0].latestAt);
    expect(after[0].notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);

    // A note far enough back opens a new group and still leaves the first alone.
    const muchOlder = [...older, note({ id: "n4", pubkey: agent, createdAt: 1 })];
    const last = groupAgentNotes(muchOlder);
    expect(last[0].key).toBe(before[0].key);
    expect(last).toHaveLength(2);
  });

  it("refuses to fold an out-of-order pair", () => {
    const groups = groupAgentNotes([
      note({ id: "n1", pubkey: agent, createdAt: 900 }),
      note({ id: "n2", pubkey: agent, createdAt: 1000 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("reactions", () => {
  it("counts only upvotes and dedupes by author", () => {
    const states = reactionStates(
      [
        note({ pubkey: "aa", content: "+", tags: [["e", "n1"]] }),
        note({ pubkey: "aa", content: "+", tags: [["e", "n1"]] }),
        note({ pubkey: "bb", content: "+", tags: [["e", "n1"]] }),
        note({ pubkey: "cc", content: "🔥", tags: [["e", "n1"]] }),
      ],
      "aa",
    );
    expect(states.get("n1")).toEqual({ count: 2, reactedByViewer: true });
  });

  it("takes the last e tag as the target, like the log's own derivation", () => {
    const states = reactionStates(
      [note({ pubkey: "bb", content: "+", tags: [["e", "root"], ["e", "n2"]] })],
      "aa",
    );
    expect(states.get("n2")?.count).toBe(1);
    expect(states.has("root")).toBe(false);
  });

  it("clamps the optimistic count at zero and is idempotent", () => {
    expect(applyReactionState(undefined, true)).toEqual({ count: 1, reactedByViewer: true });
    expect(applyReactionState({ count: 0, reactedByViewer: true }, false)).toEqual({
      count: 0,
      reactedByViewer: false,
    });
    const on = { count: 3, reactedByViewer: true };
    expect(applyReactionState(on, true)).toBe(on);
  });

  it("toggles an id without mutating the set it was given", () => {
    const set = new Set(["a"]);
    expect([...toggleNoteIdInSet(set, "b")]).toEqual(["a", "b"]);
    expect([...toggleNoteIdInSet(set, "a")]).toEqual([]);
    expect([...set]).toEqual(["a"]);
  });
});

describe("freshness", () => {
  it("does not poll a hidden document", () => {
    expect(visibleRefetchInterval(30_000, true)).toBe(30_000);
    expect(visibleRefetchInterval(30_000, false)).toBe(false);
  });

  it("keys a feed by a sorted set so re-rendering cannot cause a refetch storm", () => {
    expect(pulseQueryKey("agents", ["b", "a"])).toBe(pulseQueryKey("agents", ["a", "b"]));
    expect(pulseQueryKey("agents", ["a"])).not.toBe(pulseQueryKey("mine", ["a"]));
  });
});

describe("projectPulse", () => {
  it("sorts before folding, so a caller cannot get one card per note", () => {
    const agent = "cc";
    const audience = pulseAudience({ agentPubkeys: [agent] });
    const unsorted = [
      note({ id: "n2", pubkey: agent, createdAt: 900 }),
      note({ id: "n1", pubkey: agent, createdAt: 1000 }),
    ];
    const feed = projectPulse("agents", unsorted, [], audience);
    expect(feed.notes).toEqual([]);
    expect(feed.groups).toHaveLength(1);
    expect(feed.groups[0].notes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

// ---------------------------------------------------------------------------
// The feed: a view over the log, and nothing else
// ---------------------------------------------------------------------------

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
        pubkey: pubkeyOf(person),
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
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Beta",
      slug: "beta",
      ownerClerkId: BOB.subject,
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
    await ctx.db.insert("memberships", {
      userClerkId: BOB.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });
    return { workspaceId, otherWorkspaceId };
  });
  return {
    t,
    scope: { scopeType: "workspace", scopeId: ids.workspaceId } as Scope,
    otherScope: { scopeType: "workspace", scopeId: ids.otherWorkspaceId } as Scope,
  };
}

async function postNote(
  t: Harness,
  scope: Scope,
  body: string,
  as: { subject: string },
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(pulse.post, { ...scope, body })) as { eventId: string };
  return result.eventId;
}

async function feed(
  t: Harness,
  scope: Scope,
  tab: PulseTab,
  as: { subject: string },
): Promise<Feed> {
  return (await t.withIdentity(as).query(pulse.feed, { ...scope, tab })) as Feed;
}

describe("the pulse feed", () => {
  it("returns exactly what is in the log, and never invents a row", async () => {
    const { t, scope } = await seed();
    const first = await postNote(t, scope, "hello world", ALICE);
    const second = await postNote(t, scope, "second", BOB);

    const result = await feed(t, scope, "everyone", CAROL);
    const stored = await t.run(async (ctx: Ctx) =>
      (await ctx.db.query("buzzEvents").collect()).filter((e) => e.kind === 1),
    );
    expect(result.notes.map((n) => n.id).sort()).toEqual(
      stored.map((e) => e.eventId).sort(),
    );
    expect(result.notes.map((n) => n.id)).toContain(first);
    expect(result.notes.map((n) => n.id)).toContain(second);
    // Nothing is stored *for* the feed: there is one note per published event.
    expect(stored).toHaveLength(2);
  });

  it("never reaches into a room, however the tab is shaped", async () => {
    const { t, scope } = await seed();
    const channelId = (
      (await t
        .withIdentity(ALICE)
        .mutation(channels.create, { ...scope, name: "secret", visibility: "private" })) as {
        channelId: string;
      }
    ).channelId;
    const inRoom = (
      (await t
        .withIdentity(ALICE)
        .mutation(messages.post, { ...scope, channelId, body: "the acquisition price" })) as {
        eventId: string;
      }
    ).eventId;
    await postNote(t, scope, "public note", ALICE);

    for (const tab of ["everyone", "mine"] as PulseTab[]) {
      const result = await feed(t, scope, tab, ALICE);
      expect(result.notes.map((n) => n.id)).not.toContain(inRoom);
      expect(JSON.stringify(result)).not.toContain("acquisition");
    }
  }, 20000);

  it("fences the feed to its community", async () => {
    const { t, scope, otherScope } = await seed();
    await postNote(t, scope, "acme only", ALICE);
    await expect(feed(t, scope, "everyone", OUTSIDER)).rejects.toThrow(/Forbidden/);
    const beta = await feed(t, otherScope, "everyone", BOB);
    expect(beta.notes).toEqual([]);
  });

  it("narrows Mine to the reader and Search to nothing", async () => {
    const { t, scope } = await seed();
    const mine = await postNote(t, scope, "mine", ALICE);
    await postNote(t, scope, "theirs", BOB);

    const own = await feed(t, scope, "mine", ALICE);
    expect(own.notes.map((n) => n.id)).toEqual([mine]);
    const search = await feed(t, scope, "search", ALICE);
    expect(search.notes).toEqual([]);
  });

  it("follows a contact list, and returns nothing when there is none", async () => {
    const { t, scope } = await seed();
    await postNote(t, scope, "from bob", BOB);
    const empty = await feed(t, scope, "following", ALICE);
    expect(empty.contactPubkeys).toEqual([]);
    expect(empty.notes).toEqual([]);

    // NIP-02: one replaceable kind-3 naming who you follow.
    await t.withIdentity(ALICE).mutation(anyApi.buzz.log.publish, {
      ...scope,
      kind: 3,
      tags: [["p", pubkeyOf(BOB)]],
      content: "",
    });
    const following = await feed(t, scope, "following", ALICE);
    expect(following.contactPubkeys).toEqual([pubkeyOf(BOB)]);
    expect(following.notes).toHaveLength(1);
    expect(following.notes[0].pubkey).toBe(pubkeyOf(BOB));
  });

  it("resolves a name for every pubkey on screen, once", async () => {
    const { t, scope } = await seed();
    await postNote(t, scope, "one", ALICE);
    await postNote(t, scope, "two", ALICE);
    const result = await feed(t, scope, "everyone", ALICE);
    expect(result.authors.filter((a) => a.pubkey === pubkeyOf(ALICE))).toHaveLength(1);
    expect(result.authors[0].name).toBe(ALICE.subject);
  });
});

describe("upvoting", () => {
  it("is idempotent in both directions and drives the Liked tab", async () => {
    const { t, scope } = await seed();
    const noteId = await postNote(t, scope, "worth reading", ALICE);

    const first = await t
      .withIdentity(BOB)
      .mutation(pulse.upvote, { ...scope, noteId, on: true });
    const again = await t
      .withIdentity(BOB)
      .mutation(pulse.upvote, { ...scope, noteId, on: true });
    expect(first).toEqual({ reacted: true, changed: true });
    expect(again).toEqual({ reacted: true, changed: false });

    const liked = await feed(t, scope, "liked", BOB);
    expect(liked.likedNoteIds).toEqual([noteId]);
    expect(liked.notes.map((n) => n.id)).toEqual([noteId]);
    // The count the pill draws comes from the same events, folded purely.
    const states = reactionStates(
      liked.reactions.map((r) => ({
        id: r.id,
        pubkey: r.pubkey,
        createdAt: r.created_at,
        content: r.content,
        tags: r.tags,
      })),
      pubkeyOf(BOB),
    );
    expect(states.get(noteId)).toEqual({ count: 1, reactedByViewer: true });

    const off = await t
      .withIdentity(BOB)
      .mutation(pulse.upvote, { ...scope, noteId, on: false });
    const offAgain = await t
      .withIdentity(BOB)
      .mutation(pulse.upvote, { ...scope, noteId, on: false });
    expect(off).toEqual({ reacted: false, changed: true });
    expect(offAgain).toEqual({ reacted: false, changed: false });
    const after = await feed(t, scope, "liked", BOB);
    expect(after.likedNoteIds).toEqual([]);
  }, 20000);

  it("refuses to react to something the reader cannot read", async () => {
    const { t, scope } = await seed();
    const channelId = (
      (await t
        .withIdentity(ALICE)
        .mutation(channels.create, { ...scope, name: "secret", visibility: "private" })) as {
        channelId: string;
      }
    ).channelId;
    const inRoom = (
      (await t
        .withIdentity(ALICE)
        .mutation(messages.post, { ...scope, channelId, body: "private" })) as {
        eventId: string;
      }
    ).eventId;
    await expect(
      t.withIdentity(BOB).mutation(pulse.upvote, { ...scope, noteId: inRoom, on: true }),
    ).rejects.toThrow(/could not be found/);
  }, 20000);
});

describe("posting a note", () => {
  it("refuses an empty body and tags mentions server-side", async () => {
    const { t, scope } = await seed();
    await expect(
      t.withIdentity(ALICE).mutation(pulse.post, { ...scope, body: "   " }),
    ).rejects.toThrow(/needs something in it/);

    const eventId = await postNote(t, scope, `hi @[Bob](${BOB.subject})`, ALICE);
    const stored = await t.run(async (ctx: Ctx) =>
      (await ctx.db.query("buzzEvents").collect()).find((e) => e.eventId === eventId),
    );
    // The `p` tag is derived from the body, never accepted from the client.
    expect(stored?.tags).toContainEqual(["p", pubkeyOf(BOB)]);
    // Global: a note has no room, which is what makes it a note.
    expect(stored?.channelId).toBeUndefined();
  });
});
