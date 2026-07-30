import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Presence on every surface, for both kinds of principal.
//
// The interesting properties are not "does a dot appear". They are:
//
//  1. **An agent is present the same way a person is** — same table, same rail,
//     distinguishable by actorType. That is the whole point: a machine whose work
//     is only visible on a dashboard about machines is an automation, not a
//     colleague.
//  2. **Presence is access-checked on both sides.** "Who is here" would otherwise
//     be the one query that hands over the names of people in a space you can't
//     see, and an agent fenced out of a list must not be able to appear on it.
//  3. **It expires.** A row nobody clears is a person who never left, and a rail
//     that lies about who is looking is worse than no rail.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, BOB, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [who, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: who,
        workspaceId: id,
        role,
        joinedAt: Date.now(),
      });
    }
    return id;
  });

  const alice = t.withIdentity(ALICE);
  const spaceId = await alice.mutation(api.spaces.create, {
    name: "HQ",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const listId = await alice.mutation(api.lists.create, {
    parentType: "space",
    parentId: spaceId,
    name: "Backlog",
  });
  const taskId = await alice.mutation(api.tasks.create, {
    listId,
    title: "Ship it",
  });

  return { t, workspaceId, spaceId, listId, taskId };
}

/** An agent in the workspace, plus a usable API key. */
async function seedAgent(
  t: Awaited<ReturnType<typeof seed>>["t"],
  workspaceId: Id<"workspaces">,
  opts: { allowedListIds?: Id<"lists">[] } = {},
) {
  const key = "cua_test_key_presence";
  const agentId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("agents", {
      name: "Ada",
      parentType: "workspace",
      parentId: workspaceId,
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
      status: "active",
      role: "member",
      dailyActionLimit: 2000,
      allowedListIds: opts.allowedListIds,
    });
    await ctx.db.insert("agentKeys", {
      agentId: id,
      keyHash: sha256Hex(key),
      keyPrefix: key.slice(0, 12),
      createdAt: Date.now(),
    });
    return id;
  });
  return { agentId, key };
}

describe("people on a surface", () => {
  it("shows everyone but you", async () => {
    const { t, taskId } = await seed();
    await t.withIdentity(ALICE).mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      name: "Alice",
      editing: false,
    });
    await t.withIdentity(BOB).mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      name: "Bob",
      editing: true,
    });

    // A rail that includes you reads as "someone else is here" at a glance,
    // which is the one thing it exists to say.
    const forAlice = await t
      .withIdentity(ALICE)
      .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId });
    expect(forAlice.map((v) => v.name)).toEqual(["Bob"]);
    expect(forAlice[0].editing).toBe(true);
    expect(forAlice[0].actorType).toBe("user");
  });

  it("empties your seat when you leave, without waiting out the window", async () => {
    const { t, taskId } = await seed();
    const bob = t.withIdentity(BOB);
    await bob.mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      name: "Bob",
      editing: false,
    });
    await bob.mutation(api.presence.leave, {
      surfaceType: "task",
      surfaceId: taskId,
    });
    expect(
      await t
        .withIdentity(ALICE)
        .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId }),
    ).toEqual([]);
  });

  it("forgets a row that has gone stale", async () => {
    const { t, taskId } = await seed();
    await t.withIdentity(BOB).mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      name: "Bob",
      editing: false,
    });
    // Age the row past the window. A row nobody clears is a person who never
    // left, and a rail that lies is worse than no rail.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("presence").collect();
      for (const r of rows) {
        await ctx.db.patch(r._id, { updatedAt: Date.now() - 120_000 });
      }
    });
    expect(
      await t
        .withIdentity(ALICE)
        .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId }),
    ).toEqual([]);
  });

  it("refuses to say who is on a surface you can't see", async () => {
    const { t, taskId, spaceId } = await seed();
    await t.withIdentity(BOB).mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      name: "Bob",
      editing: false,
    });
    const outsider = t.withIdentity(OUTSIDER);
    // The leak that matters: the names of people in a workspace you're not in.
    expect(
      await outsider.query(api.presence.viewers, {
        surfaceType: "task",
        surfaceId: taskId,
      }),
    ).toEqual([]);
    await expect(
      outsider.mutation(api.presence.heartbeat, {
        surfaceType: "space",
        surfaceId: spaceId,
        name: "Nobody",
        editing: false,
      }),
    ).rejects.toThrow();
  });

  it("works on every surface a person can stand on", async () => {
    const { t, spaceId, listId, taskId } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "workspace",
      scopeId: (await alice.query(api.spaces.get, { spaceId }))!.parentId,
      title: "Runbook",
      markdown: "body",
    });
    for (const [surfaceType, surfaceId] of [
      ["space", spaceId],
      ["list", listId],
      ["task", taskId],
      ["page", pageId],
    ] as const) {
      await t.withIdentity(BOB).mutation(api.presence.heartbeat, {
        surfaceType,
        surfaceId,
        name: "Bob",
        editing: false,
      });
      const seen = await alice.query(api.presence.viewers, {
        surfaceType,
        surfaceId,
      });
      expect(seen.map((v) => v.name)).toEqual(["Bob"]);
    }
  });
});

