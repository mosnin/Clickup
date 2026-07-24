import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Milestones: named, dated checkpoints inside ONE project (a `lists` row).
// Covers CRUD, the access boundary (a foreign scope sees and touches
// nothing), progress derived from linked tasks' status categories, the
// unlink-not-delete rule when a milestone goes away, the list-delete
// cascade, and the key-authenticated agent path.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice", email: "alice@example.com" };
const MALLORY = { subject: "user_mallory", email: "mallory@example.com" };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const u of [ALICE, MALLORY]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: u.email,
        name: u.subject,
      });
    }

    async function workspaceFor(owner: string, name: string) {
      const workspaceId = await ctx.db.insert("workspaces", {
        name,
        slug: name.toLowerCase(),
        ownerClerkId: owner,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        userClerkId: owner,
        workspaceId,
        role: "owner",
        // memberships carry joinedAt, not createdAt.
        joinedAt: Date.now(),
      });
      const spaceId = await ctx.db.insert("spaces", {
        name: `${name} HQ`,
        parentType: "workspace",
        parentId: workspaceId,
        position: 0,
        createdAt: Date.now(),
      });
      return { workspaceId, spaceId };
    }

    const acme = await workspaceFor(ALICE.subject, "Acme");
    const rival = await workspaceFor(MALLORY.subject, "Rival");

    const listId = await ctx.db.insert("lists", {
      name: "Nimbus",
      parentType: "space",
      parentId: acme.spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const otherListId = await ctx.db.insert("lists", {
      name: "Sidecar",
      parentType: "space",
      parentId: acme.spaceId,
      position: 1,
      createdAt: Date.now(),
    });
    const openStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const doneStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId: otherListId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });

    async function agentFor(
      workspaceId: Id<"workspaces">,
      creator: string,
      name: string,
      apiKey: string,
      allowedListIds?: Id<"lists">[],
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: creator,
        createdAt: Date.now(),
        allowedListIds,
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 12),
        createdAt: Date.now(),
      });
      return agentId;
    }

    const agentId = await agentFor(
      acme.workspaceId,
      ALICE.subject,
      "Planner",
      "cua_test_planner",
    );
    await agentFor(
      rival.workspaceId,
      MALLORY.subject,
      "Intruder",
      "cua_test_intruder",
    );
    await agentFor(
      acme.workspaceId,
      ALICE.subject,
      "Narrow",
      "cua_test_narrow",
      [otherListId],
    );

    return {
      workspaceId: acme.workspaceId,
      spaceId: acme.spaceId,
      listId,
      otherListId,
      openStatus,
      doneStatus,
      agentId,
    };
  });
  return {
    t,
    alice: t.withIdentity(ALICE),
    mallory: t.withIdentity(MALLORY),
    apiKey: "cua_test_planner",
    foreignKey: "cua_test_intruder",
    restrictedKey: "cua_test_narrow",
    ...ids,
  };
}

function errText(e: unknown): string {
  return e instanceof ConvexError ? String(e.data) : String(e);
}

