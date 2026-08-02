import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  builtInPanelQuestion,
  mintFromBuiltIn,
  projectPanelQuestion,
} from "../src/lib/built-in-panel";
import { PANEL_PRESETS } from "../src/lib/panel-intent";
import { normalizePanel } from "../src/lib/panel";

// The mint round trip, against the functions it actually calls.
//
// The client half of this was driven in a browser against a *stub* of
// `uiComponents.create`, which can only ever prove that the client is
// self-consistent. A stub agrees with whatever it is handed: the argument shape
// it never validates, the scope check it does not perform, the id it invents.
// Everything below runs the real mutation, the real access check and the real
// resolver, so what is asserted is that the two halves meet.
//
// Three things are being answered:
//
//   1. **Does `create` accept what the shelf sends, and does authorization pass
//      for an ordinary reader?** A minted definition is a plain nested object;
//      Convex validators and access checks are the two ways that can fail
//      silently-at-build and loudly-at-runtime.
//   2. **Does the project question select the project's tasks?** The whole bar
//      for stating a question is that it selects the same records the built-in
//      does. `scopeToKind: "project"` is honoured by exactly one branch of the
//      resolver, so it is worth watching narrow.
//   3. **Does a date-dimensioned chart show recent days?** The completion chart
//      dropped its `filter.window` to stop under-counting; that is only an
//      improvement if the buckets it keeps when there are too many are the
//      newest ones.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };
const DAY = 86_400_000;

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Northwind",
      slug: "northwind",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: id,
      role: "owner",
      joinedAt: Date.now(),
    });
    return id;
  });

  const alice = t.withIdentity(ALICE);
  const spaceId = await alice.mutation(api.spaces.create, {
    name: "HQ",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const projectId = await alice.mutation(api.projects.create, {
    spaceId,
    name: "Billing migration",
  });
  const inProject = await alice.mutation(api.lists.create, {
    parentType: "project",
    parentId: projectId,
    name: "Backlog",
  });
  // A list in the same space but OUTSIDE the project. Without one of these,
  // "narrowed to the project" and "everything the scope can see" are the same
  // set and the assertion proves nothing.
  const outsideProject = await alice.mutation(api.lists.create, {
    parentType: "space",
    parentId: spaceId,
    name: "Loose ends",
  });

  const statuses = await t.run(async (ctx) =>
    ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", inProject))
      .collect(),
  );
  const open = statuses.find((s) => s.category === "open")!;
  const done = statuses.find((s) => s.category === "complete")!;

  return {
    t,
    alice,
    workspaceId,
    projectId,
    inProject,
    outsideProject,
    open,
    done,
  };
}

/** Insert tasks directly — the shapes here are about reading, not writing. */
async function addTasks(
  t: Awaited<ReturnType<typeof seed>>["t"],
  listId: Id<"lists">,
  statusId: Id<"listStatuses">,
  count: number,
  completedAt?: (i: number) => number,
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("tasks", {
        listId,
        title: `Task ${i}`,
        statusId,
        assigneeClerkIds: [],
        createdByClerkId: ALICE.subject,
        position: i,
        createdAt: Date.now(),
        ...(completedAt ? { completedAt: completedAt(i) } : {}),
      });
    }
  });
}

