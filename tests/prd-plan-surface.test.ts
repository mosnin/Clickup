import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

// Phase N — the PRD-audit top-5 on the agent surface: roadmap authoring,
// structure lifecycle parity, bulk create with refs/deps, field
// round-trip (estimatePoints/milestone/position), and the creation gaps
// (custom fields, statuses, project-linked goals).

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

async function setupWorkspace() {
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
    const listId = await ctx.db.insert("lists", {
      name: "Foundation",
      parentType: "space",
      parentId: spaceId,
      position: 0,
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
    const agentId = await ctx.db.insert("agents", {
      name: "Planner",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_planner";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return {
      workspaceId,
      spaceId,
      listId,
      openStatus,
      doneStatus,
      agentId,
      apiKey,
    };
  });
  return { t, ...ids };
}

function errText(e: unknown): string {
  return e instanceof ConvexError ? String(e.data) : String(e);
}

describe("agent roadmap authoring", () => {
  it("creates a roadmap with explicit phases (no Now/Next/Later defaults)", async () => {
    const { t, apiKey, listId } = await setupWorkspace();
    const created = await t.mutation(api.agentApi.createRoadmap, {
      apiKey,
      name: "Nimbus",
      phases: [
        { name: "M1 Foundation", targetDate: 1_800_000_000_000 },
        { name: "M2 Intake" },
      ],
    });
    expect(created.phases.map((p: { name: string }) => p.name)).toEqual([
      "M1 Foundation",
      "M2 Intake",
    ]);
    expect(created.phases[0].targetDate).toBe(1_800_000_000_000);

    // Add / update / place / read back — the full authoring loop.
    const { phaseId } = await t.mutation(api.agentApi.addRoadmapPhase, {
      apiKey,
      roadmapId: created.roadmapId,
      name: "M3 Launch",
    });
    await t.mutation(api.agentApi.updateRoadmapPhase, {
      apiKey,
      roadmapId: created.roadmapId,
      phaseId,
      targetDate: 1_900_000_000_000,
    });
    await t.mutation(api.agentApi.assignProjectToPhase, {
      apiKey,
      listId,
      roadmapId: created.roadmapId,
      phaseId: created.phases[0].id,
    });
    const roadmaps = await t.query(api.agentApi.getRoadmaps, { apiKey });
    const rm = roadmaps.find((r) => r.roadmapId === created.roadmapId)!;
    expect(rm.phases).toHaveLength(3);
    expect(rm.phases[2].targetDate).toBe(1_900_000_000_000);
    expect(rm.projects[0].phaseId).toBe(created.phases[0].id);
  });

  it("emits roadmap events for the activity feed", async () => {
    const { t, apiKey, workspaceId } = await setupWorkspace();
    await t.mutation(api.agentApi.createRoadmap, { apiKey, name: "R" });
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "workspace").eq("scopeId", workspaceId),
        )
        .collect(),
    );
    expect(events.some((e) => e.type === "roadmap.created")).toBe(true);
  });

  it("refuses phase updates on a roadmap outside the agent's workspace", async () => {
    const { t, apiKey } = await setupWorkspace();
    const otherRoadmap = await t.run(async (ctx) => {
      const otherWs = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: "user_bob",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("roadmaps", {
        workspaceId: otherWs,
        name: "Theirs",
        phases: [{ id: "ph_x", name: "Now" }],
        position: 0,
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentApi.addRoadmapPhase, {
        apiKey,
        roadmapId: otherRoadmap,
        name: "Sneaky",
      }),
    ).rejects.toThrow(/not found in your workspace/i);
  });
});

