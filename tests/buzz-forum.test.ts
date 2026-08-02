import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { KINDS, SEARCHABLE_KINDS } from "../convex/buzz/_kinds";
import {
  KIND_FORUM_COMMENT as SERVER_COMMENT_KIND,
  KIND_FORUM_POST as SERVER_POST_KIND,
  KIND_FORUM_VOTE,
  MAX_TITLE_CHARS as SERVER_MAX_TITLE,
  SUBJECT_TAG as SERVER_SUBJECT_TAG,
  normalizeTitle,
  subjectTags,
  titleFromTags as serverTitleFromTags,
} from "../convex/buzz/forum";
import {
  FORUM_LIST_KINDS,
  FORUM_THREAD_KINDS,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  MAX_TITLE_CHARS,
  PREVIEW_CHARS,
  SUBJECT_TAG,
  buildForumCards,
  compareForumCards,
  forumPostHref,
  isForumSort,
  lastActivityOf,
  previewOf,
  replyCountLabel,
  sortForumCards,
  titleFromTags,
  type ForumCard,
  type ForumSummary,
} from "../src/components/chat/forum/model";
import {
  TIMELINE_CONTENT_KINDS,
  formatTimelineMessages,
  projectTimeline,
  type TimelineEvent,
} from "../src/lib/buzz/timeline";
import type { ChatMessage } from "../src/lib/buzz/message-types";

// The forum's contract.
//
// The claim this file exists to prove is one sentence: **a forum post is a
// message with a different kind**, so reactions, editing and deletion come free
// through the message paths rather than being written a second time. "Come free"
// is not a thing a comment can assert, so the tests below actually drive
// `buzz/messages:react`, `:edit` and `:remove` against a post and a comment and
// look at what the log says afterwards.
//
// The other half is the separation the same sentence creates. A post is *not* a
// row in the chat transcript, and the two views of one forum room must not leak
// into each other in either direction — so there are assertions from both sides:
// a chat message never appears in the post list, and a post never draws a row in
// the projected transcript.
//
// `anyApi` rather than the generated `api`, for the reason the other buzz suites
// state: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const forum = anyApi.buzz.forum;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
type PostsPage = {
  events: Event[];
  summaries: ForumSummary[];
  actors: { pubkey: string; label: string; isAgent: boolean }[];
  nextCursor?: string;
};
type ThreadPage = {
  events: Event[];
  actors: { pubkey: string; label: string; isAgent: boolean }[];
  nextCursor?: string;
};

const KIND_MESSAGE = 9;
const KIND_EDIT = 40003;
const KIND_REACTION = 7;

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

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
        pubkey: publicKeyFromSecret(KEYS[person.subject]),
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
      ownerClerkId: ALICE.subject,
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
      userClerkId: ALICE.subject,
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

type Harness = ReturnType<typeof convexTest>;

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function createChannel(
  t: Harness,
  scope: Scope,
  args: Record<string, unknown>,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, ...args })) as { channelId: string };
  return result.channelId;
}

async function createForum(t: Harness, scope: Scope, name = "proposals"): Promise<string> {
  return await createChannel(t, scope, { name, channelType: "forum" });
}

async function createPost(
  t: Harness,
  scope: Scope,
  channelId: string,
  title: string,
  body: string,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(forum.createPost, { ...scope, channelId, title, body })) as {
    eventId: string;
  };
  return result.eventId;
}

async function comment(
  t: Harness,
  scope: Scope,
  channelId: string,
  parentId: string,
  body: string,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(forum.comment, { ...scope, channelId, parentId, body })) as {
    eventId: string;
  };
  return result.eventId;
}

async function posts(
  t: Harness,
  scope: Scope,
  channelId: string,
  as = ALICE,
  extra: Record<string, unknown> = {},
): Promise<PostsPage> {
  return (await t
    .withIdentity(as)
    .query(forum.posts, { ...scope, channelId, ...extra })) as PostsPage;
}

async function readPost(
  t: Harness,
  scope: Scope,
  channelId: string,
  postId: string,
  as = ALICE,
): Promise<ThreadPage> {
  return (await t
    .withIdentity(as)
    .query(forum.post, { ...scope, channelId, postId })) as ThreadPage;
}

