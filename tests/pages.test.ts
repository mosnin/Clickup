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
  mentionContext,
  mentionedActorIds,
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

describe("roadmap ↔ workstream connection", () => {
  const AGENT_KEY = "cua_test_key_roadmap_agent";

  it("create_project places a workstream on the roadmap in one call", async () => {
    const { t, workspaceId, spaceId } = await seed();
    await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        name: "Planner",
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

    const roadmap = await t.mutation(api.agentApi.createRoadmap, {
      apiKey: AGENT_KEY,
      name: "Delivery",
      phases: [{ name: "M1" }, { name: "M2" }],
    });

    // The whole point: structure and sequencing in one call. Three separate
    // calls is how five workstreams ended up beside a roadmap that
    // referenced none of them.
    const projectId = await t.mutation(api.agentApi.createProject, {
      apiKey: AGENT_KEY,
      spaceId,
      name: "Ingest pipeline",
      description: "Everything that gets data in",
      targetDate: 1_800_000_000_000,
      roadmapId: roadmap.roadmapId,
      phaseId: roadmap.phases[1].id,
    });

    const roadmaps = await t.query(api.agentApi.getRoadmaps, {
      apiKey: AGENT_KEY,
    });
    const rm = roadmaps.find((r) => r.roadmapId === roadmap.roadmapId)!;
    expect(rm.projects).toHaveLength(1);
    expect(rm.projects[0]).toMatchObject({
      projectId,
      name: "Ingest pipeline",
      phaseId: roadmap.phases[1].id,
      targetDate: 1_800_000_000_000,
    });

    // And the project itself carries the placement, so the link reads the
    // same from either direction.
    const project = await t.run(async (ctx) => await ctx.db.get(projectId));
    expect(project?.roadmapId).toBe(roadmap.roadmapId);
    expect(project?.roadmapPhaseId).toBe(roadmap.phases[1].id);
  });
});

describe("mentions in a page", () => {
  it("finds the tokens an agent wrote, and the sentence around them", () => {
    const md = [
      "# Handoff",
      "",
      "@[Ada Lovelace](user_alice) owns the schema change; ping",
      "@[Scout](ag_1) once the migration lands.",
    ].join("\n");

    expect(mentionedActorIds(md)).toEqual(["user_alice", "ag_1"]);
    // Not the first 180 characters of the page — the part that says why.
    const context = mentionContext(md, "ag_1");
    expect(context).toContain("Scout");
    expect(context).toContain("migration lands");
  });

  it("ignores a bare markdown link that only looks like a mention", () => {
    expect(mentionedActorIds("See [the RFC](https://x.test).")).toEqual([]);
  });

  it("notifies a tagged teammate and reaches their inbox", async () => {
    const { t, workspaceId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userClerkId: OUTSIDER.subject,
        workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const alice = t.withIdentity(ALICE);

    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Handoff",
      markdown: `Please review, @[Outsider](${OUTSIDER.subject}).`,
    });

    const inbox = await t
      .withIdentity(OUTSIDER)
      .query(api.mentions.feedForCurrent, {});
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      parentType: "page",
      href: `/dashboard/pages/${pageId}`,
      contextLabel: "Handoff",
    });
    // A page mention has no message behind it, so the row carries its own
    // snippet and author or the inbox card renders blank.
    expect(inbox[0].body).toContain("Please review");
    expect(inbox[0].authorName).toBe(ALICE.subject);
  });

  it("does not re-notify on every keystroke", async () => {
    const { t, workspaceId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userClerkId: OUTSIDER.subject,
        workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const alice = t.withIdentity(ALICE);
    const token = `@[Outsider](${OUTSIDER.subject})`;

    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Handoff",
      markdown: token,
    });
    // A page saves every few hundred milliseconds while someone types.
    for (const suffix of [" a", " ab", " abc"]) {
      await alice.mutation(api.pages.update, {
        pageId,
        markdown: token + suffix,
      });
    }

    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("mentions")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "page").eq("parentId", pageId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses to notify someone who can't read the page", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    // OUTSIDER is not a member of this workspace.
    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      markdown: `@[Outsider](${OUTSIDER.subject}) take a look`,
    });
    const inbox = await t
      .withIdentity(OUTSIDER)
      .query(api.mentions.feedForCurrent, {});
    expect(inbox).toHaveLength(0);
  });

  it("takes its mentions with it when the page is deleted", async () => {
    const { t, workspaceId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userClerkId: OUTSIDER.subject,
        workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      markdown: `@[Outsider](${OUTSIDER.subject}) hello`,
    });
    await alice.mutation(api.pages.remove, { pageId });

    const inbox = await t
      .withIdentity(OUTSIDER)
      .query(api.mentions.feedForCurrent, {});
    expect(inbox).toHaveLength(0);
  });
});

