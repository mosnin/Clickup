import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import {
  SPRINT_TEMPLATES,
  findSprintTemplate,
  sprintTemplateCatalog,
} from "../convex/sprintTemplates";

// Sprint templates: the in-code catalog (convex/sprintTemplates.ts) and
// sprints.applyTemplate, which routes both cores — createSprintCore for
// the timebox, createTaskCore for every ceremony and starter task — in one
// transaction.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.test" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.test" };

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const u of [OWNER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
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
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Delivery",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#c9ccd4",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#a9dcbd",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, listId };
  });
  return { t, ...ids };
}

function errText(e: unknown): string {
  return e instanceof ConvexError ? String(e.data) : String(e);
}

describe("sprint template catalog", () => {
  it("ships a library of at least 24 templates", () => {
    expect(SPRINT_TEMPLATES.length).toBeGreaterThanOrEqual(24);
  });

  it("has unique slugs", () => {
    const slugs = SPRINT_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("gives every template ceremonies, starter tasks, and a usable timebox", () => {
    for (const t of SPRINT_TEMPLATES) {
      expect(t.ceremonies.length, t.slug).toBeGreaterThan(0);
      expect(t.starterTasks.length, t.slug).toBeGreaterThan(0);
      expect(t.lengthDays, t.slug).toBeGreaterThan(0);
      expect(t.name.trim(), t.slug).not.toBe("");
      expect(t.description.trim(), t.slug).not.toBe("");
      expect(t.goalTemplate.trim(), t.slug).not.toBe("");
      expect(t.category.trim(), t.slug).not.toBe("");
      expect(t.useCases.length, t.slug).toBeGreaterThan(0);
      expect(
        ["beginner", "intermediate", "advanced"],
        t.slug,
      ).toContain(t.complexity);

      for (const c of t.ceremonies) {
        expect(c.title.trim(), `${t.slug}/${c.title}`).not.toBe("");
        expect(c.dayOffset, `${t.slug}/${c.title}`).toBeGreaterThanOrEqual(0);
        expect(c.dayOffset, `${t.slug}/${c.title}`).toBeLessThanOrEqual(
          t.lengthDays,
        );
      }
      for (const s of t.starterTasks) {
        expect(s.title.trim(), `${t.slug}/${s.title}`).not.toBe("");
        // Acceptance criteria are the point — a starter task without a
        // checklist is just a title someone has to interpret.
        expect(s.checklist.length, `${t.slug}/${s.title}`).toBeGreaterThan(0);
        for (const item of s.checklist) {
          expect(item.trim(), `${t.slug}/${s.title}`).not.toBe("");
        }
        if (s.dueDayOffset !== undefined) {
          expect(s.dueDayOffset, `${t.slug}/${s.title}`).toBeGreaterThanOrEqual(0);
          expect(s.dueDayOffset, `${t.slug}/${s.title}`).toBeLessThanOrEqual(
            t.lengthDays,
          );
        }
      }
    }
  });

  it("summarizes counts and facets for the gallery", () => {
    const catalog = sprintTemplateCatalog();
    expect(catalog.templates.length).toBe(SPRINT_TEMPLATES.length);
    expect(catalog.categories.length).toBeGreaterThan(5);
    expect(catalog.complexities).toEqual([
      "beginner",
      "intermediate",
      "advanced",
    ]);
    // Facets must cover every template, or the filter row can hide rows.
    for (const t of catalog.templates) {
      expect(catalog.categories).toContain(t.category);
      expect(catalog.complexities).toContain(t.complexity);
    }
    const two = catalog.templates.find(
      (t) => t.slug === "two-week-product-sprint",
    )!;
    const source = findSprintTemplate("two-week-product-sprint")!;
    expect(two.ceremonyCount).toBe(source.ceremonies.length);
    expect(two.taskCount).toBe(source.starterTasks.length);
    expect(two.totalPoints).toBeGreaterThan(0);
  });

  it("is readable over the public query", async () => {
    const { t } = await setup();
    const catalog = await t.query(api.sprints.templateCatalog, {});
    expect(catalog.templates.length).toBe(SPRINT_TEMPLATES.length);
  });
});

describe("applying a sprint template", () => {
  it("creates the sprint with every ceremony and starter task attached", async () => {
    const { t, workspaceId, listId } = await setup();
    const owner = t.withIdentity(OWNER);
    const template = findSprintTemplate("two-week-product-sprint")!;
    const startDate = Date.now();

    const result = await owner.mutation(api.sprints.applyTemplate, {
      workspaceId,
      slug: template.slug,
      startDate,
      listId,
      name: "Sprint 12",
    });

    expect(result.taskIds.length).toBe(
      template.ceremonies.length + template.starterTasks.length,
    );

    const summary = await owner.query(api.sprints.summary, {
      sprintId: result.sprintId,
    });
    expect(summary).not.toBeNull();
    expect(summary!.sprint.name).toBe("Sprint 12");
    expect(summary!.sprint.goal).toBe(template.goalTemplate);
    expect(summary!.sprint.status).toBe("planned");
    expect(summary!.sprint.capacityPoints).toBe(template.capacityPoints);
    expect(summary!.sprint.endDate - summary!.sprint.startDate).toBe(
      template.lengthDays * ONE_DAY_MS,
    );
    expect(summary!.totals.total).toBe(result.taskIds.length);

    const titles = summary!.tasks.map((task) => task.title);
    for (const c of template.ceremonies) expect(titles).toContain(c.title);
    for (const s of template.starterTasks) expect(titles).toContain(s.title);

    // Materialized through createTaskCore: sprint attached, dates inside
    // the window, checklists carried over as acceptance criteria.
    const tasks = await t.run(async (ctx) =>
      ctx.db
        .query("tasks")
        .withIndex("by_sprint", (q) => q.eq("sprintId", result.sprintId))
        .collect(),
    );
    expect(tasks.length).toBe(result.taskIds.length);
    for (const task of tasks) {
      expect(task.listId).toBe(listId);
      expect(task.dueDate).toBeDefined();
      expect(task.dueDate!).toBeGreaterThanOrEqual(startDate);
      expect(task.dueDate!).toBeLessThanOrEqual(
        startDate + template.lengthDays * ONE_DAY_MS,
      );
    }
    const planning = tasks.find((task) => task.title === "Sprint planning")!;
    expect(planning.dueDate).toBe(startDate);
    const standup = tasks.find((task) => task.title === "Daily standup")!;
    expect(standup.recurrence).toBe("daily");
    const withChecklist = tasks.find(
      (task) => task.title === template.starterTasks[0].title,
    )!;
    expect(withChecklist.checklist?.length).toBe(
      template.starterTasks[0].checklist.length,
    );
    expect(withChecklist.checklist?.every((i) => i.done === false)).toBe(true);

    // The cores emit their own events — no template-only write path.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "workspace").eq("scopeId", workspaceId),
        )
        .collect(),
    );
    expect(events.some((e) => e.type === "sprint.created")).toBe(true);
    expect(events.filter((e) => e.type === "task.created").length).toBe(
      result.taskIds.length,
    );
  });

  it("creates the timebox alone when no destination list is given", async () => {
    const { t, workspaceId } = await setup();
    const owner = t.withIdentity(OWNER);
    const result = await owner.mutation(api.sprints.applyTemplate, {
      workspaceId,
      slug: "design-sprint-5-day",
      startDate: Date.now(),
    });
    expect(result.taskIds).toEqual([]);
    const summary = await owner.query(api.sprints.summary, {
      sprintId: result.sprintId,
    });
    expect(summary!.totals.total).toBe(0);
    expect(summary!.sprint.name).toBe("Design sprint (5-day)");
  });

  it("refuses an unknown slug with a useful message", async () => {
    const { t, workspaceId, listId } = await setup();
    const owner = t.withIdentity(OWNER);
    await expect(
      owner.mutation(api.sprints.applyTemplate, {
        workspaceId,
        slug: "not-a-real-template",
        startDate: Date.now(),
        listId,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        errText(e).includes("not-a-real-template") &&
        errText(e).includes("templateCatalog"),
    );
  });

  it("refuses a non-member", async () => {
    const { t, workspaceId, listId } = await setup();
    const outsider = t.withIdentity(OUTSIDER);
    await expect(
      outsider.mutation(api.sprints.applyTemplate, {
        workspaceId,
        slug: "one-week-delivery-sprint",
        startDate: Date.now(),
        listId,
      }),
    ).rejects.toThrow();
    const sprints = await t.run(async (ctx) =>
      ctx.db.query("sprints").collect(),
    );
    expect(sprints.length).toBe(0);
  });

  it("refuses a destination list in another workspace", async () => {
    const { t, workspaceId } = await setup();
    const owner = t.withIdentity(OWNER);
    const otherListId = await t.run(async (ctx) => {
      const otherWorkspace = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: otherWorkspace,
        userClerkId: OWNER.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      const spaceId = await ctx.db.insert("spaces", {
        name: "Other HQ",
        parentType: "workspace",
        parentId: otherWorkspace,
        position: 0,
        createdAt: Date.now(),
      });
      const listId = await ctx.db.insert("lists", {
        name: "Other list",
        parentType: "space",
        parentId: spaceId,
        position: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("listStatuses", {
        listId,
        name: "To Do",
        color: "#c9ccd4",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      return listId;
    });

    await expect(
      owner.mutation(api.sprints.applyTemplate, {
        workspaceId,
        slug: "one-week-delivery-sprint",
        startDate: Date.now(),
        listId: otherListId,
      }),
    ).rejects.toSatisfy((e: unknown) =>
      errText(e).includes("same workspace"),
    );
  });
});