describe("milestones CRUD", () => {
  it("creates, reads back with zeroed progress, updates, and deletes", async () => {
    const { alice, listId } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "  Beta cut  ",
      description: "Feature freeze",
      targetDate: 1_800_000_000_000,
    });

    let rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Beta cut"); // trimmed
    expect(rows[0].description).toBe("Feature freeze");
    expect(rows[0].targetDate).toBe(1_800_000_000_000);
    expect(rows[0].status).toBe("open");
    expect(rows[0]).toMatchObject({ total: 0, done: 0 });

    await alice.mutation(api.milestones.update, {
      milestoneId,
      name: "Beta",
      targetDate: null,
      status: "complete",
    });
    rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows[0].name).toBe("Beta");
    expect(rows[0].targetDate).toBeUndefined();
    expect(rows[0].status).toBe("complete");
    expect(rows[0].completedAt).toBeTypeOf("number");

    await expect(
      alice.mutation(api.milestones.update, { milestoneId, name: "   " }),
    ).rejects.toThrow(/name is required/i);

    await alice.mutation(api.milestones.remove, { milestoneId });
    rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows).toHaveLength(0);
  });

  it("orders by position and reorders", async () => {
    const { alice, listId } = await setup();
    const first = await alice.mutation(api.milestones.create, {
      listId,
      name: "M1",
    });
    const second = await alice.mutation(api.milestones.create, {
      listId,
      name: "M2",
    });
    let rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows.map((m) => m.name)).toEqual(["M1", "M2"]);

    await alice.mutation(api.milestones.reorder, {
      listId,
      orderedIds: [second, first],
    });
    rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows.map((m) => m.name)).toEqual(["M2", "M1"]);
  });

  it("emits milestone.* events carrying the project for deep links", async () => {
    const { t, alice, listId, workspaceId } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "Beta cut",
    });
    await alice.mutation(api.milestones.update, {
      milestoneId,
      status: "complete",
    });
    await alice.mutation(api.milestones.remove, { milestoneId });

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "workspace").eq("scopeId", workspaceId),
        )
        .collect(),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("milestone.created");
    expect(types).toContain("milestone.completed");
    expect(types).toContain("milestone.deleted");
    for (const e of events.filter((x) => x.type.startsWith("milestone."))) {
      expect(e.entityType).toBe("milestone");
      expect(e.listId).toBe(listId);
    }
  });
});

describe("milestone access boundary", () => {
  it("refuses reads and writes from a foreign scope", async () => {
    const { alice, mallory, listId } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "Beta cut",
    });

    // Reads degrade to empty rather than leaking checkpoint names by id.
    expect(await mallory.query(api.milestones.listForList, { listId })).toEqual(
      [],
    );
    await expect(
      mallory.mutation(api.milestones.create, { listId, name: "Sneak" }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      mallory.mutation(api.milestones.update, { milestoneId, name: "Sneak" }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      mallory.mutation(api.milestones.remove, { milestoneId }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("refuses an agent from another workspace, and a list-restricted agent", async () => {
    const { alice, listId, foreignKey, restrictedKey } = await setup();
    await alice.mutation(api.milestones.create, { listId, name: "Beta cut" });

    await expect(
      (async () =>
        await alice.query(api.agentApi.listMilestones, {
          apiKey: foreignKey,
          listId,
        }))(),
    ).rejects.toThrow(/outside your scope|allow-list/i);

    // Restricted to a different list: milestone authoring is structure-level.
    await expect(
      (async () =>
        await alice.mutation(api.agentApi.createMilestone, {
          apiKey: restrictedKey,
          listId,
          name: "Sneak",
        }))(),
    ).rejects.toThrow(/restricted to specific lists/i);
  });
});

describe("derived progress", () => {
  it("counts linked tasks and their completion, ignoring unlinked ones", async () => {
    const { alice, listId, openStatus, doneStatus } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "Beta cut",
    });

    const linkedA = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship API",
      statusId: openStatus,
    });
    const linkedB = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship UI",
      statusId: openStatus,
    });
    await alice.mutation(api.tasks.create, {
      listId,
      title: "Unrelated",
      statusId: openStatus,
    });

    for (const taskId of [linkedA, linkedB]) {
      await alice.mutation(api.tasks.update, { taskId, milestoneId });
    }

    let rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows[0]).toMatchObject({ total: 2, done: 0 });

    // Moving a linked task into a complete-category status moves the bar.
    await alice.mutation(api.tasks.update, {
      taskId: linkedA,
      statusId: doneStatus,
    });
    rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows[0]).toMatchObject({ total: 2, done: 1 });

    // Detaching drops it back out of the count entirely.
    await alice.mutation(api.tasks.update, {
      taskId: linkedA,
      milestoneId: null,
    });
    rows = await alice.query(api.milestones.listForList, { listId });
    expect(rows[0]).toMatchObject({ total: 1, done: 0 });
  });

  it("refuses linking a task to a milestone of another project", async () => {
    const { alice, listId, otherListId, openStatus } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "Beta cut",
    });
    const foreignTaskId = await alice.mutation(api.tasks.create, {
      listId: otherListId,
      title: "Elsewhere",
    });
    await expect(
      alice.mutation(api.tasks.update, {
        taskId: foreignTaskId,
        milestoneId,
      }),
    ).rejects.toThrow(/different project/i);
    expect(openStatus).toBeTruthy();
  });
});