/** The events of a page, folded exactly as the surface folds them. */
function cardsOf(page: PostsPage, self?: string): ForumCard[] {
  const messages = formatTimelineMessages(page.events as TimelineEvent[], {
    ...(self ? { selfPubkey: self } : {}),
    contentKinds: FORUM_LIST_KINDS,
  });
  return buildForumCards(messages, page.summaries);
}

function of(page: { events: Event[] }, kind: number): Event[] {
  return page.events.filter((event) => event.kind === kind);
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

// ---------------------------------------------------------------------------
// The vocabulary — one copy of each number, asserted rather than trusted
// ---------------------------------------------------------------------------

describe("the forum kinds", () => {
  it("agree across the registry, the server and the client model", () => {
    // Three files hold these numbers, for reasons each of them documents (the
    // registry is the authority, the server module names them at its call
    // sites, and the client restates them so a browser does not download a
    // signing library to draw a card). Documented duplication is still
    // duplication, so it is pinned here.
    expect(SERVER_POST_KIND).toBe(45001);
    expect(SERVER_COMMENT_KIND).toBe(45003);
    expect(KIND_FORUM_VOTE).toBe(45002);
    expect(KIND_FORUM_POST).toBe(SERVER_POST_KIND);
    expect(KIND_FORUM_COMMENT).toBe(SERVER_COMMENT_KIND);
    expect(SUBJECT_TAG).toBe(SERVER_SUBJECT_TAG);
    expect(MAX_TITLE_CHARS).toBe(SERVER_MAX_TITLE);

    expect(KINDS.get(45001)?.name).toBe("KIND_FORUM_POST");
    expect(KINDS.get(45003)?.name).toBe("KIND_FORUM_COMMENT");
    // Channel-scoped: a post with no room would be stored community-global and
    // readable by everybody, which is the opposite of what a room's forum means.
    expect(KINDS.get(45001)?.scope).toBe("required");
    expect(KINDS.get(45003)?.scope).toBe("required");
    // Regular storage: a post is not replaceable, so an edit is a 40003 overlay
    // and the original stays in the log.
    expect(KINDS.get(45001)?.storage).toBe("regular");
    // Findable: a post exists to be read later, which means found later.
    expect(SEARCHABLE_KINDS.has(45001)).toBe(true);
    expect(SEARCHABLE_KINDS.has(45003)).toBe(true);
  });

  it("keeps the chat transcript's content set disjoint from the forum's", () => {
    // The whole of "the two views do not leak into each other", as a property of
    // two sets rather than of a filter somebody remembers to apply.
    for (const kind of FORUM_THREAD_KINDS) {
      expect(TIMELINE_CONTENT_KINDS.has(kind)).toBe(false);
    }
    expect(FORUM_LIST_KINDS.has(KIND_FORUM_COMMENT)).toBe(false);
    expect(FORUM_THREAD_KINDS.has(KIND_FORUM_COMMENT)).toBe(true);
    expect(FORUM_LIST_KINDS.has(KIND_MESSAGE)).toBe(false);
    expect(FORUM_THREAD_KINDS.has(KIND_MESSAGE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Titles and previews — pure
// ---------------------------------------------------------------------------

describe("titles", () => {
  it("collapses whitespace, trims and caps", () => {
    expect(normalizeTitle("  The   migration\nplan  ")).toBe("The migration plan");
    expect(normalizeTitle("x".repeat(400))).toHaveLength(MAX_TITLE_CHARS);
    expect(normalizeTitle("   ")).toBe("");
  });

  it("round-trips through the tag, and the FIRST tag wins", () => {
    const tags = subjectTags("Ship it");
    expect(tags).toEqual([["subject", "Ship it"]]);
    expect(serverTitleFromTags(tags)).toBe("Ship it");
    expect(titleFromTags(tags)).toBe("Ship it");

    // An author who can append a second subject tag must not get to choose which
    // one a reader believes — same rule the thread markers follow.
    const doubled = [["subject", "Real"], ["subject", "Fake"]];
    expect(serverTitleFromTags(doubled)).toBe("Real");
    expect(titleFromTags(doubled)).toBe("Real");
  });

  it("has no title rather than inventing one", () => {
    expect(titleFromTags([["h", "chan"]])).toBe("");
    expect(serverTitleFromTags([])).toBe("");
  });
});

describe("previews", () => {
  it("keeps a short body whole and flattens its whitespace", () => {
    expect(previewOf("one\n\ntwo   three")).toBe("one two three");
    expect(previewOf("   ")).toBe("");
  });

  it("cuts at PREVIEW_CHARS characters and marks the cut", () => {
    const preview = previewOf("a".repeat(PREVIEW_CHARS + 50));
    expect([...preview]).toHaveLength(PREVIEW_CHARS + 1);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    // `slice` on a body that reaches the cut inside an astral character emits
    // half a surrogate pair, which renders as a replacement glyph on exactly the
    // one card that happened to be that long.
    const preview = previewOf("🙂".repeat(PREVIEW_CHARS + 10));
    expect([...preview].slice(0, PREVIEW_CHARS).every((c) => c === "🙂")).toBe(true);
    expect(preview).not.toContain("�");
  });
});

// ---------------------------------------------------------------------------
// Sorting — pure, and the property is that it is total
// ---------------------------------------------------------------------------

function card(
  id: string,
  createdAt: number,
  summary?: Partial<ForumSummary>,
): ForumCard {
  const message = {
    id,
    renderKey: id,
    createdAt,
    pubkey: "aa",
    signerPubkey: "aa",
    author: "Ada",
    isAgent: false,
    body: "body",
    tags: [["subject", id]],
    kind: KIND_FORUM_POST,
    depth: 0,
    edited: false,
    pending: false,
    mine: false,
    reactions: [],
  } satisfies ChatMessage;
  return {
    message,
    title: id,
    preview: "body",
    summary: summary
      ? {
          postId: id,
          replyCount: 0,
          lastReplyAt: 0,
          participants: [],
          capped: false,
          ...summary,
        }
      : null,
  };
}

const ids = (cards: readonly ForumCard[]) => cards.map((c) => c.message.id);

describe("sorting", () => {
  const older = card("aaa", 100);
  const newer = card("bbb", 300);
  const busy = card("ccc", 200, { replyCount: 9, lastReplyAt: 150 });
  const revived = card("ddd", 50, { replyCount: 1, lastReplyAt: 900 });
  const all = [older, newer, busy, revived];

  it("latest is newest-first", () => {
    expect(ids(sortForumCards(all, "latest"))).toEqual(["bbb", "ccc", "aaa", "ddd"]);
  });

  it("active ranks by the last thing that happened, not by creation", () => {
    // `revived` is the oldest post and the most alive one; a forum that could
    // not say so would be a list of things nobody is talking about.
    expect(ids(sortForumCards(all, "active"))).toEqual(["ddd", "bbb", "ccc", "aaa"]);
  });

  it("active treats a post with no replies as active when it was written", () => {
    // Falling back to `createdAt` rather than 0 is what makes this a complete
    // order: otherwise a brand-new forum sorts entirely below one old post that
    // once got a reply, and reads as empty.
    expect(lastActivityOf(older)).toBe(100);
    expect(lastActivityOf(revived)).toBe(900);
    expect(ids(sortForumCards([older, newer], "active"))).toEqual(["bbb", "aaa"]);
  });

  it("top ranks by reply count and falls back to recency", () => {
    expect(ids(sortForumCards(all, "top"))).toEqual(["ccc", "ddd", "bbb", "aaa"]);
  });

  it("is deterministic when everything ties, whatever order it arrives in", () => {
    // `createdAt` is Nostr seconds, so a tie is routine. Without the event-id
    // tie-break the same two cards land in different positions depending on
    // whether history or the live subscription delivered first — which the
    // reader sees as a list reshuffling itself while they look at it.
    const tied = [card("ccc", 500), card("aaa", 500), card("bbb", 500)];
    for (const sort of ["latest", "active", "top"] as const) {
      expect(ids(sortForumCards(tied, sort))).toEqual(["aaa", "bbb", "ccc"]);
      expect(ids(sortForumCards([...tied].reverse(), sort))).toEqual(["aaa", "bbb", "ccc"]);
    }
  });

  it("does not mutate the array it was given", () => {
    const input = [newer, older];
    sortForumCards(input, "latest");
    expect(ids(input)).toEqual(["bbb", "aaa"]);
  });

  it("compares to zero only for genuinely identical cards", () => {
    const compare = compareForumCards("latest");
    expect(compare(older, older)).toBe(0);
    expect(compare(older, newer)).toBeGreaterThan(0);
    expect(compare(newer, older)).toBeLessThan(0);
  });

  it("knows its own vocabulary and nothing else", () => {
    expect(isForumSort("active")).toBe(true);
    expect(isForumSort("popular")).toBe(false);
    expect(isForumSort(null)).toBe(false);
  });
});

describe("labels and routes", () => {
  it("says how many replies, and says so honestly when the scan capped", () => {
    const base = { postId: "p", lastReplyAt: 0, participants: [], capped: false };
    expect(replyCountLabel({ ...base, replyCount: 1 })).toBe("1 reply");
    expect(replyCountLabel({ ...base, replyCount: 4 })).toBe("4 replies");
    // A number that silently stops at the cap lies at exactly the sizes where it
    // matters, so the cap is shown rather than hidden.
    expect(replyCountLabel({ ...base, replyCount: 60, capped: true })).toBe("60+ replies");
  });

  it("puts a post under its channel", () => {
    expect(forumPostHref("chan id", "post id")).toBe("/chat/c/chan%20id/p/post%20id");
  });
});

// ---------------------------------------------------------------------------
// A post is a message
// ---------------------------------------------------------------------------

describe("creating a post", () => {
  it("writes one 45001 carrying the title as a tag and the body as content", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "  The  migration ", "Body text");

    const page = await posts(t, scope, channelId);
    const written = of(page, KIND_FORUM_POST);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe(postId);
    expect(written[0].content).toBe("Body text");
    expect(tagValue(written[0], "subject")).toBe("The migration");
    // The message grammar's own tags are still there and still first: the room,
    // and the author's self-tag.
    expect(written[0].tags.slice(0, 2)).toEqual([
      ["p", pubkeyOf(ALICE)],
      ["h", channelId],
    ]);
    expect(written[0].pubkey).toBe(pubkeyOf(ALICE));
  });

  it("refuses a post with no title", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await expect(
      t.withIdentity(ALICE).mutation(forum.createPost, {
        ...scope,
        channelId,
        title: "   ",
        body: "words",
      }),
    ).rejects.toThrow(/needs a title/i);
  });

  it("refuses a post in a room that is not a forum", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(forum.createPost, { ...scope, channelId, title: "T", body: "B" }),
    ).rejects.toThrow(/not a forum/i);
    // And the reading side agrees, rather than answering with an empty list — an
    // empty list says the room has a post view nobody has used.
    await expect(
      t.withIdentity(ALICE).query(forum.posts, { ...scope, channelId }),
    ).rejects.toThrow(/not a forum/i);
  });

  it("parses mentions out of the body, exactly as a message does", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await createPost(t, scope, channelId, "Question", `ping @[Bob](${BOB.subject})`);

    const page = await posts(t, scope, channelId);
    const written = of(page, KIND_FORUM_POST)[0];
    // The tag is what wakes somebody up. A post whose body says "@Bob" while the
    // event names nobody is a notification that silently never arrives — the
    // exact failure a second write path would have produced.
    expect(written.tags).toContainEqual(["p", pubkeyOf(BOB)]);
  });

  it("refuses an archived forum and a non-member", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    // Carol is in the community and not in the room: open means readable, not
    // writable, and that is `postMessageCore`'s rule rather than a new one.
    await expect(
      t
        .withIdentity(CAROL)
        .mutation(forum.createPost, { ...scope, channelId, title: "T", body: "B" }),
    ).rejects.toThrow(/Join this channel/);

    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(forum.createPost, { ...scope, channelId, title: "T", body: "B" }),
    ).rejects.toThrow(/archived/i);
  });
});

