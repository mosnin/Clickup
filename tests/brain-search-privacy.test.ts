import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Brain indexes tasks/docs/messages at workspace scope (Convex vector
// filters are a single equality). Every other human read walks
// canAccessSpace. This file is the post-filter that closes that gap:
// a workspace member who is locked out of a private space must not
// receive that space's textPreview.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const CREATOR = { subject: "user_creator", email: "creator@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

const SECRET = "Acquisition target: Company X — do not circulate";
const OPEN = "Ship the public changelog";

async function seedWorkspace() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("memberships", {
        workspaceId: id,
        userClerkId: u.subject,
        role: u === OWNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    return id;
  });
  return { t, workspaceId };
}

async function fakeEmbedding(
  t: ReturnType<typeof convexTest>,
  args: {
    parentType: "doc" | "task" | "page" | "message";
    parentId: string;
    scopeId: string;
    textPreview: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("embeddings", {
      parentType: args.parentType,
      parentId: args.parentId,
      scopeType: "workspace",
      scopeId: args.scopeId,
      textPreview: args.textPreview,
      embedding: new Array(1536).fill(0),
      updatedAt: Date.now(),
    });
  });
}

async function filterHits(
  t: ReturnType<typeof convexTest>,
  who: { subject: string } | null,
  hits: {
    parentType: "doc" | "task" | "page" | "message";
    parentId: string;
    textPreview: string;
  }[],
) {
  const q = who
    ? t.withIdentity(who).query(internal.aiDb._filterHitsForViewer, { hits })
    : t.query(internal.aiDb._filterHitsForViewer, { hits });
  return await q;
}

describe("Brain search respects private spaces", () => {
  it("drops a private-space task the workspace member cannot open", async () => {
    const { t, workspaceId } = await seedWorkspace();

    const secretSpaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: secretSpaceId,
      private: true,
    });
    const secretListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Hidden",
      parentType: "space",
      parentId: secretSpaceId,
    });
    const secretTaskId = await t.withIdentity(CREATOR).mutation(api.tasks.create, {
      listId: secretListId,
      title: SECRET,
    });

    const openSpaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Open",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const openListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Public",
      parentType: "space",
      parentId: openSpaceId,
    });
    const openTaskId = await t.withIdentity(CREATOR).mutation(api.tasks.create, {
      listId: openListId,
      title: OPEN,
    });

    await fakeEmbedding(t, {
      parentType: "task",
      parentId: secretTaskId,
      scopeId: workspaceId,
      textPreview: SECRET,
    });
    await fakeEmbedding(t, {
      parentType: "task",
      parentId: openTaskId,
      scopeId: workspaceId,
      textPreview: OPEN,
    });

    const hits = [
      { parentType: "task" as const, parentId: secretTaskId, textPreview: SECRET },
      { parentType: "task" as const, parentId: openTaskId, textPreview: OPEN },
    ];

    const outsider = await filterHits(t, OUTSIDER, hits);
    expect(outsider.map((h) => h.textPreview)).toEqual([OPEN]);

    const creator = await filterHits(t, CREATOR, hits);
    expect(creator.map((h) => h.textPreview).sort()).toEqual([OPEN, SECRET].sort());

    // Workspace owner bypasses private-space membership, same as canAccessSpace.
    const owner = await filterHits(t, OWNER, hits);
    expect(owner.map((h) => h.textPreview).sort()).toEqual([OPEN, SECRET].sort());

    expect(await filterHits(t, null, hits)).toEqual([]);
  });

  it("drops a comment and a space-parented doc inside a private space", async () => {
    const { t, workspaceId } = await seedWorkspace();

    const secretSpaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: secretSpaceId,
      private: true,
    });
    const secretListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Hidden",
      parentType: "space",
      parentId: secretSpaceId,
    });
    const secretTaskId = await t.withIdentity(CREATOR).mutation(api.tasks.create, {
      listId: secretListId,
      title: "Hidden task",
    });
    const messageId = await t.withIdentity(CREATOR).mutation(api.messages.create, {
      parentType: "task",
      parentId: secretTaskId,
      body: SECRET,
    });
    const docId = await t.withIdentity(CREATOR).mutation(api.docs.create, {
      parentType: "space",
      parentId: secretSpaceId,
      title: "Deal notes",
    });

    const hits = [
      { parentType: "message" as const, parentId: messageId, textPreview: SECRET },
      { parentType: "doc" as const, parentId: docId, textPreview: "Deal notes" },
    ];

    expect(await filterHits(t, OUTSIDER, hits)).toEqual([]);
    expect(await filterHits(t, CREATOR, hits)).toHaveLength(2);
  });

  it("drops a hit whose parent is gone rather than leaking the preview", async () => {
    const { t } = await seedWorkspace();
    const gone = "deleted_parent_id" as Id<"tasks">;
    const leftover = await filterHits(t, OUTSIDER, [
      { parentType: "task", parentId: gone, textPreview: SECRET },
    ]);
    expect(leftover).toEqual([]);
  });
});