describe("deletes", () => {
  it("unlinks tasks instead of deleting them", async () => {
    const { t, alice, listId, openStatus } = await setup();
    const milestoneId = await alice.mutation(api.milestones.create, {
      listId,
      name: "Beta cut",
    });
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Ship API",
      statusId: openStatus,
    });
    await alice.mutation(api.tasks.update, { taskId, milestoneId });

    await alice.mutation(api.milestones.remove, { milestoneId });

    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task).not.toBeNull();
    expect(task!.milestoneId).toBeUndefined();
  });

  it("cascades when the project itself is deleted", async () => {
    const { t, alice, listId } = await setup();
    await alice.mutation(api.milestones.create, { listId, name: "Beta cut" });
    await alice.mutation(api.milestones.create, { listId, name: "GA" });

    await alice.mutation(api.lists.remove, { listId });

    const left = await t.run(async (ctx) =>
      ctx.db.query("milestones").collect(),
    );
    expect(left).toHaveLength(0);
  });
});

describe("agent API", () => {
  it("runs the whole loop and round-trips milestoneId on task reads", async () => {
    const { alice, apiKey, listId, openStatus, doneStatus } = await setup();

    const { milestoneId } = await alice.mutation(api.agentApi.createMilestone, {
      apiKey,
      listId,
      name: "Beta cut",
      targetDate: 1_800_000_000_000,
    });

    let rows = await alice.query(api.agentApi.listMilestones, {
      apiKey,
      listId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      milestoneId,
      name: "Beta cut",
      targetDate: 1_800_000_000_000,
      status: "open",
      total: 0,
      done: 0,
    });

    const taskId = await alice.mutation(api.agentApi.createTask, {
      apiKey,
      listId,
      title: "Ship API",
      statusId: openStatus,
    });
    await alice.mutation(api.agentApi.setTaskMilestone, {
      apiKey,
      taskId,
      milestoneId,
    });

    // The link must survive a read, or agents can't see their own plan.
    let task = await alice.query(api.agentApi.getTask, { apiKey, taskId });
    expect(task.milestoneId).toBe(milestoneId);

    await alice.mutation(api.agentApi.updateTask, {
      apiKey,
      taskId,
      statusId: doneStatus,
    });
    rows = await alice.query(api.agentApi.listMilestones, { apiKey, listId });
    expect(rows[0]).toMatchObject({ total: 1, done: 1 });

    await alice.mutation(api.agentApi.updateMilestone, {
      apiKey,
      milestoneId,
      name: "Beta",
      status: "complete",
    });
    rows = await alice.query(api.agentApi.listMilestones, { apiKey, listId });
    expect(rows[0].name).toBe("Beta");
    expect(rows[0].status).toBe("complete");

    // Detach, then delete: the task lives on, unlinked.
    await alice.mutation(api.agentApi.setTaskMilestone, {
      apiKey,
      taskId,
      milestoneId: null,
    });
    task = await alice.query(api.agentApi.getTask, { apiKey, taskId });
    expect(task.milestoneId).toBeNull();

    await alice.mutation(api.agentApi.deleteMilestone, { apiKey, milestoneId });
    rows = await alice.query(api.agentApi.listMilestones, { apiKey, listId });
    expect(rows).toHaveLength(0);
    task = await alice.query(api.agentApi.getTask, { apiKey, taskId });
    expect(task.title).toBe("Ship API");
  });

  it("refuses an unknown milestone with a pointer to list_milestones", async () => {
    const { alice, apiKey, listId } = await setup();
    const { milestoneId } = await alice.mutation(api.agentApi.createMilestone, {
      apiKey,
      listId,
      name: "Beta cut",
    });
    await alice.mutation(api.agentApi.deleteMilestone, { apiKey, milestoneId });
    const err = await alice
      .mutation(api.agentApi.updateMilestone, {
        apiKey,
        milestoneId,
        name: "Ghost",
      })
      .catch((e) => e);
    expect(errText(err)).toMatch(/list_milestones/);
  });
});