// ---------------------------------------------------------------------------
// The tenancy fence
// ---------------------------------------------------------------------------

describe("access", () => {
  it("refuses somebody outside the community entirely", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "T", "B");
    const outsider = t.withIdentity(OUTSIDER);

    await expect(outsider.query(forum.posts, { ...scope, channelId })).rejects.toThrow(
      /Forbidden/,
    );
    await expect(
      outsider.query(forum.post, { ...scope, channelId, postId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      outsider.mutation(forum.createPost, { ...scope, channelId, title: "T", body: "B" }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("fences one community's forum off from another's scope", async () => {
    const { t, scope, otherScope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "Acme only", "secret");

    // Alice owns both workspaces, so this is not an authentication failure: it
    // is the channel id failing to resolve outside the community that holds it.
    await expect(
      t.withIdentity(ALICE).query(forum.posts, { ...otherScope, channelId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t.withIdentity(ALICE).query(forum.post, { ...otherScope, channelId, postId }),
    ).rejects.toThrow(/not found/i);
  });

  it("hides a private forum from a community member who is not in it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, {
      name: "acquisition",
      channelType: "forum",
      visibility: "private",
    });
    const postId = await createPost(t, scope, channelId, "The number", "40");

    // "Not found", not "forbidden": whether the room exists is itself the thing
    // being kept.
    await expect(
      t.withIdentity(BOB).query(forum.posts, { ...scope, channelId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t.withIdentity(BOB).query(forum.post, { ...scope, channelId, postId }),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a community member read an open forum without joining it", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "Open question", "anyone?");

    const page = await posts(t, scope, channelId, CAROL);
    expect(of(page, KIND_FORUM_POST).map((e) => e.id)).toEqual([postId]);
  });
});

// ---------------------------------------------------------------------------
// The two views of one room
// ---------------------------------------------------------------------------

describe("the chat view and the post view", () => {
  it("keeps a chat message out of the post list", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId, body: "back in ten" });
    const postId = await createPost(t, scope, channelId, "The plan", "…");

    const page = await posts(t, scope, channelId);
    // The index range asks for one kind, so the chat message is not even in the
    // window — there is no filter here that could be forgotten.
    expect(of(page, KIND_MESSAGE)).toHaveLength(0);
    expect(cardsOf(page).map((c) => c.message.id)).toEqual([postId]);
  });

  it("keeps a post out of the chat transcript", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const said = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId, body: "back in ten" })) as {
      eventId: string;
    };
    const postId = await createPost(t, scope, channelId, "The plan", "…");

    const window = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as { events: Event[] };
    // The post is in the room's log — it is a message, after all — and the
    // projector is what refuses to draw it, because 45001 is not a chat content
    // kind. Asserting the *rows* rather than the events is the honest test: the
    // reader sees rows.
    expect(window.events.some((e) => e.id === postId)).toBe(true);
    const rows = projectTimeline(window.events as TimelineEvent[], {});
    const drawn = rows.flatMap((row) => (row.type === "message" ? [row.message.id] : []));
    expect(drawn).toContain(said.eventId);
    expect(drawn).not.toContain(postId);
  });

  it("answers 'not found' when a chat message id is opened as a post", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const said = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId, body: "hello" })) as {
      eventId: string;
    };

    await expect(
      t
        .withIdentity(ALICE)
        .query(forum.post, { ...scope, channelId, postId: said.eventId }),
    ).rejects.toThrow(/Post not found/);
  });

  it("refuses a chat reply to a post and a forum comment on a chat message", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    const said = (await t
      .withIdentity(ALICE)
      .mutation(messages.post, { ...scope, channelId, body: "hello" })) as {
      eventId: string;
    };

    // Both directions, because both would produce a row that one surface draws
    // in the wrong place and the other does not draw at all.
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(messages.post, { ...scope, channelId, body: "me too", parentId: postId }),
    ).rejects.toThrow(/buzz\.forum\.comment/);
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(forum.comment, { ...scope, channelId, body: "me too", parentId: said.eventId }),
    ).rejects.toThrow(/only be filed under a forum post/);
  });

  it("refuses a comment with nothing to comment on", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await expect(
      t.withIdentity(ALICE).mutation(forum.comment, { ...scope, channelId, body: "hi" }),
    ).rejects.toThrow(/needs the post/i);
  });
});

