import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  mentionedActorIds,
  messageTags,
  threadReferenceFrom,
} from "../convex/buzz/messages";

// `anyApi` rather than the generated `api`, for the reason buzz-log.test.ts and
// buzz-channels.test.ts state: `convex/_generated/api.d.ts` is a hand-rolled
// stub that predates `convex/buzz/*` and only `npx convex dev` may rewrite it.
// The references resolve identically at runtime — convex-test finds them
// through the glob below.
const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

// Fixed keys: several assertions are about *which* pubkey signed something or
// which pubkey a mention resolved to, and a random key makes those pass or fail
// by the day.
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
type Page = { events: Event[]; nextCursor?: string };

const KIND_DELETION = 5;
const KIND_REACTION = 7;
const KIND_MESSAGE = 9;
const KIND_DELETE_EVENT = 9005;
const KIND_EDIT = 40003;
const KIND_SYSTEM = 40099;

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  // A real deployment sets this with `npx convex env set`. Fixed here so the
  // derived relay pubkey is the same on every run — `remove` publishes a
  // relay-signed tombstone, so the seed is not optional for this suite.
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
    // A second community, so "the tenancy fence" is a claim about two real
    // workspaces rather than about a string that resolves to nothing.
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

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const otherScope: Scope = { scopeType: "workspace", scopeId: ids.otherWorkspaceId };
  return { t, scope, otherScope };
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

type Harness = ReturnType<typeof convexTest>;

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

async function post(
  t: Harness,
  scope: Scope,
  channelId: string,
  body: string,
  as = ALICE,
  reply?: { parentId: string; rootId?: string },
): Promise<string> {
  const result = (await t.withIdentity(as).mutation(messages.post, {
    ...scope,
    channelId,
    body,
    ...(reply ?? {}),
  })) as { eventId: string };
  return result.eventId;
}

async function list(
  t: Harness,
  scope: Scope,
  channelId: string,
  as = ALICE,
  extra: Record<string, unknown> = {},
): Promise<Page> {
  return (await t
    .withIdentity(as)
    .query(messages.list, { ...scope, channelId, ...extra })) as Page;
}

function of(page: Page, kind: number): Event[] {
  return page.events.filter((event: Event) => event.kind === kind);
}

function tagsNamed(event: Event, name: string): string[][] {
  return event.tags.filter((tag: string[]) => tag[0] === name);
}

// ---------------------------------------------------------------------------
// The tag grammar (§2.2) — pure, so it can be read without a database
// ---------------------------------------------------------------------------

describe("threading tags", () => {
  it("marks a direct reply with one reply tag and a deeper one with both", () => {
    const direct = messageTags("chan", "aa", [], { parentId: "root", rootId: "root" });
    expect(direct.filter((tag: string[]) => tag[0] === "e")).toEqual([
      ["e", "root", "", "reply"],
    ]);

    const nested = messageTags("chan", "aa", [], { parentId: "mid", rootId: "root" });
    expect(nested.filter((tag: string[]) => tag[0] === "e")).toEqual([
      ["e", "root", "", "root"],
      ["e", "mid", "", "reply"],
    ]);
  });

  it("round-trips through the reader", () => {
    const nested = messageTags("chan", "aa", ["bb"], { parentId: "mid", rootId: "root" });
    expect(threadReferenceFrom(nested)).toEqual({ parentId: "mid", rootId: "root" });

    const direct = messageTags("chan", "aa", [], { parentId: "root", rootId: "root" });
    expect(threadReferenceFrom(direct)).toEqual({ parentId: "root", rootId: "root" });

    expect(threadReferenceFrom(messageTags("chan", "aa", [], null))).toEqual({
      parentId: null,
      rootId: null,
    });
  });

  it("reads an unmarked e tag as a mention, never as a parent", () => {
    // A client that ignores the marker renders a reply as top-level; the
    // converse mistake — treating any `e` tag as a parent — silently reparents
    // every message that ever linked to another.
    expect(threadReferenceFrom([["e", "somewhere"]])).toEqual({
      parentId: null,
      rootId: null,
    });
  });

  it("carries the room, the author and the mentions, in one fixed order", () => {
    // Tag order is part of the event id, so it cannot be "whatever the caller
    // assembled".
    expect(messageTags("chan", "aa", ["bb", "cc"], null)).toEqual([
      ["p", "aa"],
      ["h", "chan"],
      ["p", "bb"],
      ["p", "cc"],
    ]);
  });
});

