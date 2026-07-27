import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Folders are first-class siblings of lists inside a Space. The rules that
// matter and can't be re-derived from the UI:
//
//  1. A list can move into a project and back out, keeping everything.
//  2. A move can never cross a Space boundary (a Space is an access
//     boundary — crossing it would silently change who sees the tasks).
//  3. Deleting a project is a GROUPING change, not a content deletion: its
//     lists move up to the parent Space with their tasks intact.
//  4. Project positions and list positions are independent sequences, so
//     reordering one can't corrupt the other.

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
    const otherSpaceId = await ctx.db.insert("spaces", {
      name: "Lab",
      parentType: "workspace",
      parentId: workspaceId,
      position: 1,
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, otherSpaceId };
  });
  return { t, ...ids };
}

describe("lists.move", () => {
  it("moves a list into a project and back out, landing at the end each time", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Q3",
    });
    const listId = await alice.mutation(api.lists.create, {
      name: "Roadmap",
      parentType: "space",
      parentId: spaceId,
    });
    // A list already sitting in the project, so "end of destination" is
    // an actual claim and not vacuously position 0.
    await alice.mutation(api.lists.create, {
      name: "Existing",
      parentType: "project",
      parentId: projectId,
    });

    await alice.mutation(api.lists.move, {
      listId,
      parentType: "project",
      parentId: projectId,
    });

    let list = await alice.query(api.lists.get, { listId });
    expect(list?.parentType).toBe("project");
    expect(list?.parentId).toBe(projectId);
    expect(list?.position).toBe(1);

    // …and back out to the Space.
    await alice.mutation(api.lists.move, {
      listId,
      parentType: "space",
      parentId: spaceId,
    });
    list = await alice.query(api.lists.get, { listId });
    expect(list?.parentType).toBe("space");
    expect(list?.parentId).toBe(spaceId);

    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events.filter((e) => e.type === "list.moved")).toHaveLength(2);
    expect(events.some((e) => e.type === "project.created")).toBe(true);
  });

  it("keeps the list's tasks when it moves", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Q3",
    });
    const listId = await alice.mutation(api.lists.create, {
      name: "Roadmap",
      parentType: "space",
      parentId: spaceId,
    });
    const statusId = await t.run(async (ctx) => {
      const s = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .first();
      return s!._id;
    });
    await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship it",
      statusId,
    });

    await alice.mutation(api.lists.move, {
      listId,
      parentType: "project",
      parentId: projectId,
    });

    const tasks = await t.run((ctx) =>
      ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Ship it");
  });

  it("refuses a destination project in a different Space", async () => {
    const { t, spaceId, otherSpaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const foreignFolderId = await alice.mutation(api.projects.create, {
      spaceId: otherSpaceId,
      name: "Elsewhere",
    });
    const listId = await alice.mutation(api.lists.create, {
      name: "Roadmap",
      parentType: "space",
      parentId: spaceId,
    });

    await expect(
      alice.mutation(api.lists.move, {
        listId,
        parentType: "project",
        parentId: foreignFolderId,
      }),
    ).rejects.toThrow(ConvexError);

    const list = await alice.query(api.lists.get, { listId });
    expect(list?.parentId).toBe(spaceId);
  });

  it("refuses a mover who can't reach the space", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Q3",
    });
    const listId = await alice.mutation(api.lists.create, {
      name: "Roadmap",
      parentType: "space",
      parentId: spaceId,
    });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.lists.move, {
        listId,
        parentType: "project",
        parentId: projectId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  it("is a no-op (no event) when the destination is where it already is", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const listId = await alice.mutation(api.lists.create, {
      name: "Roadmap",
      parentType: "space",
      parentId: spaceId,
    });

    await alice.mutation(api.lists.move, {
      listId,
      parentType: "space",
      parentId: spaceId,
    });

    const moved = await t.run((ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "list.moved"))
        .collect(),
    );
    expect(moved).toHaveLength(0);
  });
});

