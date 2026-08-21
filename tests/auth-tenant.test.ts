import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Tenant isolation: private-space reads must not leak to ordinary members,
// and a transferred workspace owner must receive (and the demoted creator
// must lose) owner powers. These two used to disagree — access followed
// the stale workspaces.ownerClerkId pointer.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice", email: "alice@acme.com" };
const BOB = { subject: "user_bob", email: "bob@acme.com" };
const CAROL = { subject: "user_carol", email: "carol@acme.com" };
const STRANGER = { subject: "user_stranger", email: "stranger@other.com" };

async function seedWorkspace() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const u of [ALICE, BOB, CAROL, STRANGER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: u.email,
        name: u.subject,
      });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme-tenant",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ALICE.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: BOB.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: CAROL.subject,
      role: "admin",
      joinedAt: Date.now(),
    });
    return { workspaceId };
  });
  return { t, ...ids };
}

describe("owner transfer", () => {
  it("gives a promoted owner private-space access and takes it from the demoted creator", async () => {
    const { t, workspaceId } = await seedWorkspace();

    const spaceId = await t.withIdentity(BOB).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(BOB).mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
    });
    const listId = await t.withIdentity(BOB).mutation(api.lists.create, {
      name: "Hidden work",
      parentType: "space",
      parentId: spaceId,
    });
    await t.withIdentity(BOB).mutation(api.tasks.create, {
      listId,
      title: "Secret task",
    });

    // Before transfer: Alice (ownerClerkId + membership owner) sees it;
    // Carol (admin) does not.
    expect(
      await t.withIdentity(ALICE).query(api.spaces.get, { spaceId }),
    ).not.toBeNull();
    expect(
      await t.withIdentity(CAROL).query(api.spaces.get, { spaceId }),
    ).toBeNull();

    await t.withIdentity(ALICE).mutation(api.workspaces.updateMemberRole, {
      workspaceId,
      memberClerkId: BOB.subject,
      role: "owner",
    });
    await t.withIdentity(ALICE).mutation(api.workspaces.updateMemberRole, {
      workspaceId,
      memberClerkId: ALICE.subject,
      role: "member",
    });

    const ws = await t.run(async (ctx) => ctx.db.get(workspaceId));
    expect(ws?.ownerClerkId).toBe(BOB.subject);

    // Promoted owner sees the private space. Demoted creator does not
    // (they are not the space creator — Bob is).
    expect(
      await t.withIdentity(BOB).query(api.spaces.get, { spaceId }),
    ).not.toBeNull();
    expect(
      await t.withIdentity(ALICE).query(api.spaces.get, { spaceId }),
    ).toBeNull();

    const listed = await t
      .withIdentity(ALICE)
      .query(api.spaces.listForWorkspace, { workspaceId });
    expect(listed.map((s) => s.name)).not.toContain("Secret");

    const tree = await t.withIdentity(ALICE).query(api.sidebar.tree, {});
    const acme = tree?.workspaces.find((w) => w._id === workspaceId);
    expect(acme?.spaces.map((s) => s.name)).not.toContain("Secret");
  });

  it("lets a promoted owner OAuth-authorize a workspace agent", async () => {
    const { t, workspaceId } = await seedWorkspace();
    const agentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", {
        name: "Fleet",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        role: "member",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      }),
    );
    await t.mutation(api.oauth.registerClient, {
      clientId: "opc_transfer",
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      registrationSubject: "transfer-test",
    });

    await t.withIdentity(ALICE).mutation(api.workspaces.updateMemberRole, {
      workspaceId,
      memberClerkId: BOB.subject,
      role: "owner",
    });
    await t.withIdentity(ALICE).mutation(api.workspaces.updateMemberRole, {
      workspaceId,
      memberClerkId: ALICE.subject,
      role: "member",
    });

    const challenge = "c".repeat(43);
    const request = await t.withIdentity(BOB).query(
      api.oauth.authorizationRequest,
      {
        clientId: "opc_transfer",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope: "operate:read",
        resource: "https://operate.to/api/mcp",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
    );
    expect(request.agents.map((a) => a.agentId)).toContain(agentId);

    const demoted = await t.withIdentity(ALICE).query(
      api.oauth.authorizationRequest,
      {
        clientId: "opc_transfer",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope: "operate:read",
        resource: "https://operate.to/api/mcp",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
    );
    expect(demoted.agents).toEqual([]);
  });
});

