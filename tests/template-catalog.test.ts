import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { createTLSchema } from "@tldraw/tlschema";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  TEMPLATE_CATALOG,
  TEMPLATE_CATEGORIES,
  boardSnapshot,
  docContent,
  summarizeTemplate,
  templateCenterCatalog,
} from "../convex/templateCatalog";

// The Template Center catalog is code, not data, so its integrity is a unit
// test rather than a migration: unique slugs, valid facets, and a payload on
// every entry. The second half applies one template of each entity type
// end to end, proving each core writes through the real write paths.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

const ENTITY_TYPES = ["list", "task", "doc", "whiteboard", "view"];
const COMPLEXITIES = ["beginner", "intermediate", "advanced"];

async function seedUsers(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
}

async function personalSpace(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"spaces">> {
  return await t.withIdentity(OWNER).mutation(api.spaces.create, {
    name: "Personal",
    parentType: "user",
    parentId: OWNER.subject,
  });
}

function firstSlugOf(entityType: string): string {
  const found = TEMPLATE_CATALOG.find((t) => t.entityType === entityType);
  if (!found) throw new Error(`no ${entityType} template in the catalog`);
  return found.slug;
}

describe("template catalog integrity", () => {
  it("ships a substantial catalog covering every entity type", () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThanOrEqual(30);
    for (const entityType of ENTITY_TYPES) {
      expect(
        TEMPLATE_CATALOG.filter((t) => t.entityType === entityType).length,
        `${entityType} templates`,
      ).toBeGreaterThan(0);
    }
  });

  it("has unique, url-safe slugs", () => {
    const slugs = TEMPLATE_CATALOG.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("uses only known entity types, categories, and complexities", () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(ENTITY_TYPES, t.slug).toContain(t.entityType);
      expect(COMPLEXITIES, t.slug).toContain(t.complexity);
      expect(TEMPLATE_CATEGORIES as readonly string[], t.slug).toContain(
        t.category,
      );
      expect(t.useCases.length, t.slug).toBeGreaterThan(0);
      expect(t.name.length, t.slug).toBeGreaterThan(0);
      expect(t.description.length, t.slug).toBeGreaterThan(20);
    }
  });

  it("gives every entry a materialisable payload", () => {
    for (const t of TEMPLATE_CATALOG) {
      if (t.entityType === "list") {
        // Statuses are optional (the list falls back to the default four),
        // but a list template with no content at all is a bug.
        const size =
          (t.list.statuses?.length ?? 0) +
          (t.list.fields?.length ?? 0) +
          (t.list.tasks?.length ?? 0);
        expect(size, t.slug).toBeGreaterThan(0);
        for (const status of t.list.statuses ?? []) {
          expect(status.color, t.slug).toMatch(/^#[0-9a-f]{6}$/i);
        }
        for (const field of t.list.fields ?? []) {
          if (field.type === "dropdown") {
            expect(field.options.length, `${t.slug} ${field.name}`).toBeGreaterThan(0);
          }
        }
        // Every seed task must point at a status the template really has.
        const statusCount = t.list.statuses?.length ?? 4;
        for (const task of t.list.tasks ?? []) {
          expect(task.statusIndex ?? 0, `${t.slug} ${task.title}`).toBeLessThan(
            statusCount,
          );
        }
      } else if (t.entityType === "task") {
        expect(t.task.title.length, t.slug).toBeGreaterThan(0);
        expect(t.task.checklist.length, t.slug).toBeGreaterThan(0);
      } else if (t.entityType === "doc") {
        expect(t.doc.body.length, t.slug).toBeGreaterThan(2);
        const json = docContent(t.doc.body) as { type: string; content: unknown[] };
        expect(json.type).toBe("doc");
        expect(json.content.length).toBeGreaterThan(t.doc.body.length - 1);
      } else if (t.entityType === "whiteboard") {
        expect(t.whiteboard.frames.length, t.slug).toBeGreaterThan(1);
        for (const frame of t.whiteboard.frames) {
          expect(frame.prompt.length, `${t.slug} ${frame.title}`).toBeGreaterThan(0);
        }
      } else {
        expect(t.view.answers.length, t.slug).toBeGreaterThan(0);
        for (const flag of t.view.flags?.split(",") ?? []) {
          expect(
            ["active", "approval", "blocked", "mine", "unassigned"],
            t.slug,
          ).toContain(flag);
        }
      }
    }
  });

  it("summarises every entry with stats and samples", () => {
    for (const t of TEMPLATE_CATALOG) {
      const summary = summarizeTemplate(t);
      expect(summary.stats, t.slug).toHaveLength(3);
      expect(summary.outcome.length, t.slug).toBeGreaterThan(0);
      expect(summary.sampleLabel.length, t.slug).toBeGreaterThan(0);
    }
  });

  it("derives facets that cover the catalog", () => {
    const facets = templateCenterCatalog();
    expect(facets.templates).toHaveLength(TEMPLATE_CATALOG.length);
    for (const t of facets.templates) {
      expect(facets.categories).toContain(t.category);
      expect(facets.entityTypes).toContain(t.entityType);
      for (const u of t.useCases) expect(facets.useCases).toContain(u);
    }
  });

  it("builds whiteboard snapshots that pass tldraw's own validators", () => {
    const tlschema = createTLSchema();
    for (const t of TEMPLATE_CATALOG) {
      if (t.entityType !== "whiteboard") continue;
      const snap = boardSnapshot(t.whiteboard.frames) as {
        store: Record<string, { typeName: string }>;
        schema: { schemaVersion: number };
      };
      expect(snap.schema.schemaVersion).toBe(2);
      expect(Object.keys(snap.store).length).toBeGreaterThan(2);
      for (const [id, record] of Object.entries(snap.store)) {
        const recordType = (
          tlschema.types as unknown as Record<
            string,
            { validate: (r: unknown) => unknown }
          >
        )[record.typeName];
        expect(recordType, `${t.slug} ${id}`).toBeTruthy();
        expect(() => recordType.validate(record), `${t.slug} ${id}`).not.toThrow();
      }
    }
  });
});

describe("applying catalog templates", () => {
  it("exposes the catalog and its facets over the query", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(api.templates.catalog, {});
    expect(result.templates.length).toBe(TEMPLATE_CATALOG.length);
    expect(result.entityTypes).toEqual([
      "list",
      "task",
      "doc",
      "whiteboard",
      "view",
    ]);
  });

  it("materialises a list template with statuses, fields, and tasks", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);
    const slug = "product-launch-runway";

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug,
        destinationType: "space",
        destinationId: spaceId,
      });
    expect(result.entityType).toBe("list");
    expect(result.href).toMatch(/^\/dashboard\/l\//);

    const listId = result.href.split("/").pop() as Id<"lists">;
    const entry = TEMPLATE_CATALOG.find((x) => x.slug === slug);
    if (entry?.entityType !== "list") throw new Error("wrong fixture");

    const { statuses, fields, tasks } = await t.run(async (ctx) => ({
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

    expect(statuses).toHaveLength(entry.list.statuses?.length ?? 4);
    expect(fields).toHaveLength(entry.list.fields?.length ?? 0);
    expect(tasks).toHaveLength(entry.list.tasks?.length ?? 0);
    // Seed tasks go through createTaskCore, so checklists and priorities
    // land exactly as a hand-typed task's would.
    const narrative = tasks.find((x) => x.title.startsWith("Write the launch"));
    expect(narrative?.priority).toBe("high");
    expect(narrative?.checklist?.length).toBeGreaterThan(0);
    expect(narrative?.checklist?.every((i) => i.done === false)).toBe(true);
  });

  it("materialises a list template into a folder", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);
    const folderId = await t
      .withIdentity(OWNER)
      .mutation(api.folders.create, { spaceId, name: "Campaigns" });

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug: "editorial-calendar",
        name: "Q3 calendar",
        destinationType: "folder",
        destinationId: folderId,
      });
    expect(result.name).toBe("Q3 calendar");

    const listId = result.href.split("/").pop() as Id<"lists">;
    const list = await t.run(async (ctx) => ctx.db.get(listId));
    expect(list?.parentType).toBe("folder");
    expect(list?.parentId).toBe(folderId);
    expect(list?.name).toBe("Q3 calendar");
  });

  it("materialises a task template with its checklist and subtasks", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);
    const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
      name: "Inbox",
      parentType: "space",
      parentId: spaceId,
    });

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug: "spec-review-task",
        destinationType: "list",
        destinationId: listId,
      });
    expect(result.entityType).toBe("task");

    const tasks = await t.run(async (ctx) =>
      ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", listId))
        .collect(),
    );
    const parent = tasks.find((x) => x.parentTaskId === undefined);
    const subtasks = tasks.filter((x) => x.parentTaskId === parent?._id);
    expect(parent?.checklist?.length).toBeGreaterThan(3);
    expect(subtasks).toHaveLength(3);
  });

  it("materialises a doc template as Tiptap JSON", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug: "prd-doc",
        name: "PRD: Template Center",
        destinationType: "space",
        destinationId: spaceId,
      });
    expect(result.entityType).toBe("doc");
    expect(result.name).toBe("PRD: Template Center");

    const docs = await t.run(async (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", spaceId),
        )
        .collect(),
    );
    expect(docs).toHaveLength(1);
    const content = docs[0].content as { type: string; content: { type: string }[] };
    expect(content.type).toBe("doc");
    expect(content.content.some((n) => n.type === "heading")).toBe(true);
  });

  it("materialises a whiteboard template with a loadable snapshot", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug: "retro-board",
        destinationType: "space",
        destinationId: spaceId,
      });
    expect(result.entityType).toBe("whiteboard");

    const boards = await t.run(async (ctx) =>
      ctx.db
        .query("whiteboards")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", spaceId),
        )
        .collect(),
    );
    expect(boards).toHaveLength(1);
    const snapshot = boards[0].snapshot as {
      store: Record<string, { typeName: string }>;
    };
    const frames = Object.values(snapshot.store).filter(
      (r) => r.typeName === "shape",
    );
    expect(frames.length).toBeGreaterThan(4);
  });

  it("materialises a view template as a saved view on the list", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);
    const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
      name: "Work",
      parentType: "space",
      parentId: spaceId,
    });

    const result = await t
      .withIdentity(OWNER)
      .mutation(api.templates.applyCatalogTemplate, {
        slug: "view-my-open-work",
        destinationType: "list",
        destinationId: listId,
      });
    expect(result.entityType).toBe("view");
    expect(result.href).toContain("view=list");
    expect(result.href).toContain("f=active%2Cmine");

    const views = await t
      .withIdentity(OWNER)
      .query(api.savedViews.listForList, { listId });
    expect(views).toHaveLength(1);
    expect(views[0].flags).toBe("active,mine");

    // Applying the same preset twice would collide on name.
    await expect(
      t.withIdentity(OWNER).mutation(api.templates.applyCatalogTemplate, {
        slug: "view-my-open-work",
        destinationType: "list",
        destinationId: listId,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses an unknown slug and a mismatched destination", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);

    await expect(
      t.withIdentity(OWNER).mutation(api.templates.applyCatalogTemplate, {
        slug: "not-a-real-template",
        destinationType: "space",
        destinationId: spaceId,
      }),
    ).rejects.toThrow(/Unknown template/);

    // A doc template can't be applied to a list.
    const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
      name: "Work",
      parentType: "space",
      parentId: spaceId,
    });
    await expect(
      t.withIdentity(OWNER).mutation(api.templates.applyCatalogTemplate, {
        slug: firstSlugOf("doc"),
        destinationType: "list",
        destinationId: listId,
      }),
    ).rejects.toThrow(/can't be applied/);
  });

  it("refuses to apply into a space the caller can't reach", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const spaceId = await personalSpace(t);

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.templates.applyCatalogTemplate, {
        slug: firstSlugOf("list"),
        destinationType: "space",
        destinationId: spaceId,
      }),
    ).rejects.toThrow();
  });
});
