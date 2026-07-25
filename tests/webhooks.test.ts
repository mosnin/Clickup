import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "user_webhook_owner", email: "hooks@example.com" };
const ADMIN = { subject: "user_webhook_admin" };
const MEMBER = { subject: "user_webhook_member" };

async function seedSubscription(t: ReturnType<typeof convexTest>) {
  const owner = t.withIdentity(OWNER);
  const created = await owner.mutation(api.webhooks.create, {
    scopeType: "user",
    scopeId: OWNER.subject,
    url: "https://hooks.example.com/operate",
    eventTypes: ["task.created"],
    secret: "whsec_test",
  });
  return { owner, subscriptionId: created.subscriptionId };
}

async function addDelivery(
  t: ReturnType<typeof convexTest>,
  subscriptionId: Id<"webhookSubscriptions">,
) {
  return await t.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      scopeType: "user",
      scopeId: OWNER.subject,
      type: "task.created",
      actorType: "user",
      actorId: OWNER.subject,
      actorName: "Webhook owner",
      entityType: "task",
      entityId: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    return await ctx.db.insert("webhookDeliveries", {
      subscriptionId,
      eventId,
      eventType: "task.created",
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
  });
}

describe("webhooks", () => {
  it("rejects unsafe destinations and never exposes stored secrets", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(OWNER);

    await expect(
      owner.mutation(api.webhooks.create, {
        scopeType: "user",
        scopeId: OWNER.subject,
        url: "http://hooks.example.com/operate",
        eventTypes: [],
      }),
    ).rejects.toThrow(/https/i);
    await expect(
      owner.mutation(api.webhooks.create, {
        scopeType: "user",
        scopeId: OWNER.subject,
        url: "https://127.0.0.1/operate",
        eventTypes: [],
      }),
    ).rejects.toThrow(/private address/i);

    const { subscriptionId } = await seedSubscription(t);
    const listed = await owner.query(api.webhooks.listForCurrentUser, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]._id).toBe(subscriptionId);
    expect(listed[0]).not.toHaveProperty("secret");
  });

  it("records a delivery result exactly once", async () => {
    const t = convexTest(schema, modules);
    const { subscriptionId } = await seedSubscription(t);
    const deliveryId = await addDelivery(t, subscriptionId);

    await t.mutation(internal.webhooks._recordResult, {
      deliveryId,
      ok: true,
      responseStatus: 204,
      final: true,
    });
    await t.mutation(internal.webhooks._recordResult, {
      deliveryId,
      ok: true,
      responseStatus: 204,
      final: true,
    });

    const { delivery, subscription } = await t.run(async (ctx) => ({
      delivery: await ctx.db.get(deliveryId),
      subscription: await ctx.db.get(subscriptionId),
    }));
    expect(delivery).toMatchObject({
      status: "success",
      attempts: 1,
      responseStatus: 204,
    });
    expect(subscription?.failureCount).toBe(0);
  });

  it("auto-disables after ten failed delivery chains and resets on recovery", async () => {
    const t = convexTest(schema, modules);
    const { owner, subscriptionId } = await seedSubscription(t);

    for (let index = 0; index < 10; index += 1) {
      const deliveryId = await addDelivery(t, subscriptionId);
      await t.mutation(internal.webhooks._recordResult, {
        deliveryId,
        ok: false,
        responseStatus: 500,
        error: "HTTP 500",
        final: true,
      });
    }

    let subscription = await t.run((ctx) => ctx.db.get(subscriptionId));
    expect(subscription).toMatchObject({
      enabled: false,
      failureCount: 10,
    });
    expect(subscription?.disabledAt).toEqual(expect.any(Number));

    await owner.mutation(api.webhooks.update, {
      subscriptionId,
      enabled: true,
    });
    subscription = await t.run((ctx) => ctx.db.get(subscriptionId));
    expect(subscription).toMatchObject({
      enabled: true,
      failureCount: 0,
    });
    expect(subscription?.disabledAt).toBeUndefined();
  });

  it("limits workspace event forwarding to owners and admins", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, subscriptionId } = await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        name: "Webhook Security",
        slug: "webhook-security",
        ownerClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      for (const [userClerkId, role] of [
        [OWNER.subject, "owner"],
        [ADMIN.subject, "admin"],
        [MEMBER.subject, "member"],
      ] as const) {
        await ctx.db.insert("memberships", {
          workspaceId,
          userClerkId,
          role,
          joinedAt: Date.now(),
        });
      }
      const subscriptionId = await ctx.db.insert("webhookSubscriptions", {
        scopeType: "workspace",
        scopeId: workspaceId,
        url: "https://hooks.example.com/workspace",
        secret: "whsec_workspace",
        eventTypes: [],
        ownerType: "user",
        ownerId: OWNER.subject,
        enabled: true,
        failureCount: 0,
        createdAt: Date.now(),
      });
      return { workspaceId, subscriptionId };
    });
    const owner = t.withIdentity(OWNER);
    const admin = t.withIdentity(ADMIN);
    const member = t.withIdentity(MEMBER);

    const ownerVisible = await owner.query(api.webhooks.listForCurrentUser, {});
    expect(ownerVisible).toHaveLength(1);
    expect(ownerVisible[0]).not.toHaveProperty("secret");
    expect(await admin.query(api.webhooks.listForCurrentUser, {})).toHaveLength(
      1,
    );
    expect(await member.query(api.webhooks.listForCurrentUser, {})).toEqual([]);

    await expect(
      member.mutation(api.webhooks.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        url: "https://attacker.example.com/exfiltrate",
        eventTypes: [],
      }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.webhooks.update, {
        subscriptionId,
        enabled: false,
      }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.webhooks.remove, { subscriptionId }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    expect(
      await member.query(api.webhooks.recentDeliveries, { subscriptionId }),
    ).toEqual([]);

    await admin.mutation(api.webhooks.update, {
      subscriptionId,
      enabled: false,
    });
    const updated = await t.run((ctx) => ctx.db.get(subscriptionId));
    expect(updated?.enabled).toBe(false);
  });
});
