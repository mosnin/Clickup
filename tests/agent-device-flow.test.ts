import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  DEVICE_KEY_TTL_MS,
  MAX_LIVE_DEVICE_KEYS,
  isWellFormedUserCode,
  normalizeUserCode,
} from "../convex/agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "device_owner" };
const MEMBER = { subject: "device_member" };
const OUTSIDER = { subject: "device_outsider" };

const DEVICE_CODE = "opd_test_device_code_0001";
const USER_CODE = "WXYA-3479";

// The route mints the key and passes only its hash, so tests do the same.
const KEY = "cua_minted_by_the_route";
const KEY_MATERIAL = { keyHash: sha256Hex(KEY), keyPrefix: KEY.slice(0, 12) };

async function setup() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      name: "Device Flow",
      slug: "device-flow",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    for (const [userClerkId, role] of [
      [OWNER.subject, "owner"],
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
  return { t, workspaceId };
}

async function startRequest(
  t: Awaited<ReturnType<typeof setup>>["t"],
  overrides: Partial<{ deviceCode: string; userCode: string }> = {},
) {
  return await t.mutation(api.agentAuth.createDeviceRequest, {
    deviceCode: overrides.deviceCode ?? DEVICE_CODE,
    userCode: overrides.userCode ?? USER_CODE,
    clientName: "claude-code",
  });
}

describe("user codes", () => {
  it("accepts only the unambiguous alphabet", () => {
    expect(isWellFormedUserCode("WXYA-3479")).toBe(true);
    // 0/O, 1/I/L, 2/Z, 5/S, 8/B are excluded precisely because a human
    // reads this off one screen and types it into another.
    expect(isWellFormedUserCode("WXY0-3479")).toBe(false);
    expect(isWellFormedUserCode("WXYA3479")).toBe(false);
    expect(isWellFormedUserCode("wxya-3479")).toBe(false);
  });

  it("repairs the shapes a person actually types", () => {
    for (const typed of ["wxya-3479", " WXYA3479 ", "wxya 3479", "WXYA-3479"]) {
      expect(normalizeUserCode(typed)).toBe("WXYA-3479");
    }
  });
});

describe("device authorization", () => {
  it("issues a key only after a human approves, and only once", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);

    // Before approval the poller is told to wait, and gets no key.
    const pending = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(pending.state).toBe("pending");
    expect(pending.agentId).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("agentKeys").collect()))
      .toHaveLength(0);

    const asOwner = t.withIdentity(OWNER);
    const approved = await asOwner.mutation(api.agentAuth.approveDeviceRequest, {
      userCode: USER_CODE,
      parentType: "workspace",
      parentId: workspaceId,
      agentName: "Scout",
      role: "member",
      dailyActionLimit: 200,
    });
    expect(approved.agentCreated).toBe(true);

    const claimed = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(claimed.state).toBe("approved");
    expect(claimed.agentName).toBe("Scout");
    expect(claimed.scopeName).toBe("Device Flow");
    expect(claimed.expiresIn).toBe(DEVICE_KEY_TTL_MS / 1000);

    // The key exists and only its hash was ever stored.
    const keys = await t.run(async (ctx) => ctx.db.query("agentKeys").collect());
    expect(keys).toHaveLength(1);
    expect(keys[0].keyHash).toBe(sha256Hex(KEY));
    expect(keys[0].source).toBe("device");
    expect(keys[0].expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(keys[0])).not.toContain(KEY);

    // Replaying the device code is invalid_grant, not a second key.
    const replay = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(replay.state).toBe("claimed");
    expect(
      await t.run(async (ctx) => ctx.db.query("agentKeys").collect()),
    ).toHaveLength(1);
  });

  it("writes the consented governance onto the agent in the same breath", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    const asOwner = t.withIdentity(OWNER);
    const outcome = await asOwner.mutation(
      api.agentAuth.approveDeviceRequest,
      {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: workspaceId,
        agentName: "Reader",
        role: "readonly",
        dailyActionLimit: 200,
      },
    );
    if (!outcome.approved) throw new Error("approval was refused");

    // The whole argument for approving-then-minting rather than
    // minting-then-governing: there is no window in which this key exists
    // with broader powers than the human agreed to.
    const agent = await t.run(async (ctx) => ctx.db.get(outcome.agentId));
    expect(agent?.role).toBe("readonly");
    expect(agent?.dailyActionLimit).toBe(200);
  });

  it("narrows an existing agent rather than silently widening it", async () => {
    const { t, workspaceId } = await setup();
    const agentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", {
        name: "Veteran",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        role: "member",
        dailyActionLimit: 20000,
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      }),
    );
    await startRequest(t);
    const asOwner = t.withIdentity(OWNER);
    await asOwner.mutation(api.agentAuth.approveDeviceRequest, {
      userCode: USER_CODE,
      agentId,
      role: "readonly",
      dailyActionLimit: 200,
    });
    const agent = await t.run(async (ctx) => ctx.db.get(agentId));
    expect(agent?.role).toBe("readonly");
    expect(agent?.dailyActionLimit).toBe(200);
  });

  it("refuses approval from someone who cannot manage the scope", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    // A plain member can see the workspace but cannot mint a credential in
    // it — connecting an agent must not be the softer path to a key.
    await expect(
      t.withIdentity(MEMBER).mutation(api.agentAuth.approveDeviceRequest, {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: workspaceId,
        agentName: "Sneak",
        role: "member",
      }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.agentAuth.approveDeviceRequest, {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: workspaceId,
        agentName: "Sneak",
        role: "member",
      }),
    ).rejects.toThrow();
    expect(
      await t.run(async (ctx) => ctx.db.query("agentKeys").collect()),
    ).toHaveLength(0);
  });

  it("refuses to approve into a workspace the approver cannot even see", async () => {
    const { t } = await setup();
    const otherWorkspace = await t.run(async (ctx) =>
      ctx.db.insert("workspaces", {
        name: "Somebody Else",
        slug: "somebody-else",
        ownerClerkId: OUTSIDER.subject,
        createdAt: Date.now(),
      }),
    );
    await startRequest(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.agentAuth.approveDeviceRequest, {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: otherWorkspace,
        agentName: "Trespasser",
        role: "member",
      }),
    ).rejects.toThrow();
  });

  it("expires, and an expired code cannot be approved or claimed", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("agentAuthRequests").first();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    const claimed = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(claimed.state).toBe("expired");
    // Returned rather than thrown: this path counts against the caller's
    // guess budget, and a throw would roll that increment back.
    const late = await t
      .withIdentity(OWNER)
      .mutation(api.agentAuth.approveDeviceRequest, {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: workspaceId,
        agentName: "Late",
        role: "member",
      });
    expect(late).toMatchObject({ approved: false });
    expect(
      await t.run(async (ctx) => ctx.db.query("agentKeys").collect()),
    ).toHaveLength(0);
  });

  it("answers an unknown device code the same way as an expired one", async () => {
    const { t } = await setup();
    // Distinguishing the two would let somebody probe for live codes.
    const unknown = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: "opd_never_issued",
      ...KEY_MATERIAL,
    });
    expect(unknown.state).toBe("not_found");
  });

  it("declines cleanly, and a declined request never yields a key", async () => {
    const { t } = await setup();
    await startRequest(t);
    await t.withIdentity(OWNER).mutation(api.agentAuth.denyDeviceRequest, {
      userCode: USER_CODE,
    });
    const claimed = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(claimed.state).toBe("denied");
    expect(
      await t.run(async (ctx) => ctx.db.query("agentKeys").collect()),
    ).toHaveLength(0);
  });

  it("slows down a poller that ignores the interval", async () => {
    const { t } = await setup();
    const { interval } = await startRequest(t);
    // First poll establishes the clock; the immediate second one is early.
    await t.mutation(api.agentAuth.claimDeviceRequest, { deviceCode: DEVICE_CODE });
    const hasty = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
    });
    expect(hasty.slowDown).toBe(true);
    // slow_down is not advice: the interval it must now respect has grown.
    expect(hasty.interval).toBeGreaterThan(interval);
  });

  it("refuses a live user-code collision", async () => {
    const { t } = await setup();
    await startRequest(t);
    // Two agents holding one code means one human's approval reaches the
    // wrong runtime. The route retries with a fresh code instead.
    await expect(
      startRequest(t, { deviceCode: "opd_second_agent" }),
    ).rejects.toThrow(/collision/i);
  });

  it("does not issue a key for an agent paused between approval and collection", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    const asOwner = t.withIdentity(OWNER);
    const outcome = await asOwner.mutation(
      api.agentAuth.approveDeviceRequest,
      {
        userCode: USER_CODE,
        parentType: "workspace",
        parentId: workspaceId,
        agentName: "Second Thoughts",
        role: "member",
      },
    );
    if (!outcome.approved) throw new Error("approval was refused");
    await t.run(async (ctx) =>
      ctx.db.patch(outcome.agentId, { status: "paused" }),
    );

    const claimed = await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    expect(claimed.state).toBe("denied");
    expect(
      await t.run(async (ctx) => ctx.db.query("agentKeys").collect()),
    ).toHaveLength(0);
  });

  it("refuses a device-grant key after its 90-day lifetime", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    const asOwner = t.withIdentity(OWNER);
    await asOwner.mutation(api.agentAuth.approveDeviceRequest, {
      userCode: USER_CODE,
      parentType: "workspace",
      parentId: workspaceId,
      agentName: "Scout",
      role: "member",
    });
    await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    await expect(t.query(api.agentApi.whoami, { apiKey: KEY })).resolves.toMatchObject({
      name: "Scout",
    });
    await t.run(async (ctx) => {
      const key = await ctx.db.query("agentKeys").first();
      await ctx.db.patch(key!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(t.query(api.agentApi.whoami, { apiKey: KEY })).rejects.toThrow(
      /invalid api key/i,
    );
  });

  it("revokes the oldest live device key when a sixth is minted", async () => {
    const { t, workspaceId } = await setup();
    await startRequest(t);
    const asOwner = t.withIdentity(OWNER);
    const approved = await asOwner.mutation(api.agentAuth.approveDeviceRequest, {
      userCode: USER_CODE,
      parentType: "workspace",
      parentId: workspaceId,
      agentName: "Scout",
      role: "member",
    });
    if (!approved.approved) throw new Error("approval was refused");
    const humanKey = "cua_human_minted_stays";
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("agentKeys", {
        agentId: approved.agentId,
        keyHash: sha256Hex(humanKey),
        keyPrefix: humanKey.slice(0, 12),
        createdAt: now - 10_000,
        source: "human",
      });
      for (let index = 0; index < MAX_LIVE_DEVICE_KEYS; index += 1) {
        await ctx.db.insert("agentKeys", {
          agentId: approved.agentId,
          keyHash: sha256Hex(`cua_old_device_${index}`),
          keyPrefix: `cua_old_${index}`,
          createdAt: now - 1_000 + index,
          expiresAt: now + DEVICE_KEY_TTL_MS,
          source: "device",
        });
      }
    });
    await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: DEVICE_CODE,
      ...KEY_MATERIAL,
    });
    const keys = await t.run(async (ctx) => ctx.db.query("agentKeys").collect());
    const liveDevice = keys.filter(
      (key) => key.source === "device" && key.revokedAt === undefined,
    );
    expect(liveDevice).toHaveLength(MAX_LIVE_DEVICE_KEYS);
    expect(liveDevice.some((key) => key.keyHash === sha256Hex(KEY))).toBe(true);
    expect(
      keys.find((key) => key.keyHash === sha256Hex("cua_old_device_0"))?.revokedAt,
    ).toEqual(expect.any(Number));
    expect(
      keys.find((key) => key.keyHash === sha256Hex(humanKey))?.revokedAt,
    ).toBeUndefined();
    await expect(
      t.query(api.agentApi.whoami, { apiKey: humanKey }),
    ).resolves.toMatchObject({ name: "Scout" });
  });
});

