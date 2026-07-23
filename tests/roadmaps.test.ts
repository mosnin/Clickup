import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Phase K: roadmaps (workspace-level phased containers for projects) and
// lists.reorder (manual project ordering). Covers phase membership math,
// the workspace-match guard on assignment, unassign-on-phase-delete, and
// the access boundaries (non-members see nothing, personal projects can't
// join a roadmap).

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@team.com" };
const OUTSIDER = { subject: "user_outsider", email: "out@side.com" };

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
    });
    await ctx.db.insert("users", {
      clerkId: OUTSIDER.subject,
      email: OUTSIDER.email,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    return workspaceId;
  });
  const owner = t.withIdentity(OWNER);
  const spaceId = await owner.mutation(api.spaces.create, {
    name: "Engineering",
    parentType: "workspace",
    parentId: workspaceId,
  });
  return { owner, workspaceId, spaceId };
}

async function createProjects(
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  spaceId: Id<"spaces">,
  names: string[],
) {
  const ids: Id<"lists">[] = [];
  for (const name of names) {
    ids.push(
      await owner.mutation(api.lists.create, {
        name,
        parentType: "space",
        parentId: spaceId,
      }),
    );
  }
  return ids;
}

describe("roadmaps", () => {
  it("create seeds Now/Next/Later and listForWorkspace returns them in order", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seedWorkspace(t);

    await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "2026 H2",
    });
    const roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(roadmaps).toHaveLength(1);
    expect(roadmaps![0].name).toBe("2026 H2");
    expect(roadmaps![0].phases.map((p: { name: string }) => p.name)).toEqual([
      "Now",
      "Next",
      "Later",
    ]);
    expect(roadmaps![0].projects).toEqual([]);
  });

  it("assignProject defaults to the first phase, appends in order, and null unassigns", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a, b] = await createProjects(owner, spaceId, ["Alpha", "Beta"]);

    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });
    await owner.mutation(api.roadmaps.assignProject, { listId: a, roadmapId });
    await owner.mutation(api.roadmaps.assignProject, { listId: b, roadmapId });

    let roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    const rm = roadmaps![0];
    const nowPhase = rm.phases[0].id;
    expect(
      rm.projects.map((p: { name: string; phaseId?: string }) => [
        p.name,
        p.phaseId,
      ]),
    ).toEqual([
      ["Alpha", nowPhase],
      ["Beta", nowPhase],
    ]);
    expect(
      rm.projects.map((p: { position: number }) => p.position),
    ).toEqual([0, 1]);

    await owner.mutation(api.roadmaps.assignProject, {
      listId: a,
      roadmapId: null,
    });
    roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(
      roadmaps![0].projects.map((p: { name: string }) => p.name),
    ).toEqual(["Beta"]);
  });

  it("refuses a roadmap from a different workspace", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a] = await createProjects(owner, spaceId, ["Alpha"]);

    // Second workspace owned by the same user, with its own roadmap.
    const otherWorkspaceId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: id,
        userClerkId: OWNER.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      return id;
    });
    const foreignRoadmap = await owner.mutation(api.roadmaps.create, {
      workspaceId: otherWorkspaceId,
      name: "Foreign",
    });

    await expect(
      owner.mutation(api.roadmaps.assignProject, {
        listId: a,
        roadmapId: foreignRoadmap,
      }),
    ).rejects.toThrow(/different workspace/i);
    void workspaceId;
  });

  it("personal-space projects can't join a roadmap", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seedWorkspace(t);
    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });

    const personalListId = await t.run(async (ctx) => {
      const personalSpaceId = await ctx.db.insert("spaces", {
        name: "Personal",
        parentType: "user",
        parentId: OWNER.subject,
        position: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("lists", {
        name: "My stuff",
        parentType: "space",
        parentId: personalSpaceId,
        position: 0,
        createdAt: Date.now(),
      });
    });

    await expect(
      owner.mutation(api.roadmaps.assignProject, {
        listId: personalListId,
        roadmapId,
      }),
    ).rejects.toThrow(/workspace projects/i);
  });

  it("reorderPhase applies the new order and skips stale ids", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a, b, c] = await createProjects(owner, spaceId, ["A", "B", "C"]);

    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });
    for (const id of [a, b, c]) {
      await owner.mutation(api.roadmaps.assignProject, { listId: id, roadmapId });
    }
    let roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    const phaseId = roadmaps![0].phases[0].id;

    // C was unassigned by another client after this client captured its
    // order — the stale id must be skipped, not corrupt positions.
    await owner.mutation(api.roadmaps.assignProject, {
      listId: c,
      roadmapId: null,
    });
    await owner.mutation(api.roadmaps.reorderPhase, {
      roadmapId,
      phaseId,
      orderedIds: [c, b, a],
    });

    roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(
      roadmaps![0].projects.map((p: { name: string }) => p.name),
    ).toEqual(["B", "A"]);
  });

  it("removePhase drops that phase's projects back to unassigned; other phases survive", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a, b] = await createProjects(owner, spaceId, ["A", "B"]);

    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });
    let roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    const [now, next] = roadmaps![0].phases;
    await owner.mutation(api.roadmaps.assignProject, {
      listId: a,
      roadmapId,
      phaseId: now.id,
    });
    await owner.mutation(api.roadmaps.assignProject, {
      listId: b,
      roadmapId,
      phaseId: next.id,
    });

    await owner.mutation(api.roadmaps.removePhase, {
      roadmapId,
      phaseId: now.id,
    });
    roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(roadmaps![0].phases.map((p: { name: string }) => p.name)).toEqual([
      "Next",
      "Later",
    ]);
    expect(
      roadmaps![0].projects.map((p: { name: string }) => p.name),
    ).toEqual(["B"]);
  });

  it("remove unassigns every project and deletes the roadmap", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a] = await createProjects(owner, spaceId, ["A"]);
    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });
    await owner.mutation(api.roadmaps.assignProject, { listId: a, roadmapId });

    await owner.mutation(api.roadmaps.remove, { roadmapId });
    const roadmaps = await owner.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(roadmaps).toEqual([]);
    const list = await owner.query(api.lists.get, { listId: a });
    expect(list?.roadmapId).toBeUndefined();
    expect(list?.roadmapPhaseId).toBeUndefined();
  });

  it("private spaces: a locked-out member neither sees nor reorders their projects", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [pub] = await createProjects(owner, spaceId, ["Public"]);

    // A second workspace member with no access to the private space.
    const MEMBER = { subject: "user_member", email: "member@team.com" };
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: MEMBER.subject,
        email: MEMBER.email,
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: MEMBER.subject,
        role: "member",
        joinedAt: Date.now(),
      });
    });
    const privateSpaceId = await owner.mutation(api.spaces.create, {
      name: "Secret",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await owner.mutation(api.spaces.updateMeta, {
      spaceId: privateSpaceId,
      private: true,
    });
    const [secret] = await createProjects(owner, privateSpaceId, [
      "Secret launch",
    ]);

    const roadmapId = await owner.mutation(api.roadmaps.create, {
      workspaceId,
      name: "Roadmap",
    });
    await owner.mutation(api.roadmaps.assignProject, {
      listId: secret,
      roadmapId,
    });
    await owner.mutation(api.roadmaps.assignProject, {
      listId: pub,
      roadmapId,
    });

    const member = t.withIdentity(MEMBER);
    // Read: the private project's name never reaches the locked-out member.
    const roadmaps = await member.query(api.roadmaps.listForWorkspace, {
      workspaceId,
    });
    expect(
      roadmaps![0].projects.map((p: { name: string }) => p.name),
    ).toEqual(["Public"]);

    // Write: a reorder from the locked-out member (who can only see the
    // public subset) must not move the private list.
    const phaseId = roadmaps![0].phases[0].id;
    await member.mutation(api.roadmaps.reorderPhase, {
      roadmapId,
      phaseId,
      orderedIds: [pub, secret],
    });
    const secretRow = await t.run(async (ctx) => ctx.db.get(secret));
    expect(secretRow!.roadmapPosition).toBe(0); // untouched
  });

  it("non-members read null and can't mutate", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seedWorkspace(t);
    await owner.mutation(api.roadmaps.create, { workspaceId, name: "Roadmap" });

    const outsider = t.withIdentity(OUTSIDER);
    expect(
      await outsider.query(api.roadmaps.listForWorkspace, { workspaceId }),
    ).toBeNull();
    await expect(
      outsider.mutation(api.roadmaps.create, {
        workspaceId,
        name: "Sneaky",
      }),
    ).rejects.toThrow(/not a member/i);
  });
});

