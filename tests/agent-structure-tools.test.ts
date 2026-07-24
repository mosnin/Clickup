import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import type { Id } from "../convex/_generated/dataModel";

// The structure + template half of the agent surface: moving lists between
// grouping parents, the folder lifecycle, and both template catalogs. Every
// one of these routes through the same *Core the human UI calls, so these
// tests are as much about "did it emit the event / move the children" as
// about "did it refuse the wrong caller".

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const WORKSPACE_KEY = "cua_test_key_workspace_agent";
const PERSONAL_KEY = "cua_test_key_personal_agent";
const RESTRICTED_KEY = "cua_test_key_restricted_agent";

async function setup() {
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
    // A second space in the SAME workspace: the agent can reach it, so a
    // cross-space move is refused by the move itself, not by scope.
    const otherSpaceId = await ctx.db.insert("spaces", {
      name: "Skunkworks",
      parentType: "workspace",
      parentId: workspaceId,
      position: 1,
      createdAt: Date.now(),
    });
    const personalSpaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });

    const folderId = await ctx.db.insert("folders", {
      name: "Q3",
      spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const otherFolderId = await ctx.db.insert("folders", {
      name: "Elsewhere",
      spaceId: otherSpaceId,
      position: 0,
      createdAt: Date.now(),
    });

    const listId = await ctx.db.insert("lists", {
      name: "Foundation",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });

    async function agentWithKey(
      name: string,
      parentType: "user" | "workspace",
      parentId: string,
      apiKey: string,
      allowedListIds?: Id<"lists">[],
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        parentType,
        parentId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        ...(allowedListIds ? { allowedListIds } : {}),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 12),
        createdAt: Date.now(),
      });
      return agentId;
    }

    const agentId = await agentWithKey(
      "Planner",
      "workspace",
      workspaceId,
      WORKSPACE_KEY,
    );
    await agentWithKey(
      "Solo",
      "user",
      ALICE.subject,
      PERSONAL_KEY,
    );
    await agentWithKey(
      "Narrow",
      "workspace",
      workspaceId,
      RESTRICTED_KEY,
      [listId],
    );

    return {
      workspaceId,
      spaceId,
      otherSpaceId,
      personalSpaceId,
      folderId,
      otherFolderId,
      listId,
      agentId,
    };
  });
  return { t, ...ids };
}

function errText(e: unknown): string {
  return e instanceof ConvexError ? String(e.data) : String(e);
}

