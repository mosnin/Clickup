import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";
import {
  extractWikiLinks,
  inferTitle,
  markdownExcerpt,
  markdownToText,
} from "../convex/_markdown";

// Pages are the long-form layer. The rules worth pinning down:
//
//  1. Markdown is the stored truth; text extraction is for search/preview
//     only and must not leak syntax into what gets embedded.
//  2. A page lives in one scope and shows up in many places. Attaching is
//     many-to-many and idempotent.
//  3. Attachment is the one place a page touches the hierarchy, so it is
//     access-checked on BOTH sides and refuses to cross a scope boundary.
//  4. [[wikilinks]] resolve by title within the scope, and backlinks are
//     stored rather than derived.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const u of [ALICE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
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
    return { workspaceId, spaceId };
  });
  return { t, ...ids };
}

describe("markdown helpers", () => {
  it("strips syntax without eating the words", () => {
    const md = [
      "# Billing migration",
      "",
      "We are moving off **Legacy Co**. See [the RFC](https://x.test) and",
      "[[Payment provider notes]].",
      "",
      "```ts",
      "const secret = 1;",
      "```",
      "",
      "- first point",
      "- second point",
    ].join("\n");

    const text = markdownToText(md);
    expect(text).toContain("Billing migration");
    expect(text).toContain("Legacy Co");
    expect(text).toContain("the RFC");
    expect(text).toContain("Payment provider notes");
    expect(text).toContain("first point");
    // Fenced code is dropped rather than embedded as prose.
    expect(text).not.toContain("const secret");
    // No syntax survives into the embedded text.
    expect(text).not.toContain("#");
    expect(text).not.toContain("**");
    expect(text).not.toContain("[[");
    expect(text).not.toContain("https://x.test");
  });

  it("finds wikilinks and ignores empty ones", () => {
    const links = extractWikiLinks("see [[One]] and [[ Two ]] and [[]]");
    expect(links.map((l) => l.target)).toEqual(["One", "Two"]);
  });

  it("infers a title from the first heading", () => {
    expect(inferTitle("# Launch plan\n\nbody")).toBe("Launch plan");
    expect(inferTitle("no heading here at all")).toBe(
      "no heading here at all",
    );
    expect(inferTitle("")).toBe("Untitled");
  });

  it("truncates excerpts with an ellipsis", () => {
    expect(markdownExcerpt("# Hi\n\nshort")).toBe("Hi short");
    expect(markdownExcerpt("x".repeat(300)).endsWith("…")).toBe(true);
  });
});

