import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "integration_owner" };
const ADMIN = { subject: "integration_admin" };
const MEMBER = { subject: "integration_member" };

async function setup() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      name: "Integration Security",
      slug: "integration-security",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const [userClerkId, role] of [
      [OWNER.subject, "owner"],
      [ADMIN.subject, "admin"],
      [MEMBER.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        workspaceId: id,
        userClerkId,
        role,
        joinedAt: Date.now(),
      });
    }
    return id;
  });
  return {
    t,
    workspaceId,
    owner: t.withIdentity(OWNER),
    admin: t.withIdentity(ADMIN),
    member: t.withIdentity(MEMBER),
  };
}

describe("integration secret handling", () => {
  it("never returns Slack credentials and limits management to owners/admins", async () => {
    const { t, workspaceId, owner, admin, member } = await setup();
    const webhookUrl =
      "https://hooks.slack.com/services/T00000000/B00000000/secret-token";
    const integrationId = await owner.mutation(api.integrations.upsertSlack, {
      workspaceId,
      webhookUrl,
    });

    const ownerList = await owner.query(api.integrations.listForWorkspace, {
      workspaceId,
    });
    expect(ownerList).toMatchObject([
      {
        _id: integrationId,
        kind: "slack",
        enabled: true,
        configured: true,
      },
    ]);
    expect(ownerList[0]).not.toHaveProperty("config");
    expect(JSON.stringify(ownerList)).not.toContain(webhookUrl);
    expect(
      await admin.query(api.integrations.listForWorkspace, { workspaceId }),
    ).toHaveLength(1);
    expect(
      await member.query(api.integrations.listForWorkspace, { workspaceId }),
    ).toEqual([]);

    await expect(
      member.mutation(api.integrations.upsertSlack, {
        workspaceId,
        webhookUrl,
      }),
    ).rejects.toThrow(/owners or admins/i);
    await expect(
      member.mutation(api.integrations.setEnabled, {
        integrationId,
        enabled: false,
      }),
    ).rejects.toThrow(/owners or admins/i);
    await expect(
      member.mutation(api.integrations.remove, { integrationId }),
    ).rejects.toThrow(/owners or admins/i);

    await admin.mutation(api.integrations.setEnabled, {
      integrationId,
      enabled: false,
    });
    expect((await t.run((ctx) => ctx.db.get(integrationId)))?.enabled).toBe(
      false,
    );
  });
});