describe("nesting", () => {
  it("reports the trail up and the pages inside", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const rootId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Architecture",
    });
    const childId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Storage",
      parentPageId: rootId,
    });
    const grandchildId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Blob layout",
      parentPageId: childId,
    });

    const deep = await alice.query(api.pages.get, { pageId: grandchildId });
    expect(deep?.ancestors.map((a) => a.title)).toEqual([
      "Architecture",
      "Storage",
    ]);

    const middle = await alice.query(api.pages.get, { pageId: childId });
    expect(middle?.children.map((c) => c.title)).toEqual(["Blob layout"]);
  });

  it("refuses a move that would make a page its own ancestor", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const parentId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Parent",
    });
    const childId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Child",
      parentPageId: parentId,
    });

    // A cycle would detach both from every root: the index only walks down.
    await expect(
      alice.mutation(api.pages.update, {
        pageId: parentId,
        parentPageId: childId,
      }),
    ).rejects.toThrow(/inside itself/);
  });

  it("keeps nesting inside one workspace", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const inWorkspace = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Team page",
    });
    const personal = await alice.mutation(api.pages.create, {
      scopeType: "user",
      scopeId: ALICE.subject,
      title: "My page",
    });
    await expect(
      alice.mutation(api.pages.update, {
        pageId: personal,
        parentPageId: inWorkspace,
      }),
    ).rejects.toThrow(/different workspace/);
  });
});

describe("concurrent edits", () => {
  it("refuses a save built on a version someone else has replaced", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "original",
    });
    const loaded = await alice.query(api.pages.get, { pageId });
    const base = loaded!.page.updatedAt;

    // An agent writes while the person is still typing.
    const after = await alice.mutation(api.pages.update, {
      pageId,
      markdown: "the agent's version",
    });
    expect(after.updatedAt).not.toBe(base);

    await expect(
      alice.mutation(api.pages.update, {
        pageId,
        markdown: "the person's version",
        expectedUpdatedAt: base,
      }),
    ).rejects.toThrow(/edited this page while you were writing/);

    // And the refusal is a refusal: the stored text is untouched.
    const now = await alice.query(api.pages.get, { pageId });
    expect(now!.page.markdown).toBe("the agent's version");
  });

  it("lets a save through when nothing has moved", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      markdown: "original",
    });
    const loaded = await alice.query(api.pages.get, { pageId });
    await alice.mutation(api.pages.update, {
      pageId,
      markdown: "mine",
      expectedUpdatedAt: loaded!.page.updatedAt,
    });
    const now = await alice.query(api.pages.get, { pageId });
    expect(now!.page.markdown).toBe("mine");
  });
});

describe("search", () => {
  it("finds a page by a word in its body and by its title", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Runbook",
      markdown: "Restart the ingest worker when the queue backs up.",
    });
    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Billing migration",
      markdown: "Moving off the legacy provider.",
    });

    const byBody = await alice.query(api.pages.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
      search: "ingest",
    });
    expect(byBody.map((p) => p.title)).toEqual(["Runbook"]);

    // The body index covers `markdown` only, so a title-only match has to
    // come from somewhere — and "the page called X" is the search people
    // actually run.
    const byTitle = await alice.query(api.pages.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
      search: "Billing",
    });
    expect(byTitle.map((p) => p.title)).toEqual(["Billing migration"]);
  });

  it("returns a page once when both its title and body match", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Runbook",
      markdown: "This runbook covers restarts.",
    });
    const hits = await alice.query(api.pages.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
      search: "runbook",
    });
    expect(hits).toHaveLength(1);
  });

  it("never reaches outside the scope", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Team secret",
      markdown: "shibboleth",
    });
    await alice.mutation(api.pages.create, {
      scopeType: "user",
      scopeId: ALICE.subject,
      title: "My note",
      markdown: "shibboleth",
    });
    const personal = await alice.query(api.pages.listForScope, {
      scopeType: "user",
      scopeId: ALICE.subject,
      search: "shibboleth",
    });
    expect(personal.map((p) => p.title)).toEqual(["My note"]);
  });
});