describe("structure lifecycle parity", () => {
  it("renames, annotates, reorders, and deletes lists as the agent", async () => {
    const { t, apiKey, spaceId, listId } = await setupWorkspace();
    // The typo'd-list recovery the audit called permanent garbage:
    const typoId = await t.mutation(api.agentApi.createList, {
      apiKey,
      name: "Trage inbox work",
      parentType: "space",
      parentId: spaceId,
    });
    await t.mutation(api.agentApi.renameList, {
      apiKey,
      listId: typoId,
      name: "Triage inbox work",
    });
    await t.mutation(api.agentApi.updateListMeta, {
      apiKey,
      listId: typoId,
      description: "All customer feedback triage",
      projectStatus: "on_track",
      targetDate: 1_800_000_000_000,
    });
    await t.mutation(api.agentApi.reorderLists, {
      apiKey,
      parentType: "space",
      parentId: spaceId,
      orderedIds: [typoId, listId],
    });

    const tree = (await t.query(api.agentApi.getTree, { apiKey })) as {
      spaces: {
        lists: {
          listId: string;
          name: string;
          projectStatus: string | null;
          targetDate: number | null;
        }[];
      }[];
    };
    const lists = tree.spaces.flatMap((s) => s.lists);
    const renamed = lists.find((l) => l.listId === typoId)!;
    expect(renamed.name).toBe("Triage inbox work");
    expect(renamed.projectStatus).toBe("on_track");
    expect(renamed.targetDate).toBe(1_800_000_000_000);

    await t.mutation(api.agentApi.deleteList, { apiKey, listId: typoId });
    const after = await t.run(async (ctx) => ctx.db.get(typoId));
    expect(after).toBeNull();
  });

  it("refuses structure ops to list-restricted agents", async () => {
    const { t, apiKey, listId, agentId } = await setupWorkspace();
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { allowedListIds: [listId] });
    });
    await expect(
      t.mutation(api.agentApi.renameList, {
        apiKey,
        listId,
        name: "Nope",
      }),
    ).rejects.toThrow();
  });
});

describe("bulk create_tasks", () => {
  it("creates a plan-slice with refs, subtasks, and dependencies in one call", async () => {
    const { t, apiKey, listId } = await setupWorkspace();
    const result = await t.mutation(api.agentApi.createTasks, {
      apiKey,
      listId,
      tasks: [
        {
          ref: "epic",
          title: "Auth epic",
          milestone: true,
          estimatePoints: 8,
        },
        { ref: "schema", title: "Postgres schema", parentRef: "epic" },
        {
          ref: "oauth",
          title: "OAuth flow",
          parentRef: "epic",
          dependsOn: ["schema"],
        },
        { title: "CI pipeline", dependsOn: ["epic"] },
      ],
    });
    expect(result.count).toBe(4);

    const epicId = result.created.find((c) => c.ref === "epic")!.taskId;
    const oauthId = result.created.find((c) => c.ref === "oauth")!.taskId;
    const oauth = await t.query(api.agentApi.getTask, {
      apiKey,
      taskId: oauthId,
    });
    expect(oauth.parentTaskId).toBe(epicId);
    expect(oauth.blockedBy.map((b: { title: string }) => b.title)).toEqual([
      "Postgres schema",
    ]);

    // Round-trip: estimate + milestone + position now visible on reads.
    const epic = await t.query(api.agentApi.getTask, {
      apiKey,
      taskId: epicId,
    });
    expect(epic.milestone).toBe(true);
    expect(epic.estimatePoints).toBe(8);
    expect(typeof epic.position).toBe("number");
  });

  it("rejects duplicate refs, forward parentRefs, and >50 batches", async () => {
    const { t, apiKey, listId } = await setupWorkspace();
    await expect(
      t.mutation(api.agentApi.createTasks, {
        apiKey,
        listId,
        tasks: [
          { ref: "a", title: "One" },
          { ref: "a", title: "Two" },
        ],
      }),
    ).rejects.toThrow(/duplicate ref/i);
    await expect(
      t.mutation(api.agentApi.createTasks, {
        apiKey,
        listId,
        tasks: [
          { title: "Child", parentRef: "later" },
          { ref: "later", title: "Parent" },
        ],
      }),
    ).rejects.toThrow(/earlier task/i);
    await expect(
      t.mutation(api.agentApi.createTasks, {
        apiKey,
        listId,
        tasks: Array.from({ length: 51 }, (_, i) => ({ title: `T${i}` })),
      }),
    ).rejects.toThrow(/capped at 50/i);
  });

  it("reorder_tasks sets the order list_tasks reads back", async () => {
    const { t, apiKey, listId } = await setupWorkspace();
    const { created } = await t.mutation(api.agentApi.createTasks, {
      apiKey,
      listId,
      tasks: [{ title: "First" }, { title: "Second" }, { title: "Third" }],
    });
    const ids = created.map((c) => c.taskId);
    await t.mutation(api.agentApi.reorderTasks, {
      apiKey,
      listId,
      orderedIds: [ids[2], ids[0], ids[1]],
    });
    const tasks = await t.query(api.agentApi.listTasks, { apiKey, listId });
    expect(tasks.map((v: { title: string }) => v.title)).toEqual([
      "Third",
      "First",
      "Second",
    ]);
  });
});

