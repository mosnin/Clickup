import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Regression coverage for the F2 fixes:
//   1. reports.workspaceSummary and team.hub must not aggregate data from
//      private spaces the caller can't access, nor from archived spaces.
//   2. homeOverview.get and myWork.listForCurrent must not count archived
//      spaces toward Home tiles / "My Work".

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const CREATOR = { subject: "user_creator", email: "creator@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, CREATOR, OUTSIDER]) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: u.subject,
        role: u === OWNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    return workspaceId;
  });
}

describe("reports.workspaceSummary / team.hub privacy + archive filtering", () => {
  it("does not leak private-space task counts to an excluded member", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);

    // A private space CREATOR owns; OUTSIDER is a workspace member but not
    // a listed member of the private space.
    const secretSpaceId = await t
      .withIdentity(CREATOR)
      .mutation(api.spaces.create, {
        name: "Secret",
        parentType: "workspace",
        parentId: workspaceId,
      });
    await t.withIdentity(CREATOR).mutation(api.spaces.updateMeta, {
      spaceId: secretSpaceId,
      private: true,
    });
    const secretListId = await t
      .withIdentity(CREATOR)
      .mutation(api.lists.create, {
        name: "Hidden work",
        parentType: "space",
        parentId: secretSpaceId,
      });
    await t.withIdentity(CREATOR).mutation(api.tasks.create, {
      listId: secretListId,
      title: "Secret task",
      assigneeClerkIds: [CREATOR.subject],
    });

    // A normal, visible space + task so the summary isn't trivially empty.
    const openSpaceId = await t
      .withIdentity(CREATOR)
      .mutation(api.spaces.create, {
        name: "Open",
        parentType: "workspace",
        parentId: workspaceId,
      });
    const openListId = await t.withIdentity(CREATOR).mutation(api.lists.create, {
      name: "Public work",
      parentType: "space",
      parentId: openSpaceId,
    });
    await t.withIdentity(CREATOR).mutation(api.tasks.create, {
      listId: openListId,
      title: "Public task",
      assigneeClerkIds: [CREATOR.subject],
    });

    // OUTSIDER (workspace member, excluded from the private space) must see
    // only the public task in both aggregates.
    const outsiderSummary = await t
      .withIdentity(OUTSIDER)
      .query(api.reports.workspaceSummary, { workspaceId });
    expect(outsiderSummary?.taskCounts.total).toBe(1);

    const outsiderHub = await t
      .withIdentity(OUTSIDER)
      .query(api.team.hub, { workspaceId });
    const creatorRow = outsiderHub!.find(
      (r: { clerkId: string }) => r.clerkId === CREATOR.subject,
    );
    expect(creatorRow?.openTasks).toBe(1);

    // CREATOR (has access to the private space) sees both.
    const creatorSummary = await t
      .withIdentity(CREATOR)
      .query(api.reports.workspaceSummary, { workspaceId });
    expect(creatorSummary?.taskCounts.total).toBe(2);

    const creatorHub = await t
      .withIdentity(CREATOR)
      .query(api.team.hub, { workspaceId });
    const creatorRow2 = creatorHub!.find(
      (r: { clerkId: string }) => r.clerkId === CREATOR.subject,
    );
    expect(creatorRow2?.openTasks).toBe(2);
  });

  it("excludes archived spaces from workspaceSummary and team.hub", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);

    const archivedSpaceId = await t
      .withIdentity(OWNER)
      .mutation(api.spaces.create, {
        name: "Old",
        parentType: "workspace",
        parentId: workspaceId,
      });
    const archivedListId = await t
      .withIdentity(OWNER)
      .mutation(api.lists.create, {
        name: "Old list",
        parentType: "space",
        parentId: archivedSpaceId,
      });
    await t.withIdentity(OWNER).mutation(api.tasks.create, {
      listId: archivedListId,
      title: "Stale task",
      assigneeClerkIds: [OWNER.subject],
    });
    await t.withIdentity(OWNER).mutation(api.spaces.updateMeta, {
      spaceId: archivedSpaceId,
      archived: true,
    });

    const summary = await t
      .withIdentity(OWNER)
      .query(api.reports.workspaceSummary, { workspaceId });
    expect(summary?.taskCounts.total).toBe(0);

    const hub = await t.withIdentity(OWNER).query(api.team.hub, { workspaceId });
    const ownerRow = hub!.find(
      (r: { clerkId: string }) => r.clerkId === OWNER.subject,
    );
    expect(ownerRow?.openTasks).toBe(0);
  });
});

describe("homeOverview / myWork archive filtering", () => {
  it("does not count archived-space tasks toward Home or My Work", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: OWNER.subject,
        email: OWNER.email,
      });
    });

    const personalSpaceId = await t
      .withIdentity(OWNER)
      .mutation(api.spaces.create, {
        name: "Personal",
        parentType: "user",
        parentId: OWNER.subject,
      });
    const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
      name: "Someday",
      parentType: "space",
      parentId: personalSpaceId,
    });
    await t.withIdentity(OWNER).mutation(api.tasks.create, {
      listId,
      title: "Archived task",
      assigneeClerkIds: [OWNER.subject],
    });

    const beforeMyWork = await t
      .withIdentity(OWNER)
      .query(api.myWork.listForCurrent, {});
    expect(beforeMyWork).toHaveLength(1);
    const beforeOverview = await t
      .withIdentity(OWNER)
      .query(api.homeOverview.get, {});
    expect(beforeOverview?.me.open).toBe(1);

    await t.withIdentity(OWNER).mutation(api.spaces.updateMeta, {
      spaceId: personalSpaceId,
      archived: true,
    });

    const afterMyWork = await t
      .withIdentity(OWNER)
      .query(api.myWork.listForCurrent, {});
    expect(afterMyWork).toEqual([]);

    const afterOverview = await t
      .withIdentity(OWNER)
      .query(api.homeOverview.get, {});
    expect(afterOverview?.me.open).toBe(0);
    expect(afterOverview?.totalProjects).toBe(0);
  });
});