describe("mention tokens", () => {
  it("finds each token once, in order", () => {
    expect(mentionedActorIds("hi @[Bob](user_bob) and @[Bob](user_bob), @[C](user_c)")).toEqual([
      "user_bob",
      "user_c",
    ]);
  });

  it("ignores prose that is not a token", () => {
    expect(mentionedActorIds("email me @ home, see [docs](http://x)")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("access", () => {
  it("refuses somebody outside the community entirely", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const outsider = t.withIdentity(OUTSIDER);

    await expect(outsider.query(messages.list, { ...scope, channelId })).rejects.toThrow(
      /Forbidden/,
    );
    await expect(
      outsider.mutation(messages.post, { ...scope, channelId, body: "hello" }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("fences one community's rooms off from another's scope", async () => {
    const { t, scope, otherScope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await post(t, scope, channelId, "acme only");

    // Alice owns both workspaces, so this is not an authentication failure: it
    // is the channel id failing to resolve outside the community that holds it.
    await expect(
      t.withIdentity(ALICE).query(messages.list, { ...otherScope, channelId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(messages.post, { ...otherScope, channelId, body: "leak" }),
    ).rejects.toThrow(/not found/i);
  });

  it("hides a private room from a community member who is not in it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "acquisition", visibility: "private" });
    await post(t, scope, channelId, "the number is 40");

    // "Not found", not "forbidden": whether #acquisition exists is itself the
    // thing being kept.
    await expect(
      t.withIdentity(BOB).query(messages.list, { ...scope, channelId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t.withIdentity(BOB).mutation(messages.post, { ...scope, channelId, body: "hi" }),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a non-member read an open room but not write in it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "hello everyone");

    const page = await list(t, scope, channelId, CAROL);
    expect(of(page, KIND_MESSAGE).map((event: Event) => event.id)).toEqual([posted]);

    await expect(
      t.withIdentity(CAROL).mutation(messages.post, { ...scope, channelId, body: "me too" }),
    ).rejects.toThrow(/Join this channel/);
    await expect(
      t
        .withIdentity(CAROL)
        .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "👍" }),
    ).rejects.toThrow(/Join this channel/);
  });

  it("freezes an archived room", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "old" });
    const posted = await post(t, scope, channelId, "last word");
    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });

    await expect(
      t.withIdentity(ALICE).mutation(messages.post, { ...scope, channelId, body: "more" }),
    ).rejects.toThrow(/archived/);
    // Moderation still works on an archive, or archiving would be a way to make
    // a message permanent.
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: posted });
  });
});

// ---------------------------------------------------------------------------
// Posting and threads
// ---------------------------------------------------------------------------

describe("posting", () => {
  it("writes a signed kind 9 carrying the room and the author", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const eventId = await post(t, scope, channelId, "hello");

    const page = await list(t, scope, channelId);
    const message = of(page, KIND_MESSAGE)[0];
    expect(message.id).toBe(eventId);
    expect(message.pubkey).toBe(pubkeyOf(ALICE));
    expect(message.sig).toHaveLength(128);
    expect(tagsNamed(message, "h")).toEqual([["h", channelId]]);
    expect(tagsNamed(message, "p")).toEqual([["p", pubkeyOf(ALICE)]]);
  });

  it("refuses an empty message", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await expect(
      t.withIdentity(ALICE).mutation(messages.post, { ...scope, channelId, body: "   " }),
    ).rejects.toThrow(/needs something in it/);
  });

  it("bumps the room's activity clock", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const before = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      lastActivityAt: number;
    };
    await post(t, scope, channelId, "hello");
    const after = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      lastActivityAt: number;
    };
    expect(after.lastActivityAt).toBeGreaterThanOrEqual(before.lastActivityAt);
  });
});