describe("pages", () => {
  it("creates, reads back, and updates markdown as the source of truth", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Architecture",
      markdown: "# Architecture\n\nWe use Convex.",
    });

    let data = await alice.query(api.pages.get, { pageId });
    expect(data?.page.title).toBe("Architecture");
    expect(data?.page.markdown).toContain("We use Convex.");

    await alice.mutation(api.pages.update, {
      pageId,
      markdown: "# Architecture\n\nWe use Convex and Ably.",
    });
    data = await alice.query(api.pages.get, { pageId });
    expect(data?.page.markdown).toContain("Ably");
    expect(data?.page.updatedByName).toBeTruthy();
  });

  it("infers a title from the content when none is given", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      markdown: "## Incident 2026-07-14\n\nwhat happened",
    });
    const data = await alice.query(api.pages.get, { pageId });
    expect(data?.page.title).toBe("Incident 2026-07-14");
  });

  it("resolves wikilinks into stored backlinks and rewrites them on edit", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const targetId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Payment provider notes",
      markdown: "details",
    });
    const sourceId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Billing migration",
      // Case-insensitive match on the title.
      markdown: "see [[payment provider NOTES]] and [[Does Not Exist]]",
    });

    const target = await alice.query(api.pages.get, { pageId: targetId });
    expect(target?.backlinks.map((b) => b.pageId)).toEqual([sourceId]);

    const source = await alice.query(api.pages.get, { pageId: sourceId });
    // The unresolved link stores nothing rather than failing the save.
    expect(source?.outgoing.map((o) => o.pageId)).toEqual([targetId]);

    // Removing the link removes the backlink.
    await alice.mutation(api.pages.update, {
      pageId: sourceId,
      markdown: "no links any more",
    });
    const after = await alice.query(api.pages.get, { pageId: targetId });
    expect(after?.backlinks).toEqual([]);
  });

  it("attaches to many targets, is idempotent, and surfaces on the target", async () => {
    const { t, workspaceId, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Billing",
    });
    const listId = await alice.mutation(api.lists.create, {
      name: "Backlog",
      parentType: "project",
      parentId: projectId,
    });

    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Brief",
      markdown: "the brief",
      attachTo: { targetType: "project", targetId: projectId },
    });
    await alice.mutation(api.pages.attach, {
      pageId,
      targetType: "list",
      targetId: listId,
    });
    // Attaching twice must not create a second row.
    await alice.mutation(api.pages.attach, {
      pageId,
      targetType: "list",
      targetId: listId,
    });

    const onProject = await alice.query(api.pages.forTarget, {
      targetType: "project",
      targetId: projectId,
    });
    expect(onProject.map((p) => p.pageId)).toEqual([pageId]);

    const onList = await alice.query(api.pages.forTarget, {
      targetType: "list",
      targetId: listId,
    });
    expect(onList).toHaveLength(1);

    const data = await alice.query(api.pages.get, { pageId });
    expect(data?.attachments).toHaveLength(2);
    expect(data?.attachments.map((a) => a.label).sort()).toEqual([
      "Backlog",
      "Billing",
    ]);

    // Detaching leaves the page and the target alone.
    const listAttachment = data!.attachments.find(
      (a) => a.targetType === "list",
    )!;
    await alice.mutation(api.pages.detach, {
      attachmentId: listAttachment.attachmentId as Id<"pageAttachments">,
    });
    expect(
      await alice.query(api.pages.forTarget, {
        targetType: "list",
        targetId: listId,
      }),
    ).toEqual([]);
    expect(await alice.query(api.pages.get, { pageId })).not.toBeNull();
  });

  it("refuses to attach a page to something in another scope", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    // A page in Alice's personal scope…
    const personalPageId = await alice.mutation(api.pages.create, {
      scopeType: "user",
      scopeId: ALICE.subject,
      title: "Private notes",
      markdown: "mine",
    });
    // …and a project in the workspace.
    const wsSpaceId = await t.run(async (ctx) => {
      const spaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", workspaceId),
        )
        .collect();
      return spaces[0]._id;
    });
    const projectId = await alice.mutation(api.projects.create, {
      spaceId: wsSpaceId,
      name: "Shared",
    });

    await expect(
      alice.mutation(api.pages.attach, {
        pageId: personalPageId,
        targetType: "project",
        targetId: projectId,
      }),
    ).rejects.toThrow(/own workspace/i);
  });

  it("a non-member sees nothing and cannot write", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const outsider = t.withIdentity(OUTSIDER);

    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Internal",
      markdown: "secret",
    });

    expect(await outsider.query(api.pages.get, { pageId })).toBeNull();
    expect(
      await outsider.query(api.pages.listForScope, {
        scopeType: "workspace",
        scopeId: workspaceId,
      }),
    ).toEqual([]);
    await expect(
      outsider.mutation(api.pages.update, { pageId, markdown: "defaced" }),
    ).rejects.toThrow();
    await expect(
      outsider.mutation(api.pages.remove, { pageId }),
    ).rejects.toThrow();
  });

  it("deleting a page clears its links and attachments but promotes its children", async () => {
    const { t, workspaceId, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Billing",
    });
    const parentId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Parent",
      markdown: "top",
      attachTo: { targetType: "project", targetId: projectId },
    });
    const childId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Child",
      markdown: "under it",
      parentPageId: parentId,
    });
    await alice.mutation(api.pages.update, {
      pageId: childId,
      markdown: "links to [[Parent]]",
    });

    await alice.mutation(api.pages.remove, { pageId: parentId });

    // The child survives, promoted to top level rather than deleted with it.
    const child = await alice.query(api.pages.get, { pageId: childId });
    expect(child).not.toBeNull();
    expect(child?.page.parentPageId).toBeUndefined();
    expect(child?.outgoing).toEqual([]);

    // The project keeps existing; only the attachment is gone.
    expect(
      await alice.query(api.pages.forTarget, {
        targetType: "project",
        targetId: projectId,
      }),
    ).toEqual([]);
    expect(
      await alice.query(api.projects.get, { projectId }),
    ).not.toBeNull();
  });

  it("lists a scope's pages newest-edited first and filters by search", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Alpha",
      markdown: "about databases",
    });
    const betaId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Beta",
      markdown: "about queues",
    });

    const all = await alice.query(api.pages.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(all[0].pageId).toBe(betaId);

    const found = await alice.query(api.pages.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
      search: "queues",
    });
    expect(found.map((p) => p.title)).toEqual(["Beta"]);
  });
});

