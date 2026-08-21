import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

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
    ).rejects.toThrow(/official/i);
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
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid or expired/i),
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).rejects.toThrow(/invalid api key/i);

    await t.mutation(api.oauth.revokeToken, { token: nextRefreshToken });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).rejects.toThrow(/invalid api key/i);
  });

  it("RFC revoke of a rotated refresh token still kills the live successor", async () => {
    const { t, owner, agentId } = await setup();
    const code = "opc_revoke_predecessor";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read operate:write",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    const accessToken = "opa_revoke_first";
    const refreshToken = "opr_revoke_first";
    await t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken,
      resource: RESOURCE,
    });
    const liveAccess = "opa_revoke_live";
    const liveRefresh = "opr_revoke_live";
    await t.mutation(api.oauth.refreshAccessToken, {
      refreshToken,
      clientId: CLIENT_ID,
      accessToken: liveAccess,
      nextRefreshToken: liveRefresh,
      resource: RESOURCE,
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: liveAccess }),
    ).resolves.toMatchObject({ agentId });

    // Logout presented the refresh the client last stored before rotation.
    await t.mutation(api.oauth.revokeToken, { token: refreshToken });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: liveAccess }),
    ).rejects.toThrow(/invalid api key/i);
    await expect(
      t.mutation(api.oauth.refreshAccessToken, {
        refreshToken: liveRefresh,
        clientId: CLIENT_ID,
        accessToken: "opa_after_logout",
        nextRefreshToken: "opr_after_logout",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("binds www and apex as one audience and refuses unofficial hosts", async () => {
    const { t, owner, agentId } = await setup();
    await expect(
      owner.mutation(api.oauth.approveAuthorization, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        resource: "https://attacker.example/api/mcp",
        codeChallenge: CHALLENGE,
        code: "opc_unofficial",
        agentId,
      }),
    ).rejects.toThrow(/official/i);

    const code = "opc_www_alias";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read",
      resource: "https://www.operate.to/api/mcp",
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    const accessToken = "opa_www_alias";
    await t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken: "opr_www_alias",
      resource: "https://www.operate.to/api/mcp",
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).resolves.toMatchObject({ agentId });
    await expect(
      t.mutation(api.agentApi.connect, {
        apiKey: accessToken,
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ agentId });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) =>
          q.eq("tokenHash", sha256Hex(accessToken)),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        resource: "https://attacker.example/api/mcp",
      });
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).rejects.toThrow(/audience/i);
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

  it("cannot see another workspace through an OAuth token", async () => {
    const { t, owner, agentId, workspaceId } = await setup();
    const other = await t.run(async (ctx) => {
      const otherWorkspaceId = await ctx.db.insert("workspaces", {
        name: "Secret Co",
        slug: "secret-co",
        ownerClerkId: "other_owner",
        createdAt: Date.now(),
      });
      const spaceId = await ctx.db.insert("spaces", {
        name: "Hidden HQ",
        parentType: "workspace",
        parentId: otherWorkspaceId,
        position: 0,
        createdAt: Date.now(),
      });
      return { otherWorkspaceId, spaceId };
    });

    const code = "opc_tenant";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read operate:write",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      code,
      agentId,
    });
    const accessToken = "opa_tenant";
    await t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken: "opr_tenant",
      resource: RESOURCE,
    });

    const me = await t.query(api.agentApi.whoami, { apiKey: accessToken });
    expect(me.scopeId).toBe(workspaceId);
    expect(me.scopeId).not.toBe(other.otherWorkspaceId);

    const tree = await t.query(api.agentApi.getTree, { apiKey: accessToken });
    expect(JSON.stringify(tree)).not.toContain("Hidden HQ");
    expect(JSON.stringify(tree)).not.toContain(other.spaceId);

    await expect(
      t.mutation(api.agentApi.createProject, {
        apiKey: accessToken,
        spaceId: other.spaceId,
        name: "Exfil",
      }),
    ).rejects.toThrow(/outside your agent's scope/i);
  });

  it("rejects unsafe dynamic redirect URIs", async () => {
    const t = convexTest(schema, modules);
    const refused = [
      "http://attacker.example/callback",
      "https://attacker.example/callback",
      "https://chatgpt.com.evil.example/callback",
      "https://user:pass@claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback#frag",
      "https://claude.ai:8443/api/mcp/auth_callback",
    ];
    for (const [index, redirectUri] of refused.entries()) {
      await expect(
        t.mutation(api.oauth.registerClient, {
          clientId: `opc_unsafe_${index}`,
          clientName: "Unsafe",
          redirectUris: [redirectUri],
          registrationSubject: `unsafe-client-${index}`,
        }),
      ).rejects.toThrow(/https urls|directory host/i);
    }
    await t.mutation(api.oauth.registerClient, {
      clientId: "opc_chatgpt",
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      registrationSubject: "chatgpt-client",
    });
    await t.mutation(api.oauth.registerClient, {
      clientId: "opc_loopback",
      clientName: "Local",
      redirectUris: ["http://127.0.0.1:54321/callback"],
      registrationSubject: "loopback-client",
    });
  });

  it("refuses an unofficial redirect even if a client row already holds it", async () => {
    const { t, owner } = await setup();
    const unofficial = "https://attacker.example/callback";
    await t.run(async (ctx) => {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_client_id", (q) => q.eq("clientId", CLIENT_ID))
        .unique();
      await ctx.db.patch(client!._id, {
        redirectUris: [...client!.redirectUris, unofficial],
      });
    });
    await expect(
      owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: unofficial,
        scope: "operate:read",
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/invalid oauth authorization request/i);
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