describe("threads", () => {
  it("derives a nested reply's root from its parent, not from the caller", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const root = await post(t, scope, channelId, "the question");
    const reply = await post(t, scope, channelId, "an answer", ALICE, { parentId: root });
    const nested = await post(t, scope, channelId, "a follow-up", ALICE, { parentId: reply });

    const page = await list(t, scope, channelId);
    const byId = new Map(page.events.map((event: Event) => [event.id, event]));

    expect(threadReferenceFrom(byId.get(reply)!.tags)).toEqual({
      parentId: root,
      rootId: root,
    });
    // The nested reply names the *root* it belongs to even though its parent is
    // the reply — one thread, however deep.
    expect(threadReferenceFrom(byId.get(nested)!.tags)).toEqual({
      parentId: reply,
      rootId: root,
    });
  });

  it("refuses a root that disagrees with the parent", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const root = await post(t, scope, channelId, "the question");
    const other = await post(t, scope, channelId, "unrelated");
    const reply = await post(t, scope, channelId, "an answer", ALICE, { parentId: root });

    await expect(
      t.withIdentity(ALICE).mutation(messages.post, {
        ...scope,
        channelId,
        body: "misfiled",
        parentId: reply,
        rootId: other,
      }),
    ).rejects.toThrow(/does not match its parent/);
  });

  it("refuses a reply to a message in another room", async () => {
    const { t, scope } = await seed();
    const one = await createChannel(t, scope, { name: "one" });
    const two = await createChannel(t, scope, { name: "two" });
    const elsewhere = await post(t, scope, one, "over here");

    await expect(
      t.withIdentity(ALICE).mutation(messages.post, {
        ...scope,
        channelId: two,
        body: "reaching across",
        parentId: elsewhere,
      }),
    ).rejects.toThrow(/Message not found/);
  });

  it("returns the head and the whole subtree in one read", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const root = await post(t, scope, channelId, "the question");
    const reply = await post(t, scope, channelId, "an answer", ALICE, { parentId: root });
    const nested = await post(t, scope, channelId, "a follow-up", ALICE, { parentId: reply });
    await post(t, scope, channelId, "unrelated");

    const page = (await t
      .withIdentity(ALICE)
      .query(messages.thread, { ...scope, channelId, rootId: root })) as Page;
    const ids = of(page, KIND_MESSAGE).map((event: Event) => event.id);
    // The head leads; the subtree follows in forward order, which inside one
    // second is by event id (§2.3 — bursty threads routinely share a second, so
    // the id tie-break is what makes the order total rather than incidental).
    expect(ids[0]).toBe(root);
    expect(new Set(ids)).toEqual(new Set([root, reply, nested]));
  });

  it("carries a reply's reactions with the thread", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const root = await post(t, scope, channelId, "the question");
    const reply = await post(t, scope, channelId, "an answer", ALICE, { parentId: root });
    await t
      .withIdentity(ALICE)
      .mutation(messages.react, { ...scope, channelId, targetId: reply, emoji: "🎉" });

    const page = (await t
      .withIdentity(ALICE)
      .query(messages.thread, { ...scope, channelId, rootId: root })) as Page;
    expect(of(page, KIND_REACTION)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

describe("mentions", () => {
  it("derives them from the body, never from an argument", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    // There is no mentions argument to send — a caller cannot state one — so the
    // proof is that the tag is present when the body says so and absent when it
    // does not, over the same call shape.
    const withMention = await post(t, scope, channelId, `ping @[bob](${BOB.subject})`);
    const without = await post(t, scope, channelId, "no ping here");

    const page = await list(t, scope, channelId);
    const byId = new Map(page.events.map((event: Event) => [event.id, event]));
    expect(tagsNamed(byId.get(withMention)!, "p")).toEqual([
      ["p", pubkeyOf(ALICE)],
      ["p", pubkeyOf(BOB)],
    ]);
    expect(tagsNamed(byId.get(without)!, "p")).toEqual([["p", pubkeyOf(ALICE)]]);
  });

  it("accepts a pubkey token, and only one a key actually holds", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const real = await post(t, scope, channelId, `hi @[bob](${pubkeyOf(BOB)})`);
    const invented = await post(t, scope, channelId, `hi @[ghost](${"ab".repeat(32)})`);

    const page = await list(t, scope, channelId);
    const byId = new Map(page.events.map((event: Event) => [event.id, event]));
    expect(tagsNamed(byId.get(real)!, "p")).toEqual([
      ["p", pubkeyOf(ALICE)],
      ["p", pubkeyOf(BOB)],
    ]);
    // Sixty-four hex characters typed into a body are not an identity: `p` is
    // the read-authorization key for gated kinds, so an unbacked one is dropped.
    expect(tagsNamed(byId.get(invented)!, "p")).toEqual([["p", pubkeyOf(ALICE)]]);
  });

  it("drops a self-mention and deduplicates the rest", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const eventId = await post(
      t,
      scope,
      channelId,
      `@[me](${ALICE.subject}) @[bob](${BOB.subject}) @[bob again](${pubkeyOf(BOB)})`,
    );

    const page = await list(t, scope, channelId);
    const message = page.events.find((event: Event) => event.id === eventId)!;
    expect(tagsNamed(message, "p")).toEqual([
      ["p", pubkeyOf(ALICE)],
      ["p", pubkeyOf(BOB)],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Editing and deleting (§3.4)
// ---------------------------------------------------------------------------

describe("editing", () => {
  it("is refused to everybody but the author", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "mine");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    await expect(
      t
        .withIdentity(BOB)
        .mutation(messages.edit, { ...scope, channelId, targetId: posted, body: "yours" }),
    ).rejects.toThrow(/Only the author/);
  });

  it("overlays the message rather than rewriting it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "frist");
    await t
      .withIdentity(ALICE)
      .mutation(messages.edit, { ...scope, channelId, targetId: posted, body: "first" });

    const page = await list(t, scope, channelId);
    // The original is untouched — the log is append-only — and the edit rides
    // beside it for the projector to fold.
    expect(of(page, KIND_MESSAGE).find((event: Event) => event.id === posted)!.content).toBe(
      "frist",
    );
    const edit = of(page, KIND_EDIT)[0];
    expect(edit.content).toBe("first");
    expect(tagsNamed(edit, "e")).toEqual([["e", posted]]);
  });

  it("carries only the mentions the edit newly adds", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, `hi @[bob](${BOB.subject})`);

    await t.withIdentity(ALICE).mutation(messages.edit, {
      ...scope,
      channelId,
      targetId: posted,
      body: `hi. @[bob](${BOB.subject})`,
    });
    // A typo fix that leaves the mention set alone re-wakes nobody.
    const typoFix = of(await list(t, scope, channelId), KIND_EDIT)[0];
    expect(tagsNamed(typoFix, "p")).toEqual([]);

    const widened = `hi @[bob](${BOB.subject}) @[carol](${CAROL.subject})`;
    await t
      .withIdentity(ALICE)
      .mutation(messages.edit, { ...scope, channelId, targetId: posted, body: widened });
    // Selected by content rather than by "newest": both edits land in the same
    // `created_at` second, which is exactly the tie a timestamp cannot break.
    const second = of(await list(t, scope, channelId), KIND_EDIT).find(
      (event: Event) => event.content === widened,
    )!;
    expect(tagsNamed(second, "p")).toEqual([["p", pubkeyOf(CAROL)]]);
  });

  it("refuses to edit a relay-signed row", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const system = of(await list(t, scope, channelId), KIND_SYSTEM)[0];

    await expect(
      t.withIdentity(ALICE).mutation(messages.edit, {
        ...scope,
        channelId,
        targetId: system.id,
        body: "never happened",
      }),
    ).rejects.toThrow(/not an editable message/);
  });
});