describe("private-space aggregate leaks", () => {
  async function seedSecretTask() {
    const { t, workspaceId } = await seedWorkspace();
    const spaceId = await t.withIdentity(BOB).mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await t.withIdentity(BOB).mutation(api.spaces.updateMeta, {
      spaceId,
      private: true,
    });
    const listId = await t.withIdentity(BOB).mutation(api.lists.create, {
      name: "Hidden work",
      parentType: "space",
      parentId: spaceId,
    });
    const taskId = await t.withIdentity(BOB).mutation(api.tasks.create, {
      listId,
      title: "Secret task",
      assigneeClerkIds: [CAROL.subject],
    });
    return { t, workspaceId, listId, taskId };
  }

  it("keeps private-space projects off Home, My Work, and ⌘K for an excluded member", async () => {
    const { t, listId } = await seedSecretTask();

    const home = await t.withIdentity(CAROL).query(api.homeOverview.get, {});
    expect(home?.projects.map((p) => p.name)).not.toContain("Hidden work");

    const mine = await t.withIdentity(CAROL).query(api.myWork.listForCurrent, {});
    expect(mine?.map((row) => row.title)).not.toContain("Secret task");

    const hits = await t.withIdentity(CAROL).query(api.tasks.quickSearch, {
      text: "Secret",
    });
    expect(hits.map((h) => h.title)).not.toContain("Secret task");
    expect(hits.map((h) => h.listId)).not.toContain(listId);
  });

  it("omits private-space data from an admin export", async () => {
    const { t, workspaceId } = await seedSecretTask();
    const exported = await t
      .withIdentity(CAROL)
      .query(api.dataExport.exportWorkspace, { workspaceId });
    expect(exported.spaces.map((s) => s.name)).not.toContain("Secret");
  });

  it("does not offer private-space lists as chat reference targets", async () => {
    const { t, workspaceId, listId } = await seedSecretTask();
    const targets = await t.withIdentity(CAROL).query(api.chat.referenceTargets, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(targets.map((row) => row.id)).not.toContain(listId);
  });
});

describe("cross-workspace reads", () => {
  it("resolveRefs returns a null href for a task in another workspace", async () => {
    const { t, workspaceId } = await seedWorkspace();
    const other = await t.run(async (ctx) => {
      const otherWs = await ctx.db.insert("workspaces", {
        name: "Other Co",
        slug: "other-co",
        ownerClerkId: STRANGER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: otherWs,
        userClerkId: STRANGER.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      const spaceId = await ctx.db.insert("spaces", {
        name: "HQ",
        parentType: "workspace",
        parentId: otherWs,
        position: 0,
        createdAt: Date.now(),
      });
      const listId = await ctx.db.insert("lists", {
        name: "Foreign",
        parentType: "space",
        parentId: spaceId,
        position: 0,
        createdAt: Date.now(),
      });
      const statusId = await ctx.db.insert("listStatuses", {
        listId,
        name: "To Do",
        color: "#aaa",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      const taskId = await ctx.db.insert("tasks", {
        listId,
        title: "Foreign secret",
        statusId,
        assigneeClerkIds: [],
        createdByClerkId: STRANGER.subject,
        position: 0,
        createdAt: Date.now(),
      });
      return { taskId, listId };
    });

    const resolved = await t.withIdentity(ALICE).query(api.chat.resolveRefs, {
      refs: [
        { kind: "task", id: other.taskId, label: "Foreign secret" },
        { kind: "list", id: other.listId, label: "Foreign" },
      ],
    });
    expect(resolved.map((r) => r.href)).toEqual([null, null]);
    void workspaceId;
  });

  it("listByClerkIds does not return a user the caller shares no workspace with", async () => {
    const { t } = await seedWorkspace();
    const found = await t.withIdentity(ALICE).query(api.users.listByClerkIds, {
      clerkIds: [STRANGER.subject, BOB.subject],
    });
    expect(found.map((u) => u.clerkId)).toEqual([BOB.subject]);
    expect(found.map((u) => u.email)).not.toContain(STRANGER.email);
  });

  it("pages.get withholds a personal-space backlink from a workspace teammate", async () => {
    const { t, workspaceId } = await seedWorkspace();
    const { workspacePageId, personalPageId } = await t.run(async (ctx) => {
      const workspacePageId = await ctx.db.insert("pages", {
        scopeType: "workspace",
        scopeId: workspaceId,
        title: "Shared brief",
        markdown: "Team notes",
        createdByActorId: ALICE.subject,
        createdByName: "Alice",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        position: 0,
      });
      const personalPageId = await ctx.db.insert("pages", {
        scopeType: "user",
        scopeId: ALICE.subject,
        title: "Alice private diary",
        markdown: "Salary negotiation notes and a secret excerpt.",
        createdByActorId: ALICE.subject,
        createdByName: "Alice",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        position: 0,
      });
      await ctx.db.insert("pageLinks", {
        fromPageId: personalPageId,
        toPageId: workspacePageId,
      });
      return { workspacePageId, personalPageId };
    });

    const asBob = await t.withIdentity(BOB).query(api.pages.get, {
      pageId: workspacePageId,
    });
    expect(asBob?.backlinks.map((b) => b.pageId)).not.toContain(personalPageId);
    expect(JSON.stringify(asBob?.backlinks)).not.toMatch(/diary|Salary/i);

    const asAlice = await t.withIdentity(ALICE).query(api.pages.get, {
      pageId: workspacePageId,
    });
    expect(asAlice?.backlinks.map((b) => b.pageId)).toContain(personalPageId);
  });
});