describe("agents on a surface", () => {
  it("stands in the same rail as a person, marked as a machine", async () => {
    const { t, workspaceId, taskId } = await seed();
    const { key } = await seedAgent(t, workspaceId);

    await t.mutation(api.agentApi.setFocus, {
      apiKey: key,
      surfaceType: "task",
      surfaceId: taskId,
      detail: "reading the migration runbook",
    });
    await t.withIdentity(BOB).mutation(api.presence.heartbeat, {
      surfaceType: "task",
      surfaceId: taskId,
      // Deliberately sorts BEFORE "Ada" alphabetically, so only the
      // agents-first rule can produce the order asserted below.
      name: "Aaron",
      editing: false,
    });

    const seen = await t
      .withIdentity(ALICE)
      .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId });
    // Agents sort first: a machine at work is the news on the surface.
    expect(seen.map((v) => v.actorType)).toEqual(["agent", "user"]);
    expect(seen.map((v) => v.name)).toEqual(["Ada", "Aaron"]);
    expect(seen[0].name).toBe("Ada");
    // Its own words, which is the difference between "an agent is here" and
    // knowing what it is doing.
    expect(seen[0].detail).toBe("reading the migration runbook");
  });

  it("appears by claiming a task, without being asked to announce itself", async () => {
    const { t, workspaceId, taskId } = await seed();
    const { key } = await seedAgent(t, workspaceId);
    await t.mutation(api.agentApi.claimTask, { apiKey: key, taskId });

    const seen = await t
      .withIdentity(ALICE)
      .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId });
    expect(seen).toHaveLength(1);
    expect(seen[0].actorType).toBe("agent");
    // Claiming is "I am working on this", so it draws a caret rather than a dot.
    expect(seen[0].editing).toBe(true);
  });

  it("leaves when it releases the task", async () => {
    const { t, workspaceId, taskId } = await seed();
    const { key } = await seedAgent(t, workspaceId);
    await t.mutation(api.agentApi.claimTask, { apiKey: key, taskId });
    await t.mutation(api.agentApi.releaseTask, { apiKey: key, taskId });
    // Putting something down should empty the seat now, not in 45 seconds.
    expect(
      await t
        .withIdentity(ALICE)
        .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId }),
    ).toEqual([]);
  });

  it("can put a surface down explicitly", async () => {
    const { t, workspaceId, taskId } = await seed();
    const { key } = await seedAgent(t, workspaceId);
    await t.mutation(api.agentApi.setFocus, {
      apiKey: key,
      surfaceType: "task",
      surfaceId: taskId,
    });
    const left = await t.mutation(api.agentApi.setFocus, {
      apiKey: key,
      surfaceType: "task",
      surfaceId: taskId,
      leaving: true,
    });
    expect(left.present).toBe(false);
    expect(
      await t
        .withIdentity(ALICE)
        .query(api.presence.viewers, { surfaceType: "task", surfaceId: taskId }),
    ).toEqual([]);
  });

  it("cannot appear on a list it was fenced out of", async () => {
    // Presence is visible to the whole team, so a machine showing up where it
    // was governed away from is a leak even though it changes nothing.
    const { t, workspaceId, listId, taskId } = await seed();
    const other = await t.withIdentity(ALICE).mutation(api.lists.create, {
      parentType: "space",
      parentId: (await t.run(async (ctx) => (await ctx.db.get(listId))!.parentId)) as Id<"spaces">,
      name: "Off limits",
    });
    const { key } = await seedAgent(t, workspaceId, { allowedListIds: [other] });

    await expect(
      t.mutation(api.agentApi.setFocus, {
        apiKey: key,
        surfaceType: "list",
        surfaceId: listId,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.agentApi.setFocus, {
        apiKey: key,
        surfaceType: "task",
        surfaceId: taskId,
      }),
    ).rejects.toThrow();
  });

  it("cannot appear on a page outside its scope", async () => {
    const { t, workspaceId } = await seed();
    const { key } = await seedAgent(t, workspaceId);
    // A page belonging to Alice personally, not to the workspace the agent is in.
    const personalPage = await t
      .withIdentity(ALICE)
      .mutation(api.pages.create, {
        scopeType: "user",
        scopeId: ALICE.subject,
        title: "Private",
        markdown: "mine",
      });
    await expect(
      t.mutation(api.agentApi.setFocus, {
        apiKey: key,
        surfaceType: "page",
        surfaceId: personalPage,
      }),
    ).rejects.toThrow();
  });

  it("says nothing about where an agent is working if you can't see the surface", async () => {
    const { t, workspaceId, taskId } = await seed();
    const { agentId, key } = await seedAgent(t, workspaceId);
    await t.mutation(api.agentApi.setFocus, {
      apiKey: key,
      surfaceType: "task",
      surfaceId: taskId,
    });
    expect(
      await t
        .withIdentity(ALICE)
        .query(api.presence.forActor, { actorId: agentId }),
    ).toHaveLength(1);
    // Same query, someone outside the workspace: an agent's whereabouts are as
    // confidential as the surface it is on.
    expect(
      await t
        .withIdentity(OUTSIDER)
        .query(api.presence.forActor, { actorId: agentId }),
    ).toEqual([]);
  });
});

describe("cleanup", () => {
  it("takes a page's presence with the page", async () => {
    const { t } = await seed();
    const alice = t.withIdentity(ALICE);
    const pageId = await alice.mutation(api.pages.create, {
      scopeType: "user",
      scopeId: ALICE.subject,
      title: "Notes",
      markdown: "x",
    });
    await alice.mutation(api.presence.heartbeat, {
      surfaceType: "page",
      surfaceId: pageId,
      name: "Alice",
      editing: false,
    });
    await alice.mutation(api.pages.remove, { pageId });
    const left = await t.run(async (ctx) =>
      ctx.db.query("presence").collect(),
    );
    expect(left).toEqual([]);
  });
});