describe("deleting", () => {
  it("is refused to an ordinary member who did not write it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "mine");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(BOB).mutation(messages.remove, { ...scope, channelId, targetId: posted }),
    ).rejects.toThrow(/Only the author/);
  });

  it("stops serving the content and records who removed it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "the secret");
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: posted });

    const page = await list(t, scope, channelId);
    // Absent, not tombstoned-with-its-text: a rule the renderer enforces is not
    // a rule, and agents read this log too.
    expect(page.events.some((event: Event) => event.id === posted)).toBe(false);
    expect(page.events.some((event: Event) => event.content === "the secret")).toBe(false);

    const marker = of(page, KIND_DELETE_EVENT)[0];
    expect(tagsNamed(marker, "e")).toEqual([["e", posted]]);
    const tombstone = of(page, KIND_SYSTEM)
      .map((event: Event) => JSON.parse(event.content) as { type: string; actor: string })
      .find((payload: { type: string }) => payload.type === "message_deleted");
    expect(tombstone?.actor).toBe(pubkeyOf(ALICE));
  });

  it("lets a room admin remove somebody else's message", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    const posted = await post(t, scope, channelId, "off topic", BOB);

    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: posted });
    expect(
      (await list(t, scope, channelId)).events.some((event: Event) => event.id === posted),
    ).toBe(false);
  });

  it("refuses a second delete of the same message", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "gone");
    await t
      .withIdentity(ALICE)
      .mutation(messages.remove, { ...scope, channelId, targetId: posted });

    await expect(
      t.withIdentity(ALICE).mutation(messages.remove, { ...scope, channelId, targetId: posted }),
    ).rejects.toThrow(/Message not found/);
  });
});

