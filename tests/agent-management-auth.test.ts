import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "agent_owner" };
const ADMIN = { subject: "agent_admin" };
const MEMBER = { subject: "agent_member" };
const OUTSIDER = { subject: "agent_outsider" };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Agent Security",
      slug: "agent-security",
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
    const agentId = await ctx.db.insert("agents", {
      name: "Workspace Scout",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      notifySecret: "must-never-leave-the-server",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    const rawKey = "cua_workspace_security";
    const keyId = await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return { workspaceId, agentId, keyId };
  });
  return {
    t,
    owner: t.withIdentity(OWNER),
    admin: t.withIdentity(ADMIN),
    member: t.withIdentity(MEMBER),
    outsider: t.withIdentity(OUTSIDER),
    ...ids,
  };
}

describe("workspace agent management authorization", () => {
  it("lets members observe the fleet without exposing secrets or controls", async () => {
    const { member, outsider, agentId } = await setup();

    const fleet = await member.query(api.agents.listForCurrentUser, {});
    expect(fleet?.workspaces[0]).toMatchObject({
      canManageAgents: false,
      agents: [{ _id: agentId, name: "Workspace Scout" }],
    });
    expect(fleet?.workspaces[0]?.agents[0]).not.toHaveProperty("notifySecret");

    const detail = await member.query(api.agents.detail, { agentId });
    expect(detail).toMatchObject({
      canManage: false,
      hasNotifySecret: true,
      agent: { _id: agentId, name: "Workspace Scout" },
    });
    expect(detail?.agent).not.toHaveProperty("notifySecret");
    expect(await member.query(api.agents.stats, { agentId })).not.toBeNull();
    expect(await member.query(api.agents.listKeys, { agentId })).toEqual([]);

    expect(await outsider.query(api.agents.detail, { agentId })).toBeNull();
  });

  it("blocks members from persistent workspace-agent administration", async () => {
    const { member, workspaceId, agentId, keyId } = await setup();

    await expect(
      member.mutation(api.agents.create, {
        name: "Unauthorized",
        parentType: "workspace",
        parentId: workspaceId,
      }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.agentTemplates.createFromTemplate, {
        slug: "triage",
        parentType: "workspace",
        parentId: workspaceId,
      }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.action(api.agentKeys.createKey, { agentId }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.agents.update, {
        agentId,
        status: "paused",
      }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.agents.revokeKey, { keyId }),
    ).rejects.toThrow(/only workspace owners and admins/i);
    await expect(
      member.mutation(api.agents.remove, { agentId }),
    ).rejects.toThrow(/only workspace owners and admins/i);
  });

  it("allows owners and admins to manage workspace agents", async () => {
    const { owner, admin, workspaceId, agentId, keyId } = await setup();

    const createdId = await admin.mutation(api.agents.create, {
      name: "Admin-created",
      parentType: "workspace",
      parentId: workspaceId,
    });
    await admin.mutation(api.agents.update, {
      agentId: createdId,
      role: "readonly",
    });
    const created = await admin.query(api.agents.detail, {
      agentId: createdId,
    });
    expect(created).toMatchObject({
      canManage: true,
      agent: { role: "readonly" },
    });

    const minted = await owner.action(api.agentKeys.createKey, { agentId });
    expect(minted.key).toMatch(/^cua_[a-f0-9]{48}$/);
    expect(await owner.query(api.agents.listKeys, { agentId })).toHaveLength(2);
    await owner.mutation(api.agents.revokeKey, { keyId });
    const keys = await owner.query(api.agents.listKeys, { agentId });
    expect(keys.find((key) => key._id === keyId)?.revokedAt).toBeTypeOf(
      "number",
    );
  });
});
