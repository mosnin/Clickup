import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// In-app notification feed: assigning a task writes the assignee a
// notification row (skipping the actor), the unread badge counts it, and
// read state is per-recipient (a user can't mark someone else's as read).

const modules = import.meta.glob("../convex/**/*.*s");

const ASSIGNER = { subject: "user_assigner", email: "assigner@acme.com" };
const ASSIGNEE = { subject: "user_assignee", email: "assignee@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [ASSIGNER, ASSIGNEE, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ASSIGNER.subject,
      createdAt: Date.now(),
    });
    for (const u of [ASSIGNER, ASSIGNEE]) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userClerkId: u.subject,
        role: u === ASSIGNER ? "owner" : "member",
        joinedAt: Date.now(),
      });
    }
    return workspaceId;
  });
}

async function makeList(t: ReturnType<typeof convexTest>, workspaceId: any) {
  const spaceId = await t.withIdentity(ASSIGNER).mutation(api.spaces.create, {
    name: "Team space",
    parentType: "workspace",
    parentId: workspaceId,
  });
  return await t.withIdentity(ASSIGNER).mutation(api.lists.create, {
    name: "Work",
    parentType: "space",
    parentId: spaceId,
  });
}

describe("notifications", () => {
  it("durably delivers a signed wake when an agent is assigned", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const listId = await makeList(t, workspaceId);
    const agentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Builder",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        notifyUrl: "https://runtime.example.com/wake",
        notifySecret: "assignment-secret",
        createdByClerkId: ASSIGNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId: id,
        keyHash: sha256Hex("cua_assignment_test"),
        keyPrefix: "cua_assi",
        createdAt: Date.now(),
      });
      return id;
    });
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Ping-Signature")).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        type: "task.assigned",
        attempt: 1,
      });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
        listId,
        title: "Ship the agent runtime",
        assigneeClerkIds: [agentId],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }

    const delivery = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentPingDeliveries")
        .withIndex("by_agent", (q) => q.eq("agentId", agentId))
        .unique();
    });
    expect(delivery).toMatchObject({
      scopeType: "workspace",
      scopeId: workspaceId,
      workspaceId,
      sourceKind: "task_assignment",
      sourceId: delivery?.taskId,
      type: "task.assigned",
      status: "delivered",
      attempts: 1,
      responseStatus: 202,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const receipt = await t.mutation(
      api.agentApi.acknowledgeWakeDelivery,
      {
        apiKey: "cua_assignment_test",
        deliveryId: delivery!._id,
      },
    );
    expect(receipt).toMatchObject({
      deliveryId: delivery!._id,
      type: "task.assigned",
      deliveryStatus: "delivered",
    });
    const acknowledgedAt = receipt.acknowledgedAt;
    expect(acknowledgedAt).toEqual(expect.any(Number));
    expect(
      await t.run(async (ctx) => await ctx.db.get(delivery!._id)),
    ).toMatchObject({ acknowledgedAt });
    expect(
      await t.run(async (ctx) => await ctx.db.get(agentId)),
    ).toMatchObject({
      lastSeenAt: acknowledgedAt,
      lastConnectedAt: acknowledgedAt,
    });
    expect(
      await t.mutation(api.agentApi.acknowledgeWakeDelivery, {
        apiKey: "cua_assignment_test",
        deliveryId: delivery!._id,
      }),
    ).toMatchObject({ acknowledgedAt });

    await t.run(async (ctx) => {
      const otherAgentId = await ctx.db.insert("agents", {
        name: "Other agent",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: ASSIGNER.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId: otherAgentId,
        keyHash: sha256Hex("cua_other_agent"),
        keyPrefix: "cua_othe",
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentApi.acknowledgeWakeDelivery, {
        apiKey: "cua_other_agent",
        deliveryId: delivery!._id,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("durably delivers a signed wake when an agent is mentioned", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const agentId = await t.run(async (ctx) => {
      return await ctx.db.insert("agents", {
        name: "Researcher",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        notifyUrl: "https://runtime.example.com/mentions",
        notifySecret: "mention-secret",
        createdByClerkId: ASSIGNER.subject,
        createdAt: Date.now(),
      });
    });
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Ping-Signature")).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        type: "mention.created",
        attempt: 1,
        payload: {
          parentType: "workspace",
          parentId: workspaceId,
        },
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let messageId: Id<"messages"> | undefined;
    try {
      messageId = await t
        .withIdentity(ASSIGNER)
        .mutation(api.messages.create, {
          parentType: "workspace",
          parentId: workspaceId,
          body: "Please inspect the new delivery path.",
          mentionClerkIds: [agentId],
        });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }

    const delivery = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentPingDeliveries")
        .withIndex("by_agent", (q) => q.eq("agentId", agentId))
        .unique();
    });
    expect(delivery).toMatchObject({
      sourceKind: "mention",
      sourceId: messageId,
      messageId,
      type: "mention.created",
      status: "delivered",
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("assigning a user to a task writes them a notification and counts unread", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const listId = await makeList(t, workspaceId);

    await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
      listId,
      title: "Ship the thing",
      assigneeClerkIds: [ASSIGNEE.subject],
    });

    const feed = await t
      .withIdentity(ASSIGNEE)
      .query(api.notificationCenter.listForCurrent, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].type).toBe("assignment");
    expect(feed[0].readAt).toBeUndefined();

    const unread = await t
      .withIdentity(ASSIGNEE)
      .query(api.notificationCenter.unreadCount, {});
    expect(unread).toBe(1);

    // The actor themself gets no self-assignment notification.
    const assignerFeed = await t
      .withIdentity(ASSIGNER)
      .query(api.notificationCenter.listForCurrent, {});
    expect(assignerFeed).toHaveLength(0);
  });

  it("markRead clears a single notification", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const listId = await makeList(t, workspaceId);

    await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
      listId,
      title: "Ship the thing",
      assigneeClerkIds: [ASSIGNEE.subject],
    });
    const feed = await t
      .withIdentity(ASSIGNEE)
      .query(api.notificationCenter.listForCurrent, {});
    const notificationId = feed[0]._id;

    await t.withIdentity(ASSIGNEE).mutation(api.notificationCenter.markRead, {
      notificationId,
    });
    expect(
      await t
        .withIdentity(ASSIGNEE)
        .query(api.notificationCenter.unreadCount, {}),
    ).toBe(0);
  });

  it("markAllRead clears every unread notification for that user", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const listId = await makeList(t, workspaceId);

    await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
      listId,
      title: "Task one",
      assigneeClerkIds: [ASSIGNEE.subject],
    });
    await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
      listId,
      title: "Task two",
      assigneeClerkIds: [ASSIGNEE.subject],
    });
    expect(
      await t
        .withIdentity(ASSIGNEE)
        .query(api.notificationCenter.unreadCount, {}),
    ).toBe(2);

    await t
      .withIdentity(ASSIGNEE)
      .mutation(api.notificationCenter.markAllRead, {});
    expect(
      await t
        .withIdentity(ASSIGNEE)
        .query(api.notificationCenter.unreadCount, {}),
    ).toBe(0);
  });

  it("a user cannot mark another user's notification as read", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const listId = await makeList(t, workspaceId);

    await t.withIdentity(ASSIGNER).mutation(api.tasks.create, {
      listId,
      title: "Ship the thing",
      assigneeClerkIds: [ASSIGNEE.subject],
    });
    const feed = await t
      .withIdentity(ASSIGNEE)
      .query(api.notificationCenter.listForCurrent, {});
    const notificationId = feed[0]._id;

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.notificationCenter.markRead, {
        notificationId,
      }),
    ).rejects.toThrow(/not found/i);

    // Still unread for the real owner.
    expect(
      await t
        .withIdentity(ASSIGNEE)
        .query(api.notificationCenter.unreadCount, {}),
    ).toBe(1);
  });
});