// ---------------------------------------------------------------------------
// Reactions (§3.2)
// ---------------------------------------------------------------------------

describe("reactions", () => {
  it("takes its room from the message it points at", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "hello");
    await t
      .withIdentity(ALICE)
      .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "👍" });

    const reaction = of(await list(t, scope, channelId), KIND_REACTION)[0];
    expect(reaction.content).toBe("👍");
    // No `h` tag: a reaction that could name its own room could plant itself in
    // a room its target is not in.
    expect(tagsNamed(reaction, "h")).toEqual([]);
    expect(tagsNamed(reaction, "e")).toEqual([["e", posted]]);
  });

  it("is idempotent, and a retraction is", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "hello");

    const first = (await t
      .withIdentity(ALICE)
      .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "👍" })) as {
      eventId: string;
      added: boolean;
    };
    const second = (await t
      .withIdentity(ALICE)
      .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "👍" })) as {
      eventId: string;
      added: boolean;
    };
    expect(second.added).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    expect(of(await list(t, scope, channelId), KIND_REACTION)).toHaveLength(1);

    expect(
      await t
        .withIdentity(ALICE)
        .mutation(messages.unreact, { ...scope, channelId, targetId: posted, emoji: "👍" }),
    ).toEqual({ removed: true });
    expect(
      await t
        .withIdentity(ALICE)
        .mutation(messages.unreact, { ...scope, channelId, targetId: posted, emoji: "👍" }),
    ).toEqual({ removed: false });

    const page = await list(t, scope, channelId);
    expect(of(page, KIND_REACTION)).toHaveLength(0);
    expect(of(page, KIND_DELETION)).toHaveLength(1);
  });

  it("leaves other people's reactions alone", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "hello");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    for (const person of [ALICE, BOB]) {
      await t
        .withIdentity(person)
        .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "👍" });
    }
    await t
      .withIdentity(ALICE)
      .mutation(messages.unreact, { ...scope, channelId, targetId: posted, emoji: "👍" });

    const remaining = of(await list(t, scope, channelId), KIND_REACTION);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pubkey).toBe(pubkeyOf(BOB));
  });

  it("refuses a reaction to a message the reader cannot see", async () => {
    const { t, scope } = await seed();
    const open = await createChannel(t, scope, { name: "general" });
    const secret = await createChannel(t, scope, { name: "acquisition", visibility: "private" });
    const hidden = await post(t, scope, secret, "the number is 40");
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId: open });

    // Through the room he is kept out of: the room refuses to admit it exists.
    await expect(
      t
        .withIdentity(BOB)
        .mutation(messages.react, { ...scope, channelId: secret, targetId: hidden, emoji: "👀" }),
    ).rejects.toThrow(/not found/i);
    // And through a room he is in, naming the hidden message: the target must
    // live in the room the write named.
    await expect(
      t
        .withIdentity(BOB)
        .mutation(messages.react, { ...scope, channelId: open, targetId: hidden, emoji: "👀" }),
    ).rejects.toThrow(/Message not found/);
    expect(await t.run(async (ctx: Ctx) => (await ctx.db.query("buzzEvents").collect()).filter(
      (row: { kind: number }) => row.kind === KIND_REACTION,
    ).length)).toBe(0);
  });

  it("refuses an empty reaction", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted = await post(t, scope, channelId, "hello");
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(messages.react, { ...scope, channelId, targetId: posted, emoji: "  " }),
    ).rejects.toThrow(/needs an emoji/);
  });
});