describe("discussion on a page", () => {
  it("keeps the conversation beside the document, not inside it", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Architecture",
      markdown: "# Architecture",
    });
    await alice.mutation(api.messages.create, {
      parentType: "page",
      parentId: pageId,
      body: "Should we split the storage section out?",
    });

    const thread = await alice.query(api.messages.listForParent, {
      parentType: "page",
      parentId: pageId,
    });
    expect(thread).toHaveLength(1);
    // The page's own bytes are untouched — an agent reading it gets the
    // decision, not the argument.
    const page = await alice.query(api.pages.get, { pageId });
    expect(page!.page.markdown).toBe("# Architecture");
  });

  it("refuses a comment from someone who can't read the page", async () => {
    const { t, workspaceId } = await seed();
    const pageId = await t.withIdentity(ALICE).mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Team only",
    });
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.messages.create, {
        parentType: "page",
        parentId: pageId,
        body: "let me in",
      }),
    ).rejects.toThrow();
  });

  it("a comment mention does not suppress a later mention in the page body", async () => {
    const { t, workspaceId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userClerkId: OUTSIDER.subject,
        workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Architecture",
    });

    // Both land on parentType "page" with the same parentId, so the body
    // dedupe has to distinguish them or this notification vanishes.
    await alice.mutation(api.messages.create, {
      parentType: "page",
      parentId: pageId,
      body: `@[Outsider](${OUTSIDER.subject}) thoughts?`,
      mentionClerkIds: [OUTSIDER.subject],
    });
    await alice.mutation(api.pages.update, {
      pageId,
      markdown: `Owner: @[Outsider](${OUTSIDER.subject})`,
    });

    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("mentions")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "page").eq("parentId", pageId),
        )
        .collect(),
    );
    // One from the comment (has a messageId), one from the body (doesn't).
    expect(rows.filter((r) => r.messageId !== undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.messageId === undefined)).toHaveLength(1);
  });

  it("takes the discussion with it when the page is deleted", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Architecture",
    });
    await alice.mutation(api.messages.create, {
      parentType: "page",
      parentId: pageId,
      body: "a thought",
    });
    await alice.mutation(api.pages.remove, { pageId });

    const orphans = await t.run(async (ctx) =>
      await ctx.db
        .query("messages")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "page").eq("parentId", pageId),
        )
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});