// ---------------------------------------------------------------------------
// Comments thread
// ---------------------------------------------------------------------------

describe("comments", () => {
  it("files a comment under the post with the thread markers a reply carries", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    // Bob joins first: an open room is readable by the community and writable by
    // its members, and a comment is a write like any other.
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    const first = await comment(t, scope, channelId, postId, "agreed", BOB);

    const thread = await readPost(t, scope, channelId, postId);
    const written = of(thread, KIND_FORUM_COMMENT);
    expect(written.map((e) => e.id)).toEqual([first]);
    // A direct reply names its root once, as `messageTags` says it should.
    expect(written[0].tags.filter((tag) => tag[0] === "e")).toEqual([
      ["e", postId, "", "reply"],
    ]);
  });

  it("keeps a nested comment in the same thread rather than starting a second", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    const first = await comment(t, scope, channelId, postId, "agreed", BOB);
    const nested = await comment(t, scope, channelId, first, "why?", ALICE);

    const thread = await readPost(t, scope, channelId, postId);
    const deep = of(thread, KIND_FORUM_COMMENT).find((e) => e.id === nested);
    expect(deep?.tags.filter((tag) => tag[0] === "e")).toEqual([
      ["e", postId, "", "root"],
      ["e", first, "", "reply"],
    ]);
    // One index range on `#e = postId` returns the whole subtree, because every
    // reply carries the root. The head comes back on the first page.
    expect(thread.events.some((e) => e.id === postId)).toBe(true);
    expect(of(thread, KIND_FORUM_COMMENT)).toHaveLength(2);

    // And the projector renders all three, at the depths the tags describe.
    const drawn = formatTimelineMessages(thread.events as TimelineEvent[], {
      contentKinds: FORUM_THREAD_KINDS,
    });
    expect(drawn.find((m) => m.id === postId)?.depth).toBe(0);
    expect(drawn.find((m) => m.id === first)?.depth).toBe(1);
    expect(drawn.find((m) => m.id === nested)?.depth).toBe(2);
  });

  it("refuses a rootId that disagrees with the parent's thread", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const one = await createPost(t, scope, channelId, "One", "…");
    const two = await createPost(t, scope, channelId, "Two", "…");
    await expect(
      t.withIdentity(ALICE).mutation(forum.comment, {
        ...scope,
        channelId,
        body: "misfiled",
        parentId: one,
        rootId: two,
      }),
    ).rejects.toThrow(/root does not match/i);
  });

  it("rolls a post's comments up into the card's summary", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    const first = await comment(t, scope, channelId, postId, "agreed", BOB);
    await comment(t, scope, channelId, first, "why?", ALICE);

    const page = await posts(t, scope, channelId);
    expect(page.summaries).toHaveLength(1);
    const summary = page.summaries[0];
    // The whole subtree, not just direct children: "2 comments" is the number a
    // reader is deciding whether to open the post on.
    expect(summary.postId).toBe(postId);
    expect(summary.replyCount).toBe(2);
    expect(summary.capped).toBe(false);
    expect(summary.lastReplyAt).toBeGreaterThan(0);
    expect(new Set(summary.participants)).toEqual(
      new Set([pubkeyOf(ALICE), pubkeyOf(BOB)]),
    );
    // And the names come back with the page, so the card is not a row of hex.
    const labels = new Map(page.actors.map((a) => [a.pubkey, a.label]));
    expect(labels.get(pubkeyOf(BOB))).toBe(BOB.subject);
  });

  it("has no summary at all for a post nobody answered", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await createPost(t, scope, channelId, "Silence", "…");
    const page = await posts(t, scope, channelId);
    // Null rather than a zero: the card draws no footer, rather than a footer
    // announcing that nothing happened.
    expect(page.summaries).toEqual([]);
    expect(cardsOf(page)[0].summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reactions, editing and deletion — proven, not asserted
// ---------------------------------------------------------------------------

describe("what comes free from the message paths", () => {
  it("reacts to a post through buzz/messages:react and folds the pill", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t
      .withIdentity(BOB)
      .mutation(messages.react, { ...scope, channelId, targetId: postId, emoji: "👍" });

    const page = await posts(t, scope, channelId);
    // The reaction rides back with the page as an aux event, and the same
    // projector the transcript uses folds it into a pill. Nothing in `forum.ts`
    // knows what a reaction is.
    expect(of(page, KIND_REACTION)).toHaveLength(1);
    const card = cardsOf(page, pubkeyOf(BOB))[0];
    expect(card.message.reactions).toHaveLength(1);
    expect(card.message.reactions[0]).toMatchObject({ emoji: "👍", count: 1, mine: true });

    // And taking it back is the same door.
    await t
      .withIdentity(BOB)
      .mutation(messages.unreact, { ...scope, channelId, targetId: postId, emoji: "👍" });
    expect(cardsOf(await posts(t, scope, channelId))[0].message.reactions).toEqual([]);
  });

  it("edits a post through buzz/messages:edit and shows the new text", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "teh body");
    await t
      .withIdentity(ALICE)
      .mutation(messages.edit, { ...scope, channelId, targetId: postId, body: "the body" });

    const page = await posts(t, scope, channelId);
    expect(of(page, KIND_EDIT)).toHaveLength(1);
    const card = cardsOf(page)[0];
    expect(card.message.body).toBe("the body");
    expect(card.message.edited).toBe(true);
    expect(card.preview).toBe("the body");
    // The title survives an edit: a 40003 carries no subject tag, and the
    // overlay keeps every non-media tag the original had. A post that renamed
    // itself whenever somebody fixed a typo would be a post nobody could find
    // again.
    expect(card.title).toBe("The plan");
  });

  it("refuses an edit by somebody who did not write the post", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "mine");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await expect(
      t
        .withIdentity(BOB)
        .mutation(messages.edit, { ...scope, channelId, targetId: postId, body: "not yours" }),
    ).rejects.toThrow(/Only the author/);
  });

  it("deletes a post through buzz/messages:remove and stops serving it", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const keep = await createPost(t, scope, channelId, "Keep", "…");
    const drop = await createPost(t, scope, channelId, "Drop", "secret");
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: drop });

    const page = await posts(t, scope, channelId);
    // Absent, not tombstoned: a deleted post's content stops being served at
    // all, rather than being served and hidden by a client.
    expect(of(page, KIND_FORUM_POST).map((e) => e.id)).toEqual([keep]);
    expect(page.events.some((e) => e.content === "secret")).toBe(false);
    await expect(
      t.withIdentity(ALICE).query(forum.post, { ...scope, channelId, postId: drop }),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a room admin remove somebody else's post", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    const postId = await createPost(t, scope, channelId, "Off topic", "…", BOB);

    // Alice owns the room. Moderation is the message path's rule, unchanged.
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: postId });
    expect(of(await posts(t, scope, channelId), KIND_FORUM_POST)).toHaveLength(0);
  });

  it("drops a deleted comment out of the count as well as out of the thread", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const postId = await createPost(t, scope, channelId, "The plan", "…");
    const first = await comment(t, scope, channelId, postId, "one", ALICE);
    await comment(t, scope, channelId, postId, "two", ALICE);
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: first });

    // The tag index still holds a row for the deleted comment; the summary reads
    // the events, so "2 replies" does not outlive the two replies.
    const page = await posts(t, scope, channelId);
    expect(page.summaries[0].replyCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe("paging", () => {
  it("hands back a cursor and never repeats a post across pages", async () => {
    const { t, scope } = await seed();
    const channelId = await createForum(t, scope);
    const written: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      written.push(await createPost(t, scope, channelId, `Post ${i}`, `body ${i}`));
    }

    const first = await posts(t, scope, channelId, ALICE, { limit: 2 });
    expect(of(first, KIND_FORUM_POST)).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const seen = new Set(of(first, KIND_FORUM_POST).map((e) => e.id));
    let cursor = first.nextCursor;
    // Bounded: five posts at two a page is three pages, and a loop that could
    // run forever is the bug a cursor test exists to catch.
    for (let page = 0; page < 5 && cursor; page += 1) {
      const next = await posts(t, scope, channelId, ALICE, { limit: 2, cursor });
      for (const event of of(next, KIND_FORUM_POST)) {
        expect(seen.has(event.id)).toBe(false);
        seen.add(event.id);
      }
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(new Set(written));
  });
});