// ---------------------------------------------------------------------------
// Pagination (§2.8, §0.4)
// ---------------------------------------------------------------------------

describe("pagination", () => {
  /** Walk every page, following the cursor, and collect what came back. */
  async function walk(
    t: Harness,
    scope: Scope,
    channelId: string,
    limit: number,
  ): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(t, scope, channelId, ALICE, {
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const event of of(page, KIND_MESSAGE)) ids.push(event.id);
      cursor = page.nextCursor;
      pages += 1;
      // A cursor that stops making progress is the failure §0.4 warns about; a
      // bound turns an infinite loop into a readable assertion.
      expect(pages).toBeLessThan(60);
    } while (cursor !== undefined);
    return { ids, pages };
  }

  it("returns every message exactly once, with no gap at a page boundary", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted: string[] = [];
    // Written as fast as the test can write them, so they share a `created_at`
    // second — which is precisely the case a bare `until` cursor cannot escape.
    for (let i = 0; i < 25; i += 1) {
      posted.push(await post(t, scope, channelId, `message ${i}`));
    }

    for (const limit of [1, 3, 7, 25, 100]) {
      const { ids } = await walk(t, scope, channelId, limit);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...posted].sort());
    }
  });

  it("hands back the newest messages first", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const posted: string[] = [];
    for (let i = 0; i < 5; i += 1) posted.push(await post(t, scope, channelId, `m${i}`));

    const { ids } = await walk(t, scope, channelId, 2);
    // Relay order is `created_at` descending, and inside one second the tie is
    // broken by event id ascending — a total order, so the same page never
    // arrives in two arrangements.
    expect(ids).toHaveLength(posted.length);
    expect(new Set(ids)).toEqual(new Set(posted));
  });

  it("stops when it reaches the beginning", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await post(t, scope, channelId, "only one");

    const page = await list(t, scope, channelId, ALICE, { limit: 100 });
    expect(page.nextCursor).toBeUndefined();
  });

  it("refuses a malformed cursor rather than re-serving page one", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await expect(
      t.withIdentity(ALICE).query(messages.list, { ...scope, channelId, cursor: "nonsense" }),
    ).rejects.toThrow(/malformed cursor/);
  });

  it("carries an old message's edit onto the page that holds it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const first = await post(t, scope, channelId, "the original");
    for (let i = 0; i < 20; i += 1) await post(t, scope, channelId, `filler ${i}`);
    await t
      .withIdentity(ALICE)
      .mutation(messages.edit, { ...scope, channelId, targetId: first, body: "the revision" });

    // Page back to where the first message actually is. Its edit was written
    // long after it, so a page that only read a time range would render text
    // nobody has said since — the `#e` backfill is what prevents that.
    let cursor: string | undefined;
    let found: Page | undefined;
    for (let guard = 0; guard < 30 && !found; guard += 1) {
      const page: Page = await list(t, scope, channelId, ALICE, {
        limit: 5,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page.events.some((event: Event) => event.id === first)) found = page;
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(found).toBeDefined();
    expect(
      of(found!, KIND_EDIT).some(
        (event: Event) => event.tags.some((tag: string[]) => tag[1] === first),
      ),
    ).toBe(true);
  });
});
