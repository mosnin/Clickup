import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Checklist templates: reusable playbooks scoped to a personal space or a
// workspace. Applying one appends fresh, unchecked items onto a task's
// embedded checklist; saving one snapshots the task's current items.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const MEMBER = { subject: "user_member", email: "member@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, MEMBER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [OWNER, MEMBER]) {
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

async function makeWorkspaceTask(
  t: ReturnType<typeof convexTest>,
  workspaceId: Id<"workspaces">,
): Promise<Id<"tasks">> {
  const spaceId = await t.withIdentity(OWNER).mutation(api.spaces.create, {
    name: "Team space",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
    name: "Work",
    parentType: "space",
    parentId: spaceId,
  });
  return await t.withIdentity(OWNER).mutation(api.tasks.create, {
    listId,
    title: "Ship it",
  });
}

async function makePersonalTask(
  t: ReturnType<typeof convexTest>,
  who: { subject: string },
): Promise<Id<"tasks">> {
  const spaceId = await t.withIdentity(who).mutation(api.spaces.create, {
    name: "Personal",
    parentType: "user",
    parentId: who.subject,
  });
  const listId = await t.withIdentity(who).mutation(api.lists.create, {
    name: "My list",
    parentType: "space",
    parentId: spaceId,
  });
  return await t.withIdentity(who).mutation(api.tasks.create, {
    listId,
    title: "Do the thing",
  });
}

describe("checklist templates", () => {
  it("creating a workspace template and applying it appends unchecked items", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const taskId = await makeWorkspaceTask(t, workspaceId);

    const templateId = await t
      .withIdentity(OWNER)
      .mutation(api.checklistTemplates.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "Definition of done",
        items: ["Write tests", "Update docs", "  "],
      });

    const templates = await t
      .withIdentity(OWNER)
      .query(api.checklistTemplates.listForTask, { taskId });
    expect(templates).toHaveLength(1);
    expect(templates[0]._id).toBe(templateId);
    expect(templates[0].items).toEqual(["Write tests", "Update docs"]);
    expect(templates[0].source).toBe("workspace");

    await t
      .withIdentity(MEMBER)
      .mutation(api.checklistTemplates.applyToTask, { taskId, templateId });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.checklist).toHaveLength(2);
    expect(task?.checklist?.every((i) => i.done === false)).toBe(true);
    expect(task?.checklist?.map((i) => i.text)).toEqual([
      "Write tests",
      "Update docs",
    ]);
    // Item ids are fresh and unique.
    const ids = new Set(task?.checklist?.map((i) => i.id));
    expect(ids.size).toBe(2);
  });

  it("applying a template keeps the task's existing checklist items", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const taskId = await makeWorkspaceTask(t, workspaceId);

    await t.withIdentity(OWNER).mutation(api.tasks.update, {
      taskId,
      checklist: [{ id: "existing-1", text: "Already there", done: true }],
    });

    const templateId = await t
      .withIdentity(OWNER)
      .mutation(api.checklistTemplates.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "Release steps",
        items: ["Tag release"],
      });

    await t
      .withIdentity(OWNER)
      .mutation(api.checklistTemplates.applyToTask, { taskId, templateId });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.checklist).toHaveLength(2);
    expect(task?.checklist?.[0]).toEqual({
      id: "existing-1",
      text: "Already there",
      done: true,
    });
    expect(task?.checklist?.[1].text).toBe("Tag release");
    expect(task?.checklist?.[1].done).toBe(false);
  });

  it("saveFromTask snapshots the task's current checklist texts", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const taskId = await makeWorkspaceTask(t, workspaceId);

    await t.withIdentity(OWNER).mutation(api.tasks.update, {
      taskId,
      checklist: [
        { id: "a", text: "Review PR", done: false },
        { id: "b", text: "Deploy", done: true },
      ],
    });

    const templateId = await t
      .withIdentity(OWNER)
      .mutation(api.checklistTemplates.saveFromTask, {
        taskId,
        name: "Snapshot",
      });

    const template = await t.run(async (ctx) => ctx.db.get(templateId));
    expect(template?.items).toEqual(["Review PR", "Deploy"]);
    expect(template?.scopeType).toBe("workspace");
    expect(template?.scopeId).toBe(workspaceId);

    // Refuses when the task has no checklist items yet.
    const emptyTaskId = await makeWorkspaceTask(t, workspaceId);
    await expect(
      t.withIdentity(OWNER).mutation(api.checklistTemplates.saveFromTask, {
        taskId: emptyTaskId,
        name: "Nothing",
      }),
    ).rejects.toThrow(/no checklist items/i);
  });

  it("an outsider cannot create, list, apply, or delete a workspace's templates", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const taskId = await makeWorkspaceTask(t, workspaceId);

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.checklistTemplates.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "Sneaky",
        items: ["Nope"],
      }),
    ).rejects.toThrow(/forbidden/i);

    const templateId = await t
      .withIdentity(OWNER)
      .mutation(api.checklistTemplates.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "Definition of done",
        items: ["Write tests"],
      });

    // listForTask fails closed (empty array) for someone with no task
    // access rather than throwing.
    const outsiderTaskId = await makePersonalTask(t, OUTSIDER);
    expect(
      await t
        .withIdentity(OUTSIDER)
        .query(api.checklistTemplates.listForTask, {
          taskId: outsiderTaskId,
        }),
    ).toEqual([]);

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.checklistTemplates.applyToTask, {
        taskId,
        templateId,
      }),
    ).rejects.toThrow();

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.checklistTemplates.remove, {
        templateId,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("a personal template cannot be applied to another user's task, but the caller's own personal templates surface on a shared workspace task", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const workspaceTaskId = await makeWorkspaceTask(t, workspaceId);

    const personalTemplateId = await t
      .withIdentity(MEMBER)
      .mutation(api.checklistTemplates.create, {
        scopeType: "user",
        scopeId: MEMBER.subject,
        name: "My own playbook",
        items: ["Personal step"],
      });

    // Shows up (labeled personal) when MEMBER looks at a workspace task
    // they can access.
    const templatesForMember = await t
      .withIdentity(MEMBER)
      .query(api.checklistTemplates.listForTask, {
        taskId: workspaceTaskId,
      });
    expect(
      templatesForMember.some(
        (tpl) => tpl._id === personalTemplateId && tpl.source === "personal",
      ),
    ).toBe(true);

    // OWNER does not see MEMBER's personal template on the same task.
    const templatesForOwner = await t
      .withIdentity(OWNER)
      .query(api.checklistTemplates.listForTask, {
        taskId: workspaceTaskId,
      });
    expect(
      templatesForOwner.some((tpl) => tpl._id === personalTemplateId),
    ).toBe(false);

    // A different user's personal task can't be targeted with someone
    // else's personal template.
    const ownerPersonalTaskId = await makePersonalTask(t, OWNER);
    await expect(
      t.withIdentity(OWNER).mutation(api.checklistTemplates.applyToTask, {
        taskId: ownerPersonalTaskId,
        templateId: personalTemplateId,
      }),
    ).rejects.toThrow(/forbidden/i);

    // MEMBER may apply their own personal template to the workspace task.
    await t.withIdentity(MEMBER).mutation(api.checklistTemplates.applyToTask, {
      taskId: workspaceTaskId,
      templateId: personalTemplateId,
    });
    const task = await t.run(async (ctx) => ctx.db.get(workspaceTaskId));
    expect(task?.checklist?.map((i) => i.text)).toEqual(["Personal step"]);
  });
});
