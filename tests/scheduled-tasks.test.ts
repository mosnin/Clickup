import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { computeNextRunAt } from "../convex/scheduledTasks";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "schedule_owner", email: "owner@schedule.test" };

// Monday 2026-07-13 10:30 UTC.
const MON_1030 = Date.UTC(2026, 6, 13, 10, 30);

describe("computeNextRunAt", () => {
  it("hourly: advances to the next top of hour", () => {
    expect(computeNextRunAt(MON_1030, "hourly", 9)).toBe(
      Date.UTC(2026, 6, 13, 11),
    );
    expect(
      computeNextRunAt(Date.UTC(2026, 6, 13, 10), "hourly", 23),
    ).toBe(Date.UTC(2026, 6, 13, 11));
  });

  it("daily: next occurrence strictly after `after`", () => {
    // 09:00 already passed today → tomorrow 09:00.
    expect(computeNextRunAt(MON_1030, "daily", 9)).toBe(
      Date.UTC(2026, 6, 14, 9),
    );
    // 12:00 still ahead today.
    expect(computeNextRunAt(MON_1030, "daily", 12)).toBe(
      Date.UTC(2026, 6, 13, 12),
    );
  });

  it("weekly: lands on the requested weekday", () => {
    // Monday 09:00 already passed → next Monday.
    expect(computeNextRunAt(MON_1030, "weekly", 9, 1)).toBe(
      Date.UTC(2026, 6, 20, 9),
    );
    // Wednesday this week.
    expect(computeNextRunAt(MON_1030, "weekly", 9, 3)).toBe(
      Date.UTC(2026, 6, 15, 9),
    );
  });

  it("monthly: clamps day-of-month into 1..28 and rolls forward", () => {
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 1)).toBe(
      Date.UTC(2026, 7, 1, 9),
    );
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 28)).toBe(
      Date.UTC(2026, 6, 28, 9),
    );
    // 31 → clamped to 28 so February always works.
    expect(computeNextRunAt(MON_1030, "monthly", 9, undefined, 31)).toBe(
      Date.UTC(2026, 6, 28, 9),
    );
  });

  it("always returns a strictly future time", () => {
    for (const cadence of ["hourly", "daily", "weekly", "monthly"] as const) {
      const next = computeNextRunAt(MON_1030, cadence, 10, 1, 13);
      expect(next).toBeGreaterThan(MON_1030);
    }
  });

  it("materializes hourly agent work into the durable wake inbox", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, agentId, blueprintId } = await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: OWNER.subject,
        email: OWNER.email,
      });
      const wsId = await ctx.db.insert("workspaces", {
        name: "Autonomous Ops",
        slug: "autonomous-ops",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: wsId,
        userClerkId: OWNER.subject,
        role: "owner",
        joinedAt: Date.now(),
      });
      const workerId = await ctx.db.insert("agents", {
        name: "Hourly operator",
        parentType: "workspace",
        parentId: wsId,
        status: "active",
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId: workerId,
        keyHash: sha256Hex("cua_hourly_operator"),
        keyPrefix: "cua_hour",
        createdAt: Date.now(),
      });
      const bpId = await ctx.db.insert("taskBlueprints", {
        scopeType: "workspace",
        scopeId: wsId,
        name: "Agent health SOP",
        title: "Inspect agent health",
        description: "Verify presence, wake consumption, and stalled work.",
        priority: "high",
        checklist: [
          "Review presence",
          "Review unconsumed wakes",
          "Escalate stale work",
        ],
        estimatePoints: 1,
        requiresApproval: true,
        createdByActorId: OWNER.subject,
        createdAt: Date.now(),
      });
      return {
        workspaceId: wsId,
        agentId: workerId,
        blueprintId: bpId,
      };
    });
    const spaceId = await t.withIdentity(OWNER).mutation(api.spaces.create, {
      name: "Operations",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const listId = await t.withIdentity(OWNER).mutation(api.lists.create, {
      name: "Health checks",
      parentType: "space",
      parentId: spaceId,
    });
    const foreignBlueprintId = await t.run(async (ctx) => {
      return await ctx.db.insert("taskBlueprints", {
        scopeType: "user",
        scopeId: "someone_else",
        name: "Foreign SOP",
        title: "Should not run",
        checklist: [],
        createdByActorId: "someone_else",
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentApi.createScheduledTask, {
        apiKey: "cua_hourly_operator",
        listId,
        title: "invalid",
        cadence: "hourly",
        blueprintId: foreignBlueprintId,
      }),
    ).rejects.toThrow(/blueprint not found/i);
    const scheduledTaskId = await t.mutation(
      api.agentApi.createScheduledTask,
      {
        apiKey: "cua_hourly_operator",
        listId,
        title: "fallback title",
        assigneeIds: [agentId],
        cadence: "hourly",
        blueprintId,
      },
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(scheduledTaskId, { nextRunAt: Date.now() - 1 });
    });

    await t.mutation(internal.scheduledTasks.materializeDue, {});

    const tasks = await t.withIdentity(OWNER).query(api.tasks.listForList, {
      listId,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Inspect agent health",
      assigneeClerkIds: [agentId],
      description: "Verify presence, wake consumption, and stalled work.",
      priority: "high",
      estimatePoints: 1,
      requiresApproval: true,
    });
    expect(tasks[0].checklist?.map((item) => item.text)).toEqual([
      "Review presence",
      "Review unconsumed wakes",
      "Escalate stale work",
    ]);
    expect(
      await t.query(api.agentApi.listWakeInbox, {
        apiKey: "cua_hourly_operator",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "task.assigned",
        taskId: tasks[0]._id,
        pushStatus: "poll_required",
      }),
    ]);
    const schedule = await t.run(async (ctx) =>
      ctx.db.get(scheduledTaskId),
    );
    expect(schedule?.lastRunAt).toEqual(expect.any(Number));
    expect(schedule!.nextRunAt).toBeGreaterThan(schedule!.lastRunAt!);
  });
});