describe("projects.remove", () => {
  it("moves its lists up to the Space instead of deleting them", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const directId = await alice.mutation(api.lists.create, {
      name: "Direct",
      parentType: "space",
      parentId: spaceId,
    });
    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Q3",
    });
    const insideA = await alice.mutation(api.lists.create, {
      name: "Inside A",
      parentType: "project",
      parentId: projectId,
    });
    const insideB = await alice.mutation(api.lists.create, {
      name: "Inside B",
      parentType: "project",
      parentId: projectId,
    });
    const statusId = await t.run(async (ctx) => {
      const s = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", insideA))
        .first();
      return s!._id;
    });
    await alice.mutation(api.tasks.create, {
      listId: insideA,
      title: "Survives",
      statusId,
    });

    await alice.mutation(api.projects.remove, { projectId });

    // Project gone…
    expect(await t.run((ctx) => ctx.db.get(projectId))).toBeNull();

    // …lists intact, reparented to the Space, appended after the list
    // that was already there (no position collision).
    const spaceLists = await alice.query(api.lists.listForParent, {
      parentType: "space",
      parentId: spaceId,
    });
    const byName = new Map(spaceLists.map((l) => [l.name, l]));
    expect([...byName.keys()].sort()).toEqual(["Direct", "Inside A", "Inside B"]);
    expect(byName.get("Direct")!.position).toBe(0);
    expect(
      [byName.get("Inside A")!.position, byName.get("Inside B")!.position].sort(),
    ).toEqual([1, 2]);
    expect(new Set(spaceLists.map((l) => l.position)).size).toBe(3);
    expect(directId).toBeTruthy();
    expect(insideB).toBeTruthy();

    // …and the tasks inside them survive too.
    const tasks = await t.run((ctx) =>
      ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", insideA))
        .collect(),
    );
    expect(tasks.map((x) => x.title)).toEqual(["Survives"]);

    const deleted = await t.run((ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "project.deleted"))
        .collect(),
    );
    expect(deleted).toHaveLength(1);
    expect(
      (deleted[0].payload as { movedListCount: number }).movedListCount,
    ).toBe(2);
  });

  it("refuses a caller who can't reach the project's Space", async () => {
    const { t, spaceId } = await seed();
    const projectId = await t
      .withIdentity(ALICE)
      .mutation(api.projects.create, { spaceId, name: "Q3" });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.projects.remove, { projectId }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("projects.rename", () => {
  it("renames and emits project.renamed; blank names are refused", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const projectId = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Q3",
    });

    await expect(
      alice.mutation(api.projects.rename, { projectId, name: "   " }),
    ).rejects.toThrow(ConvexError);

    await alice.mutation(api.projects.rename, { projectId, name: "Q4  " });
    const projects = await alice.query(api.projects.listForSpace, { spaceId });
    expect(projects.map((f) => f.name)).toEqual(["Q4"]);

    const renamed = await t.run((ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("type"), "project.renamed"))
        .collect(),
    );
    expect(renamed).toHaveLength(1);
  });

  it("hides a private Space's projects from a non-member", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.projects.create, { spaceId, name: "Q3" });
    await alice.mutation(api.spaces.updateMeta, { spaceId, private: true });

    expect(
      await t.withIdentity(OUTSIDER).query(api.projects.listForSpace, { spaceId }),
    ).toEqual([]);
  });
});

describe("ordering", () => {
  it("keeps project and list position sequences independent", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const f1 = await alice.mutation(api.projects.create, {
      spaceId,
      name: "One",
    });
    const f2 = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Two",
    });
    const l1 = await alice.mutation(api.lists.create, {
      name: "A",
      parentType: "space",
      parentId: spaceId,
    });
    const l2 = await alice.mutation(api.lists.create, {
      name: "B",
      parentType: "space",
      parentId: spaceId,
    });

    await alice.mutation(api.projects.reorder, {
      spaceId,
      orderedIds: [f2, f1],
    });
    await alice.mutation(api.lists.reorder, {
      parentType: "space",
      parentId: spaceId,
      orderedIds: [l2, l1],
    });

    const projects = await alice.query(api.projects.listForSpace, { spaceId });
    expect(projects.map((f) => f.name)).toEqual(["Two", "One"]);

    const lists = await alice.query(api.lists.listForParent, {
      parentType: "space",
      parentId: spaceId,
    });
    const sorted = [...lists].sort((a, b) => a.position - b.position);
    expect(sorted.map((l) => l.name)).toEqual(["B", "A"]);

    // Reordering projects left every list position untouched, and vice
    // versa — the two sequences never see each other's ids.
    await alice.mutation(api.projects.reorder, {
      spaceId,
      // A list id smuggled into a project reorder is a type error at the
      // API boundary; a stale/foreign project id is simply skipped.
      orderedIds: [f1],
    });
    const after = await alice.query(api.lists.listForParent, {
      parentType: "space",
      parentId: spaceId,
    });
    expect(
      [...after].sort((a, b) => a.position - b.position).map((l) => l.name),
    ).toEqual(["B", "A"]);
  });

  it("skips project ids from another space rather than corrupting positions", async () => {
    const { t, spaceId, otherSpaceId } = await seed();
    const alice = t.withIdentity(ALICE);

    const mine = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Mine",
    });
    const foreign = await alice.mutation(api.projects.create, {
      spaceId: otherSpaceId,
      name: "Foreign",
    });

    await alice.mutation(api.projects.reorder, {
      spaceId,
      orderedIds: [foreign as Id<"projects">, mine],
    });

    const foreignDoc = await t.run((ctx) => ctx.db.get(foreign));
    expect(foreignDoc?.spaceId).toBe(otherSpaceId);
    expect(foreignDoc?.position).toBe(0); // untouched
    const mineDoc = await t.run((ctx) => ctx.db.get(mine));
    expect(mineDoc?.position).toBe(1);
  });
});
