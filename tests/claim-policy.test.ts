import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Claim-required lists.
//
// Advisory claims are right where people and agents share work; they are wrong
// for a queue several workers pull from concurrently, where two writers is the
// normal case rather than the unlucky one. The platform could not express the
// difference, so every list got the weaker rule.
//
// The tests that matter here are the ones about the ASYMMETRY. An agent is
// refused; a person writing to an unclaimed task takes the claim instead.
// Getting that backwards in either direction is the whole failure mode: refuse
// people and they lose what they typed to prevent a conflict that was not
// happening; auto-claim for agents and the policy protects nothing.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };

async function setup(claimPolicy?: "advisory" | "required") {
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
      name: "The queue",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      claimPolicy,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
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
    const otherAgentId = await ctx.db.insert("agents", {
      name: "Rival",
      parentType: "user",
      parentId: ALICE.subject,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const otherKey = "cua_test_key_rival";
    await ctx.db.insert("agentKeys", {
      agentId: otherAgentId,
      keyHash: sha256Hex(otherKey),
      keyPrefix: otherKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { listId, agentId, apiKey, otherAgentId, otherKey };
  });
  return { t, alice, ...ids };
}

describe("advisory is unchanged", () => {
  it("lets an agent write without claiming", async () => {
    const { t, alice, listId, apiKey } = await setup();
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Shared work",
    });
    // The default, and the behaviour every list had before this existed.
    // Personalisation that changes the product for somebody who never opted in
    // is a regression wearing a feature's clothes.
    await t.mutation(api.agentApi.updateTask, {
      apiKey,
      taskId,
      title: "Renamed by an agent",
    });
    expect((await alice.query(api.tasks.get, { taskId }))?.title).toBe(
      "Renamed by an agent",
    );
  });
});

describe("required, for an agent", () => {
  it("refuses a write with no claim, and says how to fix it", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Queue item",
    });
    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey,
        taskId,
        title: "Nope",
      }),
    ).rejects.toThrow(/claim/i);
  });

  it("allows the write once the claim is held", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Queue item",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });
    await t.mutation(api.agentApi.updateTask, {
      apiKey,
      taskId,
      title: "Mine",
    });
    expect((await alice.query(api.tasks.get, { taskId }))?.title).toBe("Mine");
  });

  it("refuses a second agent while the first holds it", async () => {
    const { t, alice, listId, apiKey, otherKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Contested",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });
    await expect(
      t.mutation(api.agentApi.updateTask, {
        apiKey: otherKey,
        taskId,
        title: "Mine now",
      }),
    ).rejects.toThrow(/holds it/i);
  });

  it("tells the agent the rule before it has to be refused by it", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Queue item",
    });
    // Learning the rule from an error costs a round trip and may cost the task
    // to whoever claimed it in the meantime.
    const view = await t.query(api.agentApi.getTask, { apiKey, taskId });
    expect(view.claimPolicy).toBe("required");
    const ctxView = await t.query(api.agentApi.getTaskContext, {
      apiKey,
      taskId,
    });
    expect(ctxView.claimPolicy).toBe("required");
  });
});

describe("required, for a person", () => {
  it("takes the claim rather than refusing the edit", async () => {
    const { alice, listId } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Queue item",
    });
    // Telling somebody "you may not edit this" loses what they typed, to
    // protect against a conflict that was not happening. Taking the claim
    // gives the same protection: the list's other workers are now locked out.
    await alice.mutation(api.tasks.update, { taskId, title: "Edited" });
    const task = await alice.query(api.tasks.get, { taskId });
    expect(task?.title).toBe("Edited");
    expect(task?.claimedByActorId).toBe(ALICE.subject);
  });

  it("locks agents out once a person has edited it", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Queue item",
    });
    await alice.mutation(api.tasks.update, { taskId, title: "Mine" });
    // The auto-claim is not a loophole — it is the protection, arriving by a
    // different route.
    await expect(
      t.mutation(api.agentApi.updateTask, { apiKey, taskId, title: "No" }),
    ).rejects.toThrow(/holds it/i);
  });

  it("still refuses a person when somebody else holds a fresh claim", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Contested",
    });
    await t.mutation(api.agentApi.claimTask, { apiKey, taskId });
    // Not a hypothetical conflict: another worker is on it right now, and that
    // is a refusal a person deserves to see.
    await expect(
      alice.mutation(api.tasks.update, { taskId, title: "Barge in" }),
    ).rejects.toThrow(/holds it/i);
    // Releasing it is the escape hatch, and it already existed.
    await alice.mutation(api.tasks.releaseClaim, { taskId });
    await alice.mutation(api.tasks.update, { taskId, title: "After release" });
    expect((await alice.query(api.tasks.get, { taskId }))?.title).toBe(
      "After release",
    );
  });
});

describe("the policy is governance, not a preference", () => {
  it("cannot be changed by an agent", async () => {
    const { t, alice, listId, apiKey } = await setup("required");
    // The same rule as the approval gate: an agent may raise a constraint on
    // itself and never lower one. A fleet that could turn this off would turn
    // it off the first time it was inconvenient.
    await expect(
      t.mutation(api.agentApi.updateListMeta, {
        apiKey,
        listId,
        // @ts-expect-error — the argument does not exist, which is the point.
        claimPolicy: "advisory",
      }),
    ).rejects.toThrow();
    const list = await alice.query(api.lists.get, { listId });
    expect(list?.claimPolicy).toBe("required");
  });

  it("can be changed by a person", async () => {
    const { alice, listId } = await setup("required");
    await alice.mutation(api.lists.updateMeta, {
      listId,
      claimPolicy: "advisory",
    });
    expect((await alice.query(api.lists.get, { listId }))?.claimPolicy).toBe(
      "advisory",
    );
  });

  it("does not stop the platform running its own rules", async () => {
    const { t, alice, listId } = await setup("required");
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Recurring",
    });
    // System actors — automations, recurrence, the watchdog — are not workers
    // competing for the task. Blocking them would mean a required-claim list
    // quietly stopped running its own automations.
    await t.run(async (ctx) => {
      const { updateTaskCore } = await import("../convex/tasks");
      await updateTaskCore(
        ctx,
        { taskId: taskId as Id<"tasks">, title: "Touched by the system" },
        { type: "system", id: "watchdog", name: "Watchdog" },
      );
    });
    expect((await alice.query(api.tasks.get, { taskId }))?.title).toBe(
      "Touched by the system",
    );
  });
});
