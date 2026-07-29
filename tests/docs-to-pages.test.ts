import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Folding docs into pages. This runs over people's writing exactly once, so
// the properties worth pinning are the ones that make it safe to run:
//
//  1. Idempotent — a second run reports zeros, not duplicates.
//  2. Non-destructive — the original Tiptap JSON survives on the page, so an
//     imperfect conversion is a bug to fix rather than data that's gone.
//  3. Structure-preserving — nesting becomes nesting, and a doc that was a
//     project's canonical context becomes a *pinned* attachment.
//  4. Honest — it reports what it didn't understand instead of claiming
//     success.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

const tiptap = (...text: string[]) => ({
  type: "doc",
  content: text.map((t) => ({
    type: "paragraph",
    content: [{ type: "text", text: t }],
  })),
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: "alice@example.com",
      name: "Alice",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const projectId = await ctx.db.insert("projects", {
      name: "Billing",
      spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Backlog",
      parentType: "project",
      parentId: projectId,
      position: 0,
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, projectId, listId };
  });
  return { t, ...ids };
}

async function insertDoc(
  t: Awaited<ReturnType<typeof seed>>["t"],
  doc: Record<string, unknown>,
) {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("docs", {
        title: "Untitled",
        content: tiptap("body"),
        createdByClerkId: ALICE.subject,
        createdAt: 1,
        updatedAt: 2,
        ...doc,
      } as never),
  );
}

describe("docsToPages", () => {
  it("converts a workspace doc into a page in the same scope", async () => {
    const { t, workspaceId } = await seed();
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Runbook",
      content: tiptap("Restart the worker."),
    });

    const report = await t.mutation(internal.migrations.docsToPages, {});
    expect(report).toMatchObject({ docsSeen: 1, converted: 1, lossy: 0 });

    const pages = await t
      .withIdentity(ALICE)
      .query(api.pages.listForScope, {
        scopeType: "workspace",
        scopeId: workspaceId,
      });
    expect(pages.map((p) => p.title)).toEqual(["Runbook"]);
  });

  it("keeps the original JSON on the page", async () => {
    const { t, workspaceId } = await seed();
    const content = tiptap("the original words");
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Brief",
      content,
    });
    await t.mutation(internal.migrations.docsToPages, {});

    const page = await t.run(async (ctx) => {
      const rows = await ctx.db.query("pages").collect();
      return rows[0];
    });
    // Non-destructive: an imperfect conversion stays recoverable.
    expect(page.importedDocContent).toEqual(content);
    expect(page.importedLossless).toBe(true);
    expect(page.markdown).toBe("the original words");
  });

  it("is idempotent", async () => {
    const { t, workspaceId } = await seed();
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Once",
    });
    const first = await t.mutation(internal.migrations.docsToPages, {});
    const second = await t.mutation(internal.migrations.docsToPages, {});
    expect(first.converted).toBe(1);
    expect(second).toMatchObject({ converted: 0, alreadyMigrated: 1 });

    const pages = await t.run(async (ctx) =>
      await ctx.db.query("pages").collect(),
    );
    expect(pages).toHaveLength(1);
  });

  it("changes nothing on a dry run", async () => {
    const { t, workspaceId } = await seed();
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Maybe",
    });
    const report = await t.mutation(internal.migrations.docsToPages, {
      dryRun: true,
    });
    expect(report.converted).toBe(1);
    const pages = await t.run(async (ctx) =>
      await ctx.db.query("pages").collect(),
    );
    expect(pages).toHaveLength(0);
  });

  it("turns a pinned project doc into a pinned attachment", async () => {
    const { t, listId } = await seed();
    await insertDoc(t, {
      parentType: "list",
      parentId: listId,
      title: "The brief",
      pinnedContext: true,
      content: tiptap("Ship it by Friday."),
    });
    await t.mutation(internal.migrations.docsToPages, {});

    const pinned = await t
      .withIdentity(ALICE)
      .query(api.pages.pinnedForTarget, {
        targetType: "list",
        targetId: listId,
      });
    expect(pinned.map((p) => p.title)).toEqual(["The brief"]);
  });

  it("attaches an unpinned project doc without pinning it", async () => {
    const { t, listId } = await seed();
    await insertDoc(t, {
      parentType: "list",
      parentId: listId,
      title: "Reference",
    });
    await t.mutation(internal.migrations.docsToPages, {});

    const all = await t.withIdentity(ALICE).query(api.pages.forTarget, {
      targetType: "list",
      targetId: listId,
    });
    expect(all).toHaveLength(1);
    expect(all[0].pinned).toBe(false);
    const pinned = await t
      .withIdentity(ALICE)
      .query(api.pages.pinnedForTarget, {
        targetType: "list",
        targetId: listId,
      });
    expect(pinned).toHaveLength(0);
  });

  it("rebuilds doc nesting as page nesting", async () => {
    const { t, workspaceId } = await seed();
    const parentDocId = await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Architecture",
    });
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Storage",
      parentDocId,
    });

    const report = await t.mutation(internal.migrations.docsToPages, {});
    expect(report.parentLinksRestored).toBe(1);

    const parentPageId = await t.run(async (ctx) => {
      const doc = await ctx.db.get(parentDocId);
      return doc!.migratedToPageId!;
    });
    const parent = await t
      .withIdentity(ALICE)
      .query(api.pages.get, { pageId: parentPageId });
    expect(parent!.children.map((c) => c.title)).toEqual(["Storage"]);
  });

  it("reports a lossy conversion instead of claiming success", async () => {
    const { t, workspaceId } = await seed();
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Weird",
      content: {
        type: "doc",
        content: [
          { type: "mysteryBlock", content: [{ type: "text", text: "keep me" }] },
        ],
      },
    });
    const report = await t.mutation(internal.migrations.docsToPages, {});
    expect(report.lossy).toBe(1);
    expect(report.unknownNodeTypes).toContain("mysteryBlock");
    expect(report.lossyDocs[0]).toMatchObject({ title: "Weird" });

    // The words still survive, and the original JSON is on the page.
    const page = await t.run(async (ctx) => {
      const rows = await ctx.db.query("pages").collect();
      return rows[0];
    });
    expect(page.markdown).toContain("keep me");
    expect(page.importedLossless).toBe(false);
  });

  it("leaves a doc whose parent is gone alone rather than guessing", async () => {
    const { t } = await seed();
    await insertDoc(t, {
      parentType: "space",
      parentId: "kn7abcdefghijklmnopqrstuvwx" as Id<"spaces">,
      title: "Orphan",
    });
    const report = await t.mutation(internal.migrations.docsToPages, {});
    expect(report).toMatchObject({ converted: 0, skippedNoScope: 1 });
  });

  it("redirects an old doc URL to its page", async () => {
    const { t, workspaceId } = await seed();
    const docId = await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Bookmarked",
    });
    await t.mutation(internal.migrations.docsToPages, {});

    const pageId = await t
      .withIdentity(ALICE)
      .query(api.pages.pageForLegacyDoc, { docId });
    expect(pageId).toBeTruthy();
    const page = await t
      .withIdentity(ALICE)
      .query(api.pages.get, { pageId: pageId! });
    expect(page!.page.title).toBe("Bookmarked");
  });

  it("audits clean once everything has moved", async () => {
    const { t, workspaceId, listId } = await seed();
    await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "A",
    });
    await insertDoc(t, {
      parentType: "list",
      parentId: listId,
      title: "B",
      pinnedContext: true,
    });

    const before = await t.query(internal.migrations.auditDocsToPages, {});
    expect(before.healthy).toBe(false);
    expect(before.counts.unmigrated).toBe(2);

    await t.mutation(internal.migrations.docsToPages, {});

    const after = await t.query(internal.migrations.auditDocsToPages, {});
    expect(after.healthy).toBe(true);
    expect(after.counts).toMatchObject({
      docs: 2,
      migrated: 2,
      unmigrated: 0,
      lossyConversions: 0,
      danglingPointer: 0,
      pinnedAttachments: 1,
    });
  });
});