describe("creation gaps", () => {
  it("creates custom fields and statuses as the agent", async () => {
    const { t, apiKey, listId } = await setupWorkspace();
    const { fieldId } = await t.mutation(api.agentApi.createCustomField, {
      apiKey,
      listId,
      name: "Severity",
      type: "dropdown",
      options: [
        { id: "sev1", label: "Sev 1" },
        { id: "sev2", label: "Sev 2" },
      ],
    });
    expect(fieldId).toBeTruthy();
    await expect(
      t.mutation(api.agentApi.createCustomField, {
        apiKey,
        listId,
        name: "Empty dropdown",
        type: "dropdown",
      }),
    ).rejects.toThrow(/at least one option/i);

    const { statusId } = await t.mutation(api.agentApi.createStatus, {
      apiKey,
      listId,
      name: "QA",
      category: "in_progress",
    });
    const statuses = await t.query(api.agentApi.listStatusesForList, {
      apiKey,
      listId,
    });
    expect(
      statuses.some(
        (s: { statusId: string; name: string }) =>
          s.statusId === statusId && s.name === "QA",
      ),
    ).toBe(true);
  });

  it("creates a project-linked goal that auto-rolls up and refuses manual progress", async () => {
    const { t, apiKey, listId, doneStatus } = await setupWorkspace();
    const goalId = await t.mutation(api.agentApi.createGoal, {
      apiKey,
      title: "Ship Foundation",
      targetType: "number",
      targetValue: 2,
      sourceListId: listId,
    });

    // Boolean goals can't link:
    await expect(
      t.mutation(api.agentApi.createGoal, {
        apiKey,
        title: "Bad",
        targetType: "boolean",
        targetValue: 1,
        sourceListId: listId,
      }),
    ).rejects.toThrow(/number goals/i);

    // Manual progress on the linked goal is refused (derives from tasks):
    await expect(
      t.mutation(api.agentApi.setGoalProgress, {
        apiKey,
        goalId,
        currentValue: 5,
      }),
    ).rejects.toThrow(/tracks a project automatically/i);

    // Completing tasks moves it:
    const { created } = await t.mutation(api.agentApi.createTasks, {
      apiKey,
      listId,
      tasks: [{ title: "A" }, { title: "B" }],
    });
    for (const c of created) {
      await t.mutation(api.agentApi.updateTask, {
        apiKey,
        taskId: c.taskId,
        statusId: doneStatus,
      });
    }
    const goals = await t.query(api.agentApi.listGoals, { apiKey });
    const linked = goals.find((g) => g.goalId === goalId)!;
    expect(linked.currentValue).toBe(2);
    expect(linked.status).toBe("complete");
    expect(linked.linked).toBe(true);
  });

  it("refuses linking a goal to a private-space project", async () => {
    const { t, apiKey, workspaceId } = await setupWorkspace();
    const privateListId = await t.run(async (ctx) => {
      const privSpace = await ctx.db.insert("spaces", {
        name: "Secret",
        parentType: "workspace",
        parentId: workspaceId,
        private: true,
        memberClerkIds: [ALICE.subject],
        position: 1,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("lists", {
        name: "Hidden",
        parentType: "space",
        parentId: privSpace,
        position: 0,
        createdAt: Date.now(),
      });
    });
    try {
      await t.mutation(api.agentApi.createGoal, {
        apiKey,
        title: "Leak",
        targetType: "number",
        targetValue: 1,
        sourceListId: privateListId,
      });
      expect.unreachable("should have refused");
    } catch (e) {
      // Either the access check or the privacy check may fire first;
      // both are correct refusals.
      expect(errText(e)).toMatch(/private|scope|access/i);
    }
  });
});