describe("page history", () => {
  const BOB = { subject: "user_bob" };

  /** Add a second workspace member, since "who changed this" needs two people. */
  async function addBob(
    t: Awaited<ReturnType<typeof seed>>["t"],
    workspaceId: Id<"workspaces">,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: BOB.subject,
        email: "bob@example.com",
        name: "user_bob",
      });
      await ctx.db.insert("memberships", {
        userClerkId: BOB.subject,
        workspaceId,
        role: "member",
        joinedAt: Date.now(),
      });
    });
  }

  async function countRevisions(
    t: Awaited<ReturnType<typeof seed>>["t"],
    pageId: Id<"pages">,
  ) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pageRevisions")
        .withIndex("by_page", (q) => q.eq("pageId", pageId))
        .collect();
      return rows.length;
    });
  }

  it("collapses one author's burst of saves into a single restorable version", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "the original",
    });

    // The editor saves every ~700ms. Three saves is one editing session.
    await alice.mutation(api.pages.update, { pageId, markdown: "the o" });
    await alice.mutation(api.pages.update, { pageId, markdown: "the or" });
    await alice.mutation(api.pages.update, { pageId, markdown: "rewritten" });

    const history = await alice.query(api.pages.history, { pageId });
    expect(history).toHaveLength(1);

    // And the one version kept is the state before the session started, not
    // the half-typed middle of it — otherwise restoring undoes one keystroke.
    const full = await alice.query(api.pages.readRevision, {
      revisionId: history[0].revisionId,
    });
    expect(full!.markdown).toBe("the original");
  });

  it("opens a new version when a different author edits", async () => {
    const { t, workspaceId } = await seed();
    await addBob(t, workspaceId);
    const alice = t.withIdentity(ALICE);
    const bob = t.withIdentity(BOB);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "alice wrote this",
    });

    await alice.mutation(api.pages.update, { pageId, markdown: "alice again" });
    await bob.mutation(api.pages.update, { pageId, markdown: "bob's turn" });

    const history = await alice.query(api.pages.history, { pageId });
    expect(history).toHaveLength(2);
    // Newest first, and each row is attributed to whoever displaced it.
    expect(history[0].actorId).toBe(BOB.subject);
    expect(history[1].actorId).toBe(ALICE.subject);

    const displacedByBob = await alice.query(api.pages.readRevision, {
      revisionId: history[0].revisionId,
    });
    expect(displacedByBob!.markdown).toBe("alice again");
  });

  it("records a version for a title-only rename", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Draft",
      markdown: "body",
    });
    await alice.mutation(api.pages.update, { pageId, title: "Final" });

    const history = await alice.query(api.pages.history, { pageId });
    expect(history).toHaveLength(1);
    const full = await alice.query(api.pages.readRevision, {
      revisionId: history[0].revisionId,
    });
    expect(full!.title).toBe("Draft");
  });

  it("records nothing for a save that changes nothing", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "unchanged",
    });

    // The editor re-sends the same bytes on focus/blur. That is not an edit,
    // and a history full of no-op rows is a history nobody scrolls.
    await alice.mutation(api.pages.update, { pageId, markdown: "unchanged" });
    await alice.mutation(api.pages.update, { pageId, title: "Spec" });

    expect(await alice.query(api.pages.history, { pageId })).toHaveLength(0);
  });

  it("keeps at most fifty versions, dropping the oldest", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "current",
    });

    // Seed past the cap directly: coalescing means a real burst can't produce
    // 60 rows, and the prune has to hold regardless of how they got there.
    // Stamped in the past so the next write opens a new revision rather than
    // extending one of these.
    await t.run(async (ctx) => {
      const old = Date.now() - 24 * 60 * 60 * 1000;
      for (let i = 0; i < 60; i += 1) {
        await ctx.db.insert("pageRevisions", {
          pageId,
          title: "Spec",
          markdown: `version ${i}`,
          actorId: ALICE.subject,
          actorName: "user_alice",
          createdAt: old + i,
          updatedAt: old + i,
        });
      }
    });

    await alice.mutation(api.pages.update, { pageId, markdown: "newest" });

    expect(await countRevisions(t, pageId)).toBe(50);
    const history = await alice.query(api.pages.history, { pageId, limit: 50 });
    // The newest row is the one just written; the oldest seeded ones are gone.
    const kept = await Promise.all(
      history.map((h) =>
        alice.query(api.pages.readRevision, { revisionId: h.revisionId }),
      ),
    );
    const bodies = kept.map((k) => k!.markdown);
    expect(bodies[0]).toBe("current");
    expect(bodies).toContain("version 59");
    expect(bodies).not.toContain("version 0");
  });

  it("makes restoring itself undoable", async () => {
    const { t, workspaceId } = await seed();
    await addBob(t, workspaceId);
    const alice = t.withIdentity(ALICE);
    const bob = t.withIdentity(BOB);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "the good version",
    });
    await bob.mutation(api.pages.update, { pageId, markdown: "the mistake" });

    const history = await alice.query(api.pages.history, { pageId });
    await alice.mutation(api.pages.restoreRevision, {
      revisionId: history[0].revisionId,
    });

    const restored = await alice.query(api.pages.get, { pageId });
    expect(restored!.page.markdown).toBe("the good version");

    // Restoring went through the ordinary update path, so what it replaced is
    // in history too — which is the whole reason this needs no confirmation.
    const after = await alice.query(api.pages.history, { pageId });
    const newest = await alice.query(api.pages.readRevision, {
      revisionId: after[0].revisionId,
    });
    expect(newest!.markdown).toBe("the mistake");

    await alice.mutation(api.pages.restoreRevision, {
      revisionId: after[0].revisionId,
    });
    const back = await alice.query(api.pages.get, { pageId });
    expect(back!.page.markdown).toBe("the mistake");
  });

  it("deletes a page's versions with the page", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "one",
    });
    await alice.mutation(api.pages.update, { pageId, markdown: "two" });
    expect(await countRevisions(t, pageId)).toBe(1);

    await alice.mutation(api.pages.remove, { pageId });
    expect(await countRevisions(t, pageId)).toBe(0);
  });

  it("keeps history inside the workspace", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      title: "Spec",
      markdown: "internal",
    });
    await alice.mutation(api.pages.update, { pageId, markdown: "still internal" });
    const history = await alice.query(api.pages.history, { pageId });

    const outsider = t.withIdentity(OUTSIDER);
    expect(await outsider.query(api.pages.history, { pageId })).toEqual([]);
    // Not just the list — an old version is page content and leaks the same
    // text, so reading one by id is access-checked on the page, not the row.
    expect(
      await outsider.query(api.pages.readRevision, {
        revisionId: history[0].revisionId,
      }),
    ).toBeNull();
    await expect(
      outsider.mutation(api.pages.restoreRevision, {
        revisionId: history[0].revisionId,
      }),
    ).rejects.toThrow();
  });
});
