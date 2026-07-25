import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "oauth_owner", email: "owner@example.com" };
const OUTSIDER = { subject: "oauth_outsider", email: "other@example.com" };
const CLIENT_ID = "opc_test_client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256")
  .update(VERIFIER)
  .digest("base64url");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "OAuth QA",
      slug: "oauth-qa",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Plugin Agent",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    return { workspaceId, agentId };
  });
  await t.mutation(api.oauth.registerClient, {
    clientId: CLIENT_ID,
    clientName: "Claude",
    redirectUris: [REDIRECT_URI],
  });
  return {
    t,
    owner: t.withIdentity(OWNER),
    outsider: t.withIdentity(OUTSIDER),
    ...ids,
  };
}

describe("OAuth 2.1 remote MCP authorization", () => {
  it("registers a PKCE client and exposes only authorized agent choices", async () => {
    const { owner, agentId } = await setup();
    const request = await owner.query(api.oauth.authorizationRequest, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:write",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    });
    expect(request).toMatchObject({
      clientName: "Claude",
      scopes: ["operate:read", "operate:write"],
      agents: [{ agentId, name: "Plugin Agent", scopeName: "OAuth QA" }],
    });
    await expect(
      owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: "https://attacker.example/callback",
        scope: "operate:read",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/invalid oauth/i);
  });

  it("exchanges a one-time code, enforces PKCE, rotates refresh tokens, and revokes access", async () => {
    const { t, owner, agentId } = await setup();
    const code = "opc_authorization_code";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read operate:write",
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    await expect(
      t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: "wrong-verifier".repeat(4),
        accessToken: "opa_wrong",
        refreshToken: "opr_wrong",
      }),
    ).rejects.toThrow(/invalid or expired/i);

    const accessToken = "opa_first_access";
    const refreshToken = "opr_first_refresh";
    await t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken,
    });
    await expect(
      t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_replay",
        refreshToken: "opr_replay",
      }),
    ).rejects.toThrow(/invalid or expired/i);
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).resolves.toMatchObject({ agentId, name: "Plugin Agent" });

    const nextAccessToken = "opa_second_access";
    const nextRefreshToken = "opr_second_refresh";
    await t.mutation(api.oauth.refreshAccessToken, {
      refreshToken,
      clientId: CLIENT_ID,
      accessToken: nextAccessToken,
      nextRefreshToken,
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).rejects.toThrow(/invalid api key/i);
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).resolves.toMatchObject({ agentId });
    await expect(
      t.mutation(api.oauth.refreshAccessToken, {
        refreshToken,
        clientId: CLIENT_ID,
        accessToken: "opa_reused",
        nextRefreshToken: "opr_reused",
      }),
    ).rejects.toThrow(/invalid or expired/i);

    await t.mutation(api.oauth.revokeToken, { token: nextRefreshToken });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).rejects.toThrow(/invalid api key/i);
  });

  it("rejects unauthorized agent grants and invalidates access when membership is removed", async () => {
    const { t, owner, outsider, agentId, workspaceId } = await setup();
    await expect(
      outsider.mutation(api.oauth.approveAuthorization, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        codeChallenge: CHALLENGE,
        code: "opc_outsider",
        agentId,
      }),
    ).rejects.toThrow(/not allowed/i);

    const code = "opc_membership_code";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read",
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    const accessToken = "opa_membership";
    await t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken: "opr_membership",
    });
    await expect(
      t.mutation(api.agentApi.heartbeat, { apiKey: accessToken }),
    ).rejects.toThrow(/missing operate:write/i);

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", OWNER.subject)
            .eq("workspaceId", workspaceId),
        )
        .unique();
      await ctx.db.delete(membership!._id);
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).rejects.toThrow(/oauth access was revoked/i);
  });

  it("rejects unsafe dynamic redirect URIs", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.oauth.registerClient, {
        clientId: "opc_unsafe",
        clientName: "Unsafe",
        redirectUris: ["http://attacker.example/callback"],
      }),
    ).rejects.toThrow(/https urls/i);
  });
});
