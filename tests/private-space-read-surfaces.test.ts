import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Journey: a workspace member locked out of a private space must not
// read that space through the three "I can see everything I belong to"
// surfaces — global search, Home, and workspace export.
//
// Direct reads (spaces.get / lists.get / tasks.get) already refuse.
// These aggregates used to walk every workspace space and skip the
// canAccessSpace gate that reports / sidebar / search.everything apply.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const CREATOR = { subject: "user_creator", email: "creator@acme.com" };
const ADMIN = { subject: "user_admin", email: "admin@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seedWorkspace() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [OWNER, CREATOR, ADMIN, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme-private-reads",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: CREATOR.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ADMIN.subject,
      role: "admin",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OUTSIDER.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    return workspaceId;
  });
  return { t, workspaceId };
}

async function seedSecretAndPublic(
  t: ReturnType<typeof convexTest>,
  workspaceId: Id<"workspaces">,
) {
  const secretSpaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
    name: "Secret vault",
    parentType: "workspace",
    parentId: workspaceId,
  });
  await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
    spaceId: secretSpaceId,
    private: true,
  });
  const secretListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
    name: "Hidden work",
    parentType: "space",
    parentId: secretSpaceId,
  });
  const secretTaskId = await t.withIdentity(CREATOR).mutation(api.tasks.create, {
    listId: secretListId,
    title: "Secret task Alpha",
    assigneeClerkIds: [OUTSIDER.subject],
  });

  const openSpaceId = await t.withIdentity(CREATOR).mutation(api.spaces.create, {
    name: "Open",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const openListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
    name: "Public work",
    parentType: "space",
    parentId: openSpaceId,
  });
  const openTaskId = await t.withIdentity(CREATOR).mutation(api.tasks.create, {
    listId: openListId,
    title: "Public task Alpha",
    assigneeClerkIds: [OUTSIDER.subject],
  });

  return {
    secretSpaceId,
    secretListId,
    secretTaskId,
    openListId,
    openTaskId,
  };
}

describe("private space cannot be read via search / home / export", () => {
  it("search.everything and quickSearch omit secret work for a locked-out member", async () => {
    const { t, workspaceId } = await seedWorkspace();
    const { secretListId, openListId } = await seedSecretAndPublic(t, workspaceId);

    const everything = await t
      .withIdentity(OUTSIDER)
      .query(api.search.everything, { text: "Alpha" });
    expect(everything.tasks.map((hit) => hit.title)).toEqual(["Public task Alpha"]);
    expect(everything.lists.map((hit) => hit.name)).toEqual(["Public work"]);
    expect(everything.spaces.map((hit) => hit.name)).not.toContain("Secret vault");
    expect(everything.tasks.map((hit) => hit.listId)).not.toContain(secretListId);
    expect(everything.lists.map((hit) => hit.listId)).toContain(openListId);

    const quick = await t
      .withIdentity(OUTSIDER)
      .query(api.tasks.quickSearch, { text: "Secret" });
    expect(quick.map((hit) => hit.title)).not.toContain("Secret task Alpha");
    expect(quick.map((hit) => hit.listId)).not.toContain(secretListId);

    const creatorHits = await t
      .withIdentity(CREATOR)
      .query(api.search.everything, { text: "Alpha" });
    expect(creatorHits.tasks.map((hit) => hit.title).sort()).toEqual([
      "Public task Alpha",
      "Secret task Alpha",
    ]);
    const creatorQuick = await t
      .withIdentity(CREATOR)
      .query(api.tasks.quickSearch, { text: "Secret" });
    expect(creatorQuick.map((hit) => hit.title)).toContain("Secret task Alpha");
  });

  it("Home omits secret projects, counts, and ticker titles for a locked-out member", async () => {
    const { t, workspaceId } = await seedWorkspace();
    await seedSecretAndPublic(t, workspaceId);

    const outsiderHome = await t
      .withIdentity(OUTSIDER)
      .query(api.homeOverview.get, {});
    expect(outsiderHome?.projects.map((p) => p.name)).toEqual(["Public work"]);
    expect(outsiderHome?.projects.map((p) => p.place).join(" ")).not.toMatch(
      /Secret vault/,
    );
    // The secret task is assigned to the outsider, but they cannot see
    // inside the private space, so it must not inflate "my" counts.
    expect(outsiderHome?.me.open).toBe(1);
    expect(
      outsiderHome?.ticker.some((row) =>
        (row.entityTitle ?? "").includes("Secret task"),
      ),
    ).toBe(false);

    const creatorHome = await t
      .withIdentity(CREATOR)
      .query(api.homeOverview.get, {});
    expect(creatorHome?.projects.map((p) => p.name).sort()).toEqual([
      "Hidden work",
      "Public work",
    ]);
    expect(
      creatorHome?.ticker.some((row) =>
        (row.entityTitle ?? "").includes("Secret task"),
      ),
    ).toBe(true);
  });

  it("admin export omits a private space the admin cannot enter; owner and creator still export it", async () => {
    const { t, workspaceId } = await seedWorkspace();
    await seedSecretAndPublic(t, workspaceId);

    const adminExport = await t
      .withIdentity(ADMIN)
      .query(api.dataExport.exportWorkspace, { workspaceId });
    expect(adminExport.spaces.map((s) => s.name)).toEqual(["Open"]);
    expect(JSON.stringify(adminExport)).not.toMatch(
      /Secret task Alpha|Hidden work|Secret vault/,
    );
  });

  it("workspace owner can export a private space; a plain member cannot export at all", async () => {
    const { t, workspaceId } = await seedWorkspace();
    await seedSecretAndPublic(t, workspaceId);

    const ownerExport = await t
      .withIdentity(OWNER)
      .query(api.dataExport.exportWorkspace, { workspaceId });
    expect(ownerExport.spaces.map((s) => s.name).sort()).toEqual([
      "Open",
      "Secret vault",
    ]);
    expect(
      ownerExport.spaces
        .find((s) => s.name === "Secret vault")
        ?.lists.some((list) =>
          list.tasks.some((task) => task.title === "Secret task Alpha"),
        ),
    ).toBe(true);

    await expect(
      t.withIdentity(OUTSIDER).query(api.dataExport.exportWorkspace, {
        workspaceId,
      }),
    ).rejects.toThrow(/owners and admins/i);
  });
});
