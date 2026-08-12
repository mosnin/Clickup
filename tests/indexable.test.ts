import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  MIN_INDEXABLE_CHARS,
  indexableText,
  shouldIndexMessage,
} from "../convex/_indexable";

// Which deliberation is worth embedding.
//
// Indexing messages was deferred on cost grounds and that concern was right:
// every message means an embedding call, including every "ok" and every
// "@Ada ptal". The floor is what makes it affordable, and the floor is the
// whole feature — the plumbing is the same three lines pages already use.
//
// The property that matters most is that length is measured AFTER the inline
// tokens are stripped. `@[Priya](user_2ab...) look at #[Deploy](task:xyz...)`
// is long in characters and empty of meaning: the ids inflate it past any
// floor while carrying nothing anybody would search for. Measuring raw would
// mean the floor admits precisely the messages it exists to exclude.

const long = (n = MIN_INDEXABLE_CHARS + 20) => "a".repeat(n);

describe("stripping to what is searchable", () => {
  it("keeps the words out of a mention", () => {
    expect(indexableText("@[Priya](user_x) can you look")).toBe(
      "Priya can you look",
    );
  });

  it("keeps the label out of a reference", () => {
    expect(indexableText("blocked on #[Deploy pipeline](task:abc)")).toBe(
      "blocked on Deploy pipeline",
    );
  });

  it("keeps the title out of a page link", () => {
    expect(indexableText("see [[Runbook]] first")).toBe("see Runbook first");
  });

  it("keeps link text and drops the URL", () => {
    // A wall of URLs embeds as noise and matches nothing anybody types.
    expect(indexableText("read [the RFC](https://example.com/a/b) today")).toBe(
      "read the RFC today",
    );
    expect(indexableText("here https://example.com/very/long/path ok")).toBe(
      "here ok",
    );
  });

  it("drops quoted text", () => {
    // Somebody else's message, already indexed on its own. Indexing it again
    // makes the same paragraph win twice.
    expect(indexableText("> they said this\nand I disagree")).toBe(
      "and I disagree",
    );
  });

  it("drops fenced code", () => {
    // Not deliberation, and the biggest source of long-but-unsearchable bodies.
    expect(
      indexableText("why it broke\n```\nconst x = 1;\n```\nfixed now"),
    ).toBe("why it broke fixed now");
  });
});

describe("the floor", () => {
  it("skips a short message", () => {
    expect(shouldIndexMessage("ok")).toBe(false);
    expect(shouldIndexMessage("agreed, ship it")).toBe(false);
  });

  it("indexes a long one", () => {
    expect(shouldIndexMessage(long())).toBe(true);
  });

  it("is not defeated by long ids", () => {
    // The case the whole design turns on. Raw length here is well past the
    // floor; meaning is four words.
    const noise =
      "@[Priya](user_2abcdefghijklmnopqrstuvwx) @[Ada](user_2zyxwvutsrqponmlkjihgf) ptal #[Deploy pipeline](task:kn7abcdefghijklmnopqrstuvwxyz012345) #[Rollout](task:kn7zzzzzzzzzzzzzzzzzzzzzzzzzz98765)";
    expect(noise.length).toBeGreaterThan(MIN_INDEXABLE_CHARS);
    expect(shouldIndexMessage(noise)).toBe(false);
  });

  it("is not defeated by a pasted URL", () => {
    const url = `look ${"https://example.com/" + "x".repeat(300)}`;
    expect(url.length).toBeGreaterThan(MIN_INDEXABLE_CHARS);
    expect(shouldIndexMessage(url)).toBe(false);
  });

  it("is not defeated by a code dump", () => {
    const dump = "fyi\n```\n" + "const x = 1;\n".repeat(60) + "```";
    expect(dump.length).toBeGreaterThan(MIN_INDEXABLE_CHARS);
    expect(shouldIndexMessage(dump)).toBe(false);
  });

  it("does not care who wrote it", () => {
    // An agent's reasoning is exactly as worth finding as a person's — more
    // so, since the agent will not be around to remember it.
    expect(shouldIndexMessage(long())).toBe(true);
  });
});

// ── In the product ──

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const ids = await t.run(async (ctx) => {
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Tasks",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    return { spaceId, listId };
  });
  return { t, alice, ...ids };
}

/** Embeddings never get written here (no OPENAI_API_KEY), so stand one in. */
async function fakeEmbedding(
  t: Awaited<ReturnType<typeof setup>>["t"],
  messageId: string,
  scopeId: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("embeddings", {
      parentType: "message",
      parentId: messageId,
      scopeType: "user",
      scopeId,
      textPreview: "a long argument about the deploy pipeline",
      embedding: new Array(1536).fill(0),
      updatedAt: Date.now(),
    });
  });
}

describe("deleting a message forgets it", () => {
  it("drops the embedding with the row", async () => {
    const { t, alice, listId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Task",
    });
    const messageId = await alice.mutation(api.messages.create, {
      parentType: "task",
      parentId: taskId,
      body: long(),
    });
    await fakeEmbedding(t, messageId, ALICE.subject);

    await alice.mutation(api.messages.remove, { messageId });

    const left = await t.run(async (ctx) =>
      ctx.db
        .query("embeddings")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "message").eq("parentId", messageId),
        )
        .collect(),
    );
    // Leaving it behind is worse than never indexing: search keeps returning a
    // preview of text that no longer exists, pointing at an id that resolves
    // to nothing.
    expect(left).toEqual([]);
  });

  it("drops a reply's embedding too", async () => {
    const { t, alice, listId } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Task",
    });
    const rootId = await alice.mutation(api.messages.create, {
      parentType: "task",
      parentId: taskId,
      body: long(),
    });
    const replyId = await alice.mutation(api.messages.create, {
      parentType: "task",
      parentId: taskId,
      body: long(),
      parentMessageId: rootId as Id<"messages">,
    });
    await fakeEmbedding(t, replyId, ALICE.subject);

    await alice.mutation(api.messages.remove, { messageId: rootId });

    const left = await t.run(async (ctx) =>
      ctx.db.query("embeddings").collect(),
    );
    expect(left).toEqual([]);
  });
});