describe("the consent screen's data", () => {
  it("shows only scopes and agents the approver actually has", async () => {
    const { t, workspaceId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        name: "Existing",
        parentType: "workspace",
        parentId: workspaceId,
        status: "active",
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
      // A paused agent is not a thing to reconnect to.
      await ctx.db.insert("agents", {
        name: "Paused",
        parentType: "workspace",
        parentId: workspaceId,
        status: "paused",
        createdByClerkId: OWNER.subject,
        createdAt: Date.now(),
      });
    });
    await startRequest(t);

    const view = await t
      .withIdentity(OWNER)
      .mutation(api.agentAuth.lookupUserCode, { userCode: "wxya3479" });
    expect(view.state).toBe("pending");
    if (view.state !== "pending") throw new Error("unreachable");
    expect(view.clientName).toBe("claude-code");
    expect(view.agents.map((a) => a.name)).toEqual(["Existing"]);
    expect(view.scopes.map((s) => s.name)).toContain("Device Flow");

    // An outsider typing the same code sees the request but none of the
    // owner's workspaces — only their own personal space.
    const outside = await t
      .withIdentity(OUTSIDER)
      .mutation(api.agentAuth.lookupUserCode, { userCode: USER_CODE });
    if (outside.state !== "pending") throw new Error("unreachable");
    expect(outside.scopes.map((s) => s.name)).toEqual(["Personal space"]);
    expect(outside.agents).toHaveLength(0);
  });

  it("marks a workspace the approver cannot manage as unmanageable", async () => {
    const { t } = await setup();
    await startRequest(t);
    const view = await t
      .withIdentity(MEMBER)
      .mutation(api.agentAuth.lookupUserCode, { userCode: USER_CODE });
    if (view.state !== "pending") throw new Error("unreachable");
    const workspace = view.scopes.find((s) => s.name === "Device Flow");
    expect(workspace?.canManage).toBe(false);
    // Their own personal space is always theirs to manage.
    expect(
      view.scopes.find((s) => s.parentType === "user")?.canManage,
    ).toBe(true);
  });
});
