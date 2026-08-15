import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "oauth_owner", email: "owner@example.com" };
const OUTSIDER = { subject: "oauth_outsider", email: "other@example.com" };
const MEMBER = { subject: "oauth_member", email: "member@example.com" };
const CLIENT_ID = "opc_test_client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://operate.to/api/mcp";
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
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: MEMBER.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
      name: "OAuth Owner",
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
    registrationSubject: "test-client",
  });
  return {
    t,
    owner: t.withIdentity(OWNER),
    member: t.withIdentity(MEMBER),
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
      resource: RESOURCE,
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
        resource: RESOURCE,
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
      scope: "openid email operate:read operate:write",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    await expect(
      t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_wrong_audience",
        refreshToken: "opr_wrong_audience",
        resource: "https://other.example/api/mcp",
      }),
    ).rejects.toThrow(/invalid or expired/i);
    await expect(
      t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: "wrong-verifier".repeat(4),
        accessToken: "opa_wrong",
        refreshToken: "opr_wrong",
        resource: RESOURCE,
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
      resource: RESOURCE,
    });
    await expect(
      t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_replay",
        refreshToken: "opr_replay",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired/i);
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).resolves.toMatchObject({ agentId, name: "Plugin Agent" });
    await expect(
      t.query(api.oauth.userInfo, {
        accessToken,
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      subject: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
    });
    await expect(
      t.mutation(api.agentApi.connect, {
        apiKey: accessToken,
        resource: "https://other.example/api/mcp",
      }),
    ).rejects.toThrow(/audience/i);

    const nextAccessToken = "opa_second_access";
    const nextRefreshToken = "opr_second_refresh";
    await t.mutation(api.oauth.refreshAccessToken, {
      refreshToken,
      clientId: CLIENT_ID,
      accessToken: nextAccessToken,
      nextRefreshToken,
      resource: RESOURCE,
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
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired/i);

    await t.mutation(api.oauth.revokeToken, { token: nextRefreshToken });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).rejects.toThrow(/invalid api key/i);
  });

  it("never lets a regular workspace member inherit a workspace-wide agent", async () => {
    const { member, agentId } = await setup();
    const request = await member.query(api.oauth.authorizationRequest, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    });
    expect(request.agents).toEqual([]);
    await expect(
      member.mutation(api.oauth.approveAuthorization, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        code: "opc_member_escalation",
        agentId,
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("rejects unauthorized agent grants and invalidates access when membership is removed", async () => {
    const { t, owner, outsider, agentId, workspaceId } = await setup();
    await expect(
      outsider.mutation(api.oauth.approveAuthorization, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        resource: RESOURCE,
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
      resource: RESOURCE,
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
      resource: RESOURCE,
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
        registrationSubject: "unsafe-client",
      }),
    ).rejects.toThrow(/https urls/i);
  });

  it("bounds anonymous dynamic client registration", async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < 60; index += 1) {
      await t.mutation(api.oauth.registerClient, {
        clientId: `opc_rate_${index}`,
        clientName: "Rate Test",
        redirectUris: [REDIRECT_URI],
        registrationSubject: "one-public-source",
      });
    }
    await expect(
      t.mutation(api.oauth.registerClient, {
        clientId: "opc_rate_blocked",
        clientName: "Rate Test",
        redirectUris: [REDIRECT_URI],
        registrationSubject: "one-public-source",
      }),
    ).rejects.toThrow(/too many oauth client registrations/i);
  });
});
