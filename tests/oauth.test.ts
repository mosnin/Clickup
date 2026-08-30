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

function credentialHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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

async function exchangeCode(
  t: Awaited<ReturnType<typeof setup>>["t"],
  args: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    accessToken: string;
    refreshToken: string;
    resource: string;
  },
) {
  const response = await t.fetch("/oauth/internal/token", {
    method: "POST",
    headers: {
      Authorization: `PKCE ${args.codeVerifier}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation: "authorization_code",
      codeHash: credentialHash(args.code),
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      accessTokenHash: credentialHash(args.accessToken),
      refreshTokenHash: credentialHash(args.refreshToken),
      resource: args.resource,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error((result as { error_description?: string }).error_description);
  }
  return result;
}

async function refreshGrant(
  t: Awaited<ReturnType<typeof setup>>["t"],
  args: {
    refreshToken: string;
    clientId: string;
    accessToken: string;
    nextRefreshToken: string;
    resource: string;
  },
) {
  const response = await t.fetch("/oauth/internal/token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.refreshToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation: "refresh_token",
      clientId: args.clientId,
      accessTokenHash: credentialHash(args.accessToken),
      nextRefreshTokenHash: credentialHash(args.nextRefreshToken),
      resource: args.resource,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error((result as { error_description?: string }).error_description);
  }
  return result;
}

describe("OAuth 2.1 remote MCP authorization", () => {
  it("uses an explicitly configured HTTPS preview as its isolated issuer", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://operate-preview.vercel.app";
    try {
      const { owner } = await setup();
      await expect(
        owner.query(api.oauth.authorizationRequest, {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          scope: "operate:read",
          resource: "https://operate-preview.vercel.app/api/mcp",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
        }),
      ).resolves.toMatchObject({ authorizationKind: "mcp" });
      await expect(
        owner.query(api.oauth.authorizationRequest, {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          scope: "operate:read",
          resource: RESOURCE,
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
        }),
      ).rejects.toThrow(/canonical operate url/i);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previous;
    }
  });

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
    await expect(
      owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        resource: "https://attacker.example/api/mcp",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/canonical operate url/i);
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
      codeHash: credentialHash(code),
      agentId,
    });
    const storedCode = await t.run(async (ctx) =>
      ctx.db
        .query("oauthAuthorizationCodes")
        .withIndex("by_code_hash", (q) =>
          q.eq("codeHash", credentialHash(code)),
        )
        .unique(),
    );
    expect(storedCode?.codeHash).toBe(credentialHash(code));
    expect(JSON.stringify(storedCode)).not.toContain(code);
    await expect(
      exchangeCode(t, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_wrong_audience",
        refreshToken: "opr_wrong_audience",
        resource: "https://other.example/api/mcp",
      }),
    ).rejects.toThrow(/token grant failed/i);
    await expect(
      exchangeCode(t, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: "wrong-verifier".repeat(4),
        accessToken: "opa_wrong",
        refreshToken: "opr_wrong",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/token grant failed/i);

    const accessToken = "opa_first_access";
    const refreshToken = "opr_first_refresh";
    await exchangeCode(t, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken,
      resource: RESOURCE,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) =>
          q.eq("tokenHash", credentialHash(accessToken)),
        )
        .unique();
      // Simulate a production grant minted before www became canonical.
      await ctx.db.patch(row!._id, { resource: RESOURCE });
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).resolves.toMatchObject({ agentId, name: "Plugin Agent" });
    const userInfoResponse = await t.fetch("/oauth/internal/userinfo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resource: RESOURCE }),
    });
    expect(userInfoResponse.status).toBe(200);
    await expect(userInfoResponse.json()).resolves.toMatchObject({
      subject: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
    });
    const bodyOnlyUserInfo = await t.fetch("/oauth/internal/userinfo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, resource: RESOURCE }),
    });
    expect(bodyOnlyUserInfo.status).toBe(401);
    await expect(
      t.mutation(api.agentApi.connect, {
        apiKey: accessToken,
        resource: "https://other.example/api/mcp",
      }),
    ).rejects.toThrow(/audience/i);
    // Existing grants minted before the canonical www origin was introduced
    // remain usable while every newly advertised endpoint uses www.
    await expect(
      t.mutation(api.agentApi.connect, {
        apiKey: accessToken,
        resource: "https://www.operate.to/api/mcp",
      }),
    ).resolves.toMatchObject({ agentId });

    const nextAccessToken = "opa_second_access";
    const nextRefreshToken = "opr_second_refresh";
    await refreshGrant(t, {
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
    for (const mismatch of [
      { clientId: "opc_wrong_client", resource: RESOURCE },
      {
        clientId: CLIENT_ID,
        resource: "https://www.operate.to/api/companyos",
      },
    ]) {
      await expect(
        refreshGrant(t, {
          refreshToken,
          clientId: mismatch.clientId,
          accessToken: `opa_mismatch_${mismatch.clientId}`,
          nextRefreshToken: `opr_mismatch_${mismatch.clientId}`,
          resource: mismatch.resource,
        }),
      ).rejects.toThrow(/token grant failed/i);
      // Metadata mismatch is an ordinary invalid_grant. It cannot be used to
      // revoke a grant family owned by another client or audience.
      await expect(
        t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
      ).resolves.toMatchObject({ agentId });
    }
    await expect(
      refreshGrant(t, {
        refreshToken,
        clientId: CLIENT_ID,
        accessToken: "opa_reused",
        nextRefreshToken: "opr_reused",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      ok: false,
      replayDetected: true,
      grantRevoked: true,
      recoveryStatus: "refresh_token_replay_revoked",
      scope: "openid email operate:read operate:write",
    });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: nextAccessToken }),
    ).rejects.toThrow(/invalid api key/i);
    await expect(
      t.run(async (ctx) => ctx.db.query("oauthTokenGrants").first()),
    ).resolves.toMatchObject({
      revokedAt: expect.any(Number),
      revocationReason: "refresh_token_replay_recovery",
    });
  });

  it("fails closed across an already-rotated legacy refresh chain", async () => {
    const { t, agentId } = await setup();
    const now = Date.now();
    const replayedRefresh = "opr_legacy_replayed";
    const successorAccess = "opa_legacy_successor";
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("opa_legacy_revoked"),
        refreshTokenHash: credentialHash(replayedRefresh),
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        agentId,
        userClerkId: OWNER.subject,
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 60_000,
        createdAt: now - 2_000,
        revokedAt: now - 1_000,
      });
      // This is the shape of a successor minted before grantId and rotatedAt
      // existed: there is no ancestry to follow from the replayed row.
      await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash(successorAccess),
        refreshTokenHash: credentialHash("opr_legacy_successor"),
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        agentId,
        userClerkId: OWNER.subject,
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 60_000,
        createdAt: now - 500,
      });
    });

    await expect(
      refreshGrant(t, {
        refreshToken: replayedRefresh,
        clientId: CLIENT_ID,
        accessToken: "opa_legacy_replay_result",
        nextRefreshToken: "opr_legacy_replay_result",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: false, replayDetected: true });
    await expect(
      t.query(api.agentApi.whoami, { apiKey: successorAccess }),
    ).rejects.toThrow(/invalid api key/i);
    await expect(
      t.run(async (ctx) => ctx.db.query("oauthLegacyRevocations").collect()),
    ).resolves.toHaveLength(1);
  });

  it("turns an exact consumed-code replay into idempotent grant-family cleanup", async () => {
    const { t, owner, agentId } = await setup();
    const code = "opc_recovery_code";
    const accessToken = "opa_recovery_access";
    await owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "operate:read",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      codeHash: credentialHash(code),
      agentId,
    });
    await exchangeCode(t, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken,
      refreshToken: "opr_recovery_refresh",
      resource: RESOURCE,
    });

    // Knowing the consumed code without the original PKCE verifier is not
    // enough to revoke somebody else's live authorization.
    await expect(
      exchangeCode(t, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: "x".repeat(64),
        accessToken: "opa_wrong_recovery",
        refreshToken: "opr_wrong_recovery",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/token grant failed/i);
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).resolves.toMatchObject({ agentId });

    for (const suffix of ["first", "idempotent"]) {
      await expect(
        exchangeCode(t, {
          code,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          codeVerifier: VERIFIER,
          accessToken: `opa_recovery_${suffix}`,
          refreshToken: `opr_recovery_${suffix}`,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({
        ok: false,
        replayDetected: true,
        grantRevoked: true,
        recoveryStatus: "authorization_code_replay_revoked",
      });
    }
    await expect(
      t.query(api.agentApi.whoami, { apiKey: accessToken }),
    ).rejects.toThrow(/invalid api key/i);
    await expect(
      t.run(async (ctx) => ctx.db.query("oauthTokenGrants").first()),
    ).resolves.toMatchObject({
      revokedAt: expect.any(Number),
      revocationReason: "authorization_code_replay_recovery",
    });
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
        codeHash: credentialHash("opc_member_escalation"),
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
        codeHash: credentialHash("opc_outsider"),
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
      codeHash: credentialHash(code),
      agentId,
    });
    const accessToken = "opa_membership";
    await exchangeCode(t, {
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