describe("lists.reorder", () => {
  it("renumbers lists under a space and skips ids from other parents", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, spaceId } = await seedWorkspace(t);
    const [a, b, c] = await createProjects(owner, spaceId, ["A", "B", "C"]);

    // A list under a DIFFERENT space, snuck into the ordered ids.
    const otherSpaceId = await owner.mutation(api.spaces.create, {
      name: "Design",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const [foreign] = await createProjects(owner, otherSpaceId, ["Foreign"]);

    await owner.mutation(api.lists.reorder, {
      parentType: "space",
      parentId: spaceId,
      orderedIds: [c, foreign, a, b],
    });

    const positions = await t.run(async (ctx) => {
      const rows: Record<string, number> = {};
      for (const id of [a, b, c, foreign]) {
        const list = await ctx.db.get(id);
        rows[list!.name] = list!.position;
      }
      return rows;
    });
    // C takes slot 0; the foreign id is skipped but still consumes its
    // index (documented server behavior: stale entries never corrupt the
    // relative order of the valid ones).
    expect(positions.C).toBe(0);
    expect(positions.A).toBe(2);
    expect(positions.B).toBe(3);
    expect(positions.Foreign).toBe(0); // untouched
  });

  it("non-members can't reorder", async () => {
    const t = convexTest(schema, modules);
    const { owner, spaceId } = await seedWorkspace(t);
    const [a] = await createProjects(owner, spaceId, ["A"]);

    const outsider = t.withIdentity(OUTSIDER);
    await expect(
      outsider.mutation(api.lists.reorder, {
        parentType: "space",
        parentId: spaceId,
        orderedIds: [a],
      }),
    ).rejects.toThrow();
  });
});