describe("minting a panel from a built-in, end to end", () => {
  it("stores what the shelf sends and hands it back unchanged", async () => {
    const { alice, workspaceId } = await seed();
    const question = builtInPanelQuestion("agents")!;
    const definition = mintFromBuiltIn(question, "donut");

    // Exactly the call ShapeShelf makes: `{ ...scope, definition }`.
    const componentId = await alice.mutation(api.uiComponents.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      definition,
    });
    expect(typeof componentId).toBe("string");

    // What the shelf re-reads through, to edit the panel it just made.
    const row = await alice.query(api.uiComponents.get, {
      componentId: componentId as unknown as string,
    });
    expect(row).not.toBeNull();
    expect(row!.definition).toEqual(definition);
    expect(row!.scopeType).toBe("workspace");
    expect(row!.scopeId).toBe(workspaceId);

    // And what the screen reads to draw it in the slot the built-in vacated.
    const listed = await alice.query(api.uiComponents.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(listed.map((r) => r.componentId)).toContain(componentId);
    // Stored opaque and normalized on read: the row a screen renders must be a
    // fixed point, or the tile's title and the panel's contents disagree.
    expect(normalizePanel(listed[0].definition)).toEqual(definition);
  });

  it("refuses a scope the reader is not in", async () => {
    const { t, workspaceId } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.uiComponents.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        definition: { title: "Nope" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a personal scope that is not the caller's own", async () => {
    // Home mints into `{ user, <clerk id> }`. If that pair were not checked,
    // one person's Home could write panels into another's.
    const { alice } = await seed();
    await expect(
      alice.mutation(api.uiComponents.create, {
        scopeType: "user",
        scopeId: OUTSIDER.subject,
        definition: { title: "Nope" },
      }),
    ).rejects.toThrow();
    await expect(
      alice.mutation(api.uiComponents.create, {
        scopeType: "user",
        scopeId: ALICE.subject,
        definition: { title: "Mine" },
      }),
    ).resolves.toBeTruthy();
  });
});

describe("what the project screen's question selects", () => {
  it("counts this project's tasks and nothing else", async () => {
    const { t, alice, workspaceId, projectId, inProject, outsideProject, open, done } =
      await seed();
    await addTasks(t, inProject, open._id, 3);
    await addTasks(t, inProject, done._id, 2);
    // Same space, same scope, different project — the tasks the built-in's
    // rollup does not see and the panel must not either.
    await addTasks(t, outsideProject, open._id, 7);

    const question = projectPanelQuestion("progress", projectId)!;
    const envelope = await alice.query(api.dataStream.resolve, {
      scopeType: "workspace",
      scopeId: workspaceId,
      query: question.query,
    });

    expect(envelope.total).toBe(5);
    const points = envelope.series[0].points;
    expect(points.map((p) => p.value).reduce((a, b) => a + b, 0)).toBe(5);
    // The composition the built-in prints as one percentage: 2 of 5 complete.
    const complete = points.find((p) => p.key === done._id);
    expect(complete?.value).toBe(2);
  });

  it("does not answer for the widgets that have no question", async () => {
    const { projectId } = await seed();
    for (const id of [
      "about",
      "lists",
      "status",
      "owner",
      "target-date",
      "pages",
      "notes",
      "activity",
      "agent-stream",
      "plan",
      "nope",
    ]) {
      expect(projectPanelQuestion(id, projectId), id).toBeNull();
    }
  });
});

describe("a chart of days shows the recent ones", () => {
  it("keeps the newest buckets when there are more than fit", async () => {
    // 70 days of completions, which is past the resolver's 60-bucket ceiling.
    // The old truncation kept the first sixty, so a long-lived account's
    // "finished each day" chart drew its oldest history and looked current.
    const { t, alice, workspaceId, inProject, done } = await seed();
    const base = Date.now() - 70 * DAY;
    await addTasks(t, inProject, done._id, 70, (i) => base + i * DAY);

    const preset = PANEL_PRESETS.find((p) => p.id === "burn")!;
    const def = normalizePanel(preset.def);
    expect(def.query.filter.window).toBe("all");

    const envelope = await alice.query(api.dataStream.resolve, {
      scopeType: "workspace",
      scopeId: workspaceId,
      query: def.query,
    });
    expect(envelope.truncated).toBe(true);
    const keys = envelope.series[0].points.map((p) => Number(p.key));
    expect(keys.length).toBe(60);
    // The last completion is in the window that survived; the first is not.
    const newest = base + 69 * DAY;
    const oldest = base;
    expect(Math.max(...keys)).toBeGreaterThanOrEqual(newest - DAY);
    expect(Math.min(...keys)).toBeGreaterThan(oldest);
  });
});
