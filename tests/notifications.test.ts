import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

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
