import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Governance that only wrapped get_task / claim_task left agents able to
// comment on, be assigned to, and be woken about lists they cannot touch.
// These tests close that execution hole.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);

  const ids = await t.run(async (ctx) => {
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Allowed",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const otherList = await ctx.db.insert("lists", {
      name: "Off limits",
      parentType: "space",
      parentId: spaceId,
      position: 1,
      createdAt: Date.now(),
    });
    for (const id of [listId, otherList]) {
      await ctx.db.insert("listStatuses", {
        listId: id,
        name: "To Do",
        color: "#aaa",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
    }
    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_scout";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { spaceId, listId, otherList, agentId, apiKey };
  });

  return { t, alice, ...ids };
}

async function seedAgent(
  t: ReturnType<typeof convexTest>,
  name: string,
  apiKey: string,
  opts: {
    allowedListIds?: Id<"lists">[];
    role?: "member" | "readonly";
  } = {},
) {
  return await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", {
      name,
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
      allowedListIds: opts.allowedListIds,
      role: opts.role,
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return agentId;
  });
}

describe("list-restricted comments", () => {
  it("refuses comment read/write on a fenced list the way get_task already does", async () => {
    const { t, alice, listId, otherList, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });

    const allowedTask = await alice.mutation(api.tasks.create, {
      listId,
      title: "In bounds",
    });
    const fencedTask = await alice.mutation(api.tasks.create, {
      listId: otherList,
      title: "Secret plan",
    });

    await expect(
      t.query(api.agentApi.getTask, { apiKey, taskId: fencedTask }),
    ).rejects.toThrow(/not allowed/);

    await expect(
      t.query(api.agentApi.listComments, {
        apiKey,
        parentType: "task",
        parentId: fencedTask,
      }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      t.mutation(api.agentApi.addComment, {
        apiKey,
        parentType: "task",
        parentId: fencedTask,
        body: "should not land",
      }),
    ).rejects.toThrow(/not allowed/);

    const messageId = await t.mutation(api.agentApi.addComment, {
      apiKey,
      parentType: "task",
      parentId: allowedTask,
      body: "in bounds",
    });
    expect(messageId).toBeTruthy();
  });
});

describe("assignee fences", () => {
  it("refuses to assign or hand off a task to an agent fenced out of its list", async () => {
    const { t, alice, listId, otherList, apiKey } = await setup();
    const fencedId = await seedAgent(t, "Fenced", "cua_test_key_fenced", {
      allowedListIds: [listId],
    });

    const offLimits = await alice.mutation(api.tasks.create, {
      listId: otherList,
      title: "Not for Fenced",
    });

    await expect(
      alice.mutation(api.tasks.update, {
        taskId: offLimits,
        assigneeClerkIds: [fencedId],
      }),
    ).rejects.toThrow(/not allowed to work on this list/);

    await expect(
      t.mutation(api.agentApi.handoffTask, {
        apiKey,
        taskId: offLimits,
        toId: fencedId,
        note: "please take this",
      }),
    ).rejects.toThrow(/not allowed to work on this list/);
  });

  it("refuses to assign or hand off work to a readonly agent", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const readerId = await seedAgent(t, "Reader", "cua_test_key_reader", {
      role: "readonly",
    });

    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Needs a writer",
    });

    await expect(
      alice.mutation(api.tasks.update, {
        taskId,
        assigneeClerkIds: [readerId],
      }),
    ).rejects.toThrow(/read-only/);

    await expect(
      t.mutation(api.agentApi.handoffTask, {
        apiKey,
        taskId,
        toId: readerId,
        note: "you cannot do this",
      }),
    ).rejects.toThrow(/read-only/);
  });
});

describe("inbox fences", () => {
  it("hides mentions and wake pings for tasks on lists the agent cannot touch", async () => {
    const { t, alice, listId, otherList, agentId, apiKey } = await setup();
    await alice.mutation(api.agents.update, {
      agentId,
      allowedListIds: [listId],
    });

    const allowedTask = await alice.mutation(api.tasks.create, {
      listId,
      title: "Visible",
    });
    const fencedTask = await alice.mutation(api.tasks.create, {
      listId: otherList,
      title: "Hidden",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("mentions", {
        mentionedClerkId: agentId,
        parentType: "task",
        parentId: allowedTask,
        snippet: "please look at Visible",
        byName: "Alice",
        createdAt: Date.now(),
      });
      await ctx.db.insert("mentions", {
        mentionedClerkId: agentId,
        parentType: "task",
        parentId: fencedTask,
        snippet: "classified body",
        byName: "Alice",
        createdAt: Date.now() + 1,
      });
      await ctx.db.insert("agentPingDeliveries", {
        agentId,
        taskId: allowedTask,
        type: "task.assigned",
        payload: { title: "Visible" },
        status: "poll_required",
        attempts: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentPingDeliveries", {
        agentId,
        taskId: fencedTask,
        type: "task.assigned",
        payload: { title: "Hidden secret" },
        status: "poll_required",
        attempts: 0,
        createdAt: Date.now() + 1,
      });
    });

    const mentions = await t.query(api.agentApi.listMyMentions, { apiKey });
    expect(mentions.map((m) => m.parentId)).toEqual([allowedTask]);
    expect(mentions.some((m) => m.body.includes("classified"))).toBe(false);

    const inbox = await t.query(api.agentApi.listWakeInbox, { apiKey });
    expect(inbox.map((d) => d.taskId)).toEqual([allowedTask]);
    expect(
      inbox.some((d) => JSON.stringify(d.payload).includes("Hidden secret")),
    ).toBe(false);
  });
});