describe("move_list", () => {
  it("moves a list into a folder and back out, emitting list.moved", async () => {
    const { t, listId, folderId, spaceId } = await setup();

    await t.mutation(api.agentApi.moveList, {
      apiKey: WORKSPACE_KEY,
      listId,
      parentType: "folder",
      parentId: folderId,
    });

    let list = await t.run(async (ctx) => await ctx.db.get(listId));
    expect(list?.parentType).toBe("folder");
    expect(list?.parentId).toBe(folderId);

    await t.mutation(api.agentApi.moveList, {
      apiKey: WORKSPACE_KEY,
      listId,
      parentType: "space",
      parentId: spaceId,
    });

    list = await t.run(async (ctx) => await ctx.db.get(listId));
    expect(list?.parentType).toBe("space");
    expect(list?.parentId).toBe(spaceId);

    // The shared core is what emits, so the agent path lands in the feed.
    const moved = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter(
        (e) => e.type === "list.moved",
      ),
    );
    expect(moved).toHaveLength(2);
    expect(moved[0].actorType).toBe("agent");
  });

  it("refuses a destination folder in another space", async () => {
    const { t, listId, otherFolderId } = await setup();
    await expect(
      t.mutation(api.agentApi.moveList, {
        apiKey: WORKSPACE_KEY,
        listId,
        parentType: "folder",
        parentId: otherFolderId,
      }),
    ).rejects.toThrow(/Pick a folder in this Space/);

    const list = await t.run(async (ctx) => await ctx.db.get(listId));
    expect(list?.parentType).toBe("space");
  });

  it("refuses a list-restricted agent (structure-level op)", async () => {
    const { t, listId, folderId } = await setup();
    await expect(
      t.mutation(api.agentApi.moveList, {
        apiKey: RESTRICTED_KEY,
        listId,
        parentType: "folder",
        parentId: folderId,
      }),
    ).rejects.toThrow(/restricted to specific lists/);
  });

  it("refuses a list outside the agent's scope", async () => {
    const { t, folderId } = await setup();
    const foreignListId = await t.run(async (ctx) => {
      const spaceId = await ctx.db.insert("spaces", {
        name: "Other org",
        parentType: "workspace",
        parentId: "ws_someone_else",
        position: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("lists", {
        name: "Not yours",
        parentType: "space",
        parentId: spaceId,
        position: 0,
        createdAt: Date.now(),
      });
    });

    await expect(
      t.mutation(api.agentApi.moveList, {
        apiKey: WORKSPACE_KEY,
        listId: foreignListId,
        parentType: "folder",
        parentId: folderId,
      }),
    ).rejects.toThrow(/outside your scope|allow-list/);
  });
});

describe("folder lifecycle over the agent path", () => {
  it("creates through the core, so folder.created is emitted", async () => {
    const { t, spaceId } = await setup();
    const folderId = await t.mutation(api.agentApi.createFolder, {
      apiKey: WORKSPACE_KEY,
      spaceId,
      name: "  Discovery  ",
    });
    const folder = await t.run(async (ctx) => await ctx.db.get(folderId));
    expect(folder?.name).toBe("Discovery");

    const created = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter(
        (e) => e.type === "folder.created",
      ),
    );
    expect(created).toHaveLength(1);
    expect(created[0].actorType).toBe("agent");
    expect(created[0].entityTitle).toBe("Discovery");
  });

  it("renames a folder", async () => {
    const { t, folderId } = await setup();
    await t.mutation(api.agentApi.renameFolder, {
      apiKey: WORKSPACE_KEY,
      folderId,
      name: "Q4",
    });
    const folder = await t.run(async (ctx) => await ctx.db.get(folderId));
    expect(folder?.name).toBe("Q4");

    const renamed = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter(
        (e) => e.type === "folder.renamed",
      ),
    );
    expect(renamed).toHaveLength(1);
  });

  it("deleting a folder ungroups its lists instead of destroying them", async () => {
    const { t, folderId, listId, spaceId } = await setup();
    await t.mutation(api.agentApi.moveList, {
      apiKey: WORKSPACE_KEY,
      listId,
      parentType: "folder",
      parentId: folderId,
    });

    await t.mutation(api.agentApi.deleteFolder, {
      apiKey: WORKSPACE_KEY,
      folderId,
    });

    const { folder, list } = await t.run(async (ctx) => ({
      folder: await ctx.db.get(folderId),
      list: await ctx.db.get(listId),
    }));
    expect(folder).toBeNull();
    // The list survived and moved up to the parent space.
    expect(list?.parentType).toBe("space");
    expect(list?.parentId).toBe(spaceId);
  });

  it("reorders folders inside one space", async () => {
    const { t, spaceId, folderId } = await setup();
    const second = await t.mutation(api.agentApi.createFolder, {
      apiKey: WORKSPACE_KEY,
      spaceId,
      name: "Later",
    });

    await t.mutation(api.agentApi.reorderFolders, {
      apiKey: WORKSPACE_KEY,
      spaceId,
      orderedIds: [second, folderId],
    });

    const positions = await t.run(async (ctx) => ({
      second: (await ctx.db.get(second))?.position,
      first: (await ctx.db.get(folderId))?.position,
    }));
    expect(positions.second).toBe(0);
    expect(positions.first).toBe(1);
  });

  it("refuses folder writes from a list-restricted agent", async () => {
    const { t, folderId } = await setup();
    await expect(
      t.mutation(api.agentApi.renameFolder, {
        apiKey: RESTRICTED_KEY,
        folderId,
        name: "Nope",
      }),
    ).rejects.toThrow(/restricted to specific lists/);
    await expect(
      t.mutation(api.agentApi.deleteFolder, {
        apiKey: RESTRICTED_KEY,
        folderId,
      }),
    ).rejects.toThrow(/restricted to specific lists/);
  });

  it("refuses a folder outside the agent's scope", async () => {
    const { t } = await setup();
    const foreignFolderId = await t.run(async (ctx) => {
      const spaceId = await ctx.db.insert("spaces", {
        name: "Other org",
        parentType: "workspace",
        parentId: "ws_someone_else",
        position: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("folders", {
        name: "Theirs",
        spaceId,
        position: 0,
        createdAt: Date.now(),
      });
    });

    await expect(
      t.mutation(api.agentApi.renameFolder, {
        apiKey: WORKSPACE_KEY,
        folderId: foreignFolderId,
        name: "Mine now",
      }),
    ).rejects.toThrow(/outside your agent's scope/);
  });
});

describe("sprint templates over the agent path", () => {
  it("lists the catalog with its facets", async () => {
    const { t } = await setup();
    const catalog = await t.query(api.agentApi.listSprintTemplates, {
      apiKey: WORKSPACE_KEY,
    });
    expect(catalog.templates.length).toBeGreaterThan(0);
    expect(catalog.templates.map((x) => x.slug)).toContain(
      "two-week-product-sprint",
    );
    expect(catalog.complexities).toContain("beginner");
  });

  it("creates the sprint with its ceremonies and starter tasks", async () => {
    const { t, listId } = await setup();
    const startDate = Date.UTC(2026, 0, 5);

    const result = await t.mutation(api.agentApi.applySprintTemplate, {
      apiKey: WORKSPACE_KEY,
      slug: "two-week-product-sprint",
      startDate,
      listId,
      name: "Sprint 1",
    });

    expect(result.taskIds.length).toBeGreaterThan(0);

    const { sprint, tasks } = await t.run(async (ctx) => ({
      sprint: await ctx.db.get(result.sprintId),
      tasks: await ctx.db
        .query("tasks")
        .withIndex("by_sprint", (q) => q.eq("sprintId", result.sprintId))
        .collect(),
    }));

    expect(sprint?.name).toBe("Sprint 1");
    expect(sprint?.startDate).toBe(startDate);
    // End date is derived from the template's length, not passed in.
    expect(sprint!.endDate).toBeGreaterThan(startDate);
    expect(tasks).toHaveLength(result.taskIds.length);
    // Every seeded task landed in the destination list, inside the window.
    for (const task of tasks) {
      expect(task.listId).toBe(listId);
      expect(task.dueDate!).toBeLessThanOrEqual(sprint!.endDate);
    }
    // Seeded through createTaskCore, so the usual events fired.
    const createdEvents = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter(
        (e) => e.type === "task.created",
      ),
    );
    expect(createdEvents.length).toBe(tasks.length);
  });

  it("creates the timebox alone when no list is given", async () => {
    const { t } = await setup();
    const result = await t.mutation(api.agentApi.applySprintTemplate, {
      apiKey: WORKSPACE_KEY,
      slug: "two-week-product-sprint",
      startDate: Date.UTC(2026, 0, 5),
    });
    expect(result.taskIds).toEqual([]);
  });

  it("names an unknown slug in the refusal", async () => {
    const { t } = await setup();
    try {
      await t.mutation(api.agentApi.applySprintTemplate, {
        apiKey: WORKSPACE_KEY,
        slug: "not-a-real-sprint",
        startDate: Date.now(),
      });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(errText(e)).toMatch(/Unknown sprint template/);
    }
  });

  it("refuses personal-scope agents on both ends", async () => {
    const { t } = await setup();
    await expect(
      t.query(api.agentApi.listSprintTemplates, { apiKey: PERSONAL_KEY }),
    ).rejects.toThrow(/workspace-scoped agent/);
    await expect(
      t.mutation(api.agentApi.applySprintTemplate, {
        apiKey: PERSONAL_KEY,
        slug: "two-week-product-sprint",
        startDate: Date.now(),
      }),
    ).rejects.toThrow(/workspace-scoped agent/);
  });

  it("refuses a destination list outside the agent's allow-list", async () => {
    const { t, listId } = await setup();
    const otherListId = await t.run(async (ctx) => {
      const spaces = await ctx.db.query("spaces").collect();
      const hq = spaces.find((s) => s.name === "HQ")!;
      return await ctx.db.insert("lists", {
        name: "Off limits",
        parentType: "space",
        parentId: hq._id,
        position: 1,
        createdAt: Date.now(),
      });
    });
    expect(otherListId).not.toBe(listId);

    // The restricted agent is refused before the allow-list even matters:
    // creating a sprint is structure-level.
    await expect(
      t.mutation(api.agentApi.applySprintTemplate, {
        apiKey: RESTRICTED_KEY,
        slug: "two-week-product-sprint",
        startDate: Date.now(),
        listId: otherListId,
      }),
    ).rejects.toThrow(/restricted to specific lists/);
  });
});

describe("Template Center over the agent path", () => {
  it("filters the catalog and returns the facet vocabulary", async () => {
    const { t } = await setup();
    const all = await t.query(api.agentApi.listCatalogTemplates, {
      apiKey: WORKSPACE_KEY,
    });
    expect(all.matched).toBe(all.total);
    expect(all.facets.entityTypes).toContain("list");

    const docsOnly = await t.query(api.agentApi.listCatalogTemplates, {
      apiKey: WORKSPACE_KEY,
      entityType: "doc",
    });
    expect(docsOnly.matched).toBeGreaterThan(0);
    expect(docsOnly.matched).toBeLessThan(all.total);
    expect(docsOnly.templates.every((x) => x.entityType === "doc")).toBe(true);

    const searched = await t.query(api.agentApi.listCatalogTemplates, {
      apiKey: WORKSPACE_KEY,
      search: "launch",
    });
    expect(searched.templates.map((x) => x.slug)).toContain(
      "product-launch-runway",
    );
  });

  it("returns a template's full payload and its destination types", async () => {
    const { t } = await setup();
    const detail = await t.query(api.agentApi.getCatalogTemplate, {
      apiKey: WORKSPACE_KEY,
      slug: "product-launch-runway",
    });
    expect(detail.template.entityType).toBe("list");
    expect(detail.destinationTypes).toEqual(["space", "folder"]);
    expect(detail.summary.stats.length).toBeGreaterThan(0);

    await expect(
      t.query(api.agentApi.getCatalogTemplate, {
        apiKey: WORKSPACE_KEY,
        slug: "nope",
      }),
    ).rejects.toThrow(/Unknown template/);
  });

  it("applies a list template into a space, with statuses/fields/tasks", async () => {
    const { t, spaceId } = await setup();
    const result = await t.mutation(api.agentApi.applyCatalogTemplate, {
      apiKey: WORKSPACE_KEY,
      slug: "product-launch-runway",
      destinationType: "space",
      destinationId: spaceId,
      name: "Nimbus launch",
    });

    expect(result.entityType).toBe("list");
    expect(result.name).toBe("Nimbus launch");

    const listId = result.id as Id<"lists">;
    const { list, statuses, fields, tasks } = await t.run(async (ctx) => ({
      list: await ctx.db.get(listId),
      statuses: await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
      fields: await ctx.db
        .query("customFields")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
      tasks: await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
    }));

    expect(list?.name).toBe("Nimbus launch");
    expect(list?.parentType).toBe("space");
    expect(statuses.length).toBeGreaterThan(0);
    expect(fields.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it("applies a doc template into a space", async () => {
    const { t, spaceId } = await setup();
    const result = await t.mutation(api.agentApi.applyCatalogTemplate, {
      apiKey: WORKSPACE_KEY,
      slug: "prd-doc",
      destinationType: "space",
      destinationId: spaceId,
    });

    expect(result.entityType).toBe("doc");
    const doc = await t.run(
      async (ctx) => await ctx.db.get(result.id as Id<"docs">),
    );
    expect(doc?.parentType).toBe("space");
    expect(doc?.parentId).toBe(spaceId);
    expect(doc?.content).toBeTruthy();
  });

  it("refuses a destination shape the entity type can't use", async () => {
    const { t, listId } = await setup();
    try {
      await t.mutation(api.agentApi.applyCatalogTemplate, {
        apiKey: WORKSPACE_KEY,
        slug: "product-launch-runway",
        destinationType: "list",
        destinationId: listId,
      });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(errText(e)).toMatch(/can't be applied to a list/);
    }
  });

  it("refuses a destination outside the agent's scope", async () => {
    const { t, personalSpaceId } = await setup();
    // A workspace agent can't reach the owner's personal space.
    await expect(
      t.mutation(api.agentApi.applyCatalogTemplate, {
        apiKey: WORKSPACE_KEY,
        slug: "prd-doc",
        destinationType: "space",
        destinationId: personalSpaceId,
      }),
    ).rejects.toThrow(/outside your agent's scope/);
  });

  it("refuses list-restricted agents (it creates structure)", async () => {
    const { t, spaceId } = await setup();
    await expect(
      t.mutation(api.agentApi.applyCatalogTemplate, {
        apiKey: RESTRICTED_KEY,
        slug: "product-launch-runway",
        destinationType: "space",
        destinationId: spaceId,
      }),
    ).rejects.toThrow(/restricted to specific lists/);
  });

  it("lets a personal-scope agent apply a template in its own space", async () => {
    const { t, personalSpaceId } = await setup();
    const result = await t.mutation(api.agentApi.applyCatalogTemplate, {
      apiKey: PERSONAL_KEY,
      slug: "product-launch-runway",
      destinationType: "space",
      destinationId: personalSpaceId,
    });
    expect(result.entityType).toBe("list");
  });
});