describe("agents see one primitive", () => {
  const AGENT_KEY = "cua_docs_fold_key_00000000000";

  async function seedAgent(t: Awaited<ReturnType<typeof seed>>["t"], workspaceId: Id<"workspaces">) {
    const { sha256Hex } = await import("../convex/_agentAuth");
    await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        name: "Scout",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(AGENT_KEY),
        keyPrefix: AGENT_KEY.slice(0, 12),
        createdAt: Date.now(),
      });
    });
  }

  it("resolves a legacy docId through the deprecated read tool", async () => {
    const { t, workspaceId } = await seed();
    await seedAgent(t, workspaceId);
    const docId = await insertDoc(t, {
      parentType: "workspace",
      parentId: workspaceId,
      title: "Runbook",
      content: tiptap("Restart the worker."),
    });
    await t.mutation(internal.migrations.docsToPages, {});

    // An agent whose prompt still says get_doc keeps working, and gets
    // markdown rather than a flattening of a different format.
    const read = await t.query(api.agentApi.getDoc, {
      apiKey: AGENT_KEY,
      docId,
    });
    expect(read).toMatchObject({
      title: "Runbook",
      text: "Restart the worker.",
    });
    expect(read.pageId).toBe(read.docId);
  });

  it("hands pinned pages to get_task automatically", async () => {
    const { t, workspaceId, listId } = await seed();
    await seedAgent(t, workspaceId);
    await insertDoc(t, {
      parentType: "list",
      parentId: listId,
      title: "The brief",
      pinnedContext: true,
      content: tiptap("Ship it by Friday."),
    });
    await t.mutation(internal.migrations.docsToPages, {});

    const statusId = await t.run(async (ctx) =>
      await ctx.db.insert("listStatuses", {
        listId,
        name: "To Do",
        color: "#ccc",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      }),
    );
    const taskId = await t.run(async (ctx) =>
      await ctx.db.insert("tasks", {
        listId,
        title: "Do the thing",
        statusId,
        position: 0,
        assigneeClerkIds: [],
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      }),
    );

    const task = await t.query(api.agentApi.getTask, {
      apiKey: AGENT_KEY,
      taskId,
    });
    expect(task.context).toEqual([
      expect.objectContaining({
        title: "The brief",
        text: "Ship it by Friday.",
      }),
    ]);
  });
});