describe("pages over the agent API", () => {
  const AGENT_KEY = "cua_test_key_pages_agent";
  const OTHER_KEY = "cua_test_key_other_scope_agent";

  async function seedAgent() {
    const { t, workspaceId, spaceId } = await seed();
    await t.run(async (ctx) => {
      async function agentWithKey(
        name: string,
        parentType: "user" | "workspace",
        parentId: string,
        apiKey: string,
      ) {
        const agentId = await ctx.db.insert("agents", {
          name,
          parentType,
          parentId,
          status: "active",
          createdByClerkId: ALICE.subject,
          createdAt: Date.now(),
        });
        await ctx.db.insert("agentKeys", {
          agentId,
          keyHash: sha256Hex(apiKey),
          keyPrefix: apiKey.slice(0, 12),
          createdAt: Date.now(),
        });
      }
      await agentWithKey("Scribe", "workspace", workspaceId, AGENT_KEY);
      // A second agent bound to the personal scope, to prove the boundary.
      await agentWithKey("Solo", "user", ALICE.subject, OTHER_KEY);
    });
    return { t, workspaceId, spaceId };
  }

  it("writes markdown, reads back exactly what it wrote, and pins it", async () => {
    const { t, spaceId } = await seedAgent();
    const alice = t.withIdentity(ALICE);
    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Billing",
    });

    const md = "# Findings\n\n- the queue drains at 12/s\n- `retry` is off";
    const created = await t.mutation(api.agentApi.writePage, {
      apiKey: AGENT_KEY,
      title: "Findings",
      markdown: md,
      attachTo: { targetType: "project", targetId: projectId },
    });

    const read = await t.query(api.agentApi.readPage, {
      apiKey: AGENT_KEY,
      pageId: created.pageId,
    });
    // Byte-for-byte: no conversion step between what the agent wrote and
    // what is stored.
    expect(read.markdown).toBe(md);
    expect(read.attachedTo).toEqual([
      { targetType: "project", targetId: projectId },
    ]);

    // A human sees the same page pinned to the project.
    const onProject = await alice.query(api.pages.forTarget, {
      targetType: "project",
      targetId: projectId,
    });
    expect(onProject.map((p) => p.pageId)).toEqual([created.pageId]);

    // Updating in place keeps one page rather than making a second.
    await t.mutation(api.agentApi.writePage, {
      apiKey: AGENT_KEY,
      pageId: created.pageId,
      markdown: `${md}\n- fixed`,
    });
    const listed = await t.query(api.agentApi.listPages, { apiKey: AGENT_KEY });
    expect(listed).toHaveLength(1);
    expect(listed[0].pageId).toBe(created.pageId);
  });

  it("refuses to read or attach across a scope boundary", async () => {
    const { t, spaceId } = await seedAgent();
    const alice = t.withIdentity(ALICE);
    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Billing",
    });

    const workspacePage = await t.mutation(api.agentApi.writePage, {
      apiKey: AGENT_KEY,
      title: "Internal",
      markdown: "workspace only",
    });

    // The personal-scope agent can neither see nor read it.
    expect(
      await t.query(api.agentApi.listPages, { apiKey: OTHER_KEY }),
    ).toEqual([]);
    await expect(
      t.query(api.agentApi.readPage, {
        apiKey: OTHER_KEY,
        pageId: workspacePage.pageId,
      }),
    ).rejects.toThrow();

    // …and cannot pin its own page onto the workspace's project.
    const personalPage = await t.mutation(api.agentApi.writePage, {
      apiKey: OTHER_KEY,
      title: "Mine",
      markdown: "personal",
    });
    await expect(
      t.mutation(api.agentApi.writePage, {
        apiKey: OTHER_KEY,
        pageId: personalPage.pageId,
        markdown: "personal",
        attachTo: { targetType: "project", targetId: projectId },
      }),
    ).rejects.toThrow();
  });
});
