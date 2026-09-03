import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The parts of the authorization server that only matter when something has
// gone wrong: a downgraded challenge, a redirect URI that is nearly right, a
// code or a refresh token that shows up twice. tests/oauth.test.ts covers the
// happy path and the ordinary refusals; this file covers what the server does
// when it has reason to believe a credential has escaped.

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "family_owner", email: "owner@example.com" };
const CLIENT_ID = "opc_family_client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://operate.to/api/mcp";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

async function setup() {
  const t = convexTest(schema, modules);
  const { workspaceId, agentId } = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      name: "Family QA",
      slug: "family-qa",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId: workspace,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
      name: "Family Owner",
    });
    const agent = await ctx.db.insert("agents", {
      name: "Family Agent",
      parentType: "workspace",
      parentId: workspace,
      status: "active",
      role: "member",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    return { workspaceId: workspace, agentId: agent };
  });
  await t.mutation(api.oauth.registerClient, {
    clientId: CLIENT_ID,
    clientName: "Claude",
    redirectUris: [REDIRECT_URI],
    registrationSubject: "family-client",
  });
  return { t, owner: t.withIdentity(OWNER), workspaceId, agentId };
}

async function approve(
  t: Awaited<ReturnType<typeof setup>>,
  code: string,
  overrides: Record<string, unknown> = {},
) {
  await t.owner.mutation(api.oauth.approveAuthorization, {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: "openid email operate:read operate:write",
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    code,
    agentId: t.agentId,
    ...overrides,
  });
}

/** Every access token the grant behind this code has ever minted. */
async function familyOf(
  t: Awaited<ReturnType<typeof setup>>["t"],
  code: string,
) {
  return t.run(async (ctx) => {
    const grant = await ctx.db
      .query("oauthAuthorizationCodes")
      .withIndex("by_code_hash")
      .collect();
    const grantId = grant.find((row) => row.grantId !== undefined)?.grantId;
    const tokens = await ctx.db.query("oauthAccessTokens").collect();
    return tokens
      .filter((row) => row.grantId === grantId)
      .map((row) => ({ revoked: row.revokedAt !== undefined }));
  });
}

describe("PKCE downgrade", () => {
  it("refuses plain, and refuses a request that names no method at all", async () => {
    const fixture = await setup();
    for (const method of ["plain", "", "s256", "S512"]) {
      await expect(
        approve(fixture, `opc_method_${method || "absent"}`, {
          codeChallengeMethod: method,
        }),
        method,
      ).rejects.toThrow(/not allowed/i);
    }
    // The query that renders the consent screen refuses the same downgrade,
    // so the screen is never drawn for a request that could not be redeemed.
    await expect(
      fixture.owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read",
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "plain",
      }),
    ).rejects.toThrow(/invalid oauth/i);
  });

  it("refuses a challenge that is not a 43-128 character base64url string", async () => {
    const fixture = await setup();
    for (const challenge of ["short", `${CHALLENGE}+`, "x".repeat(129)]) {
      await expect(
        approve(fixture, `opc_challenge_${challenge.length}`, {
          codeChallenge: challenge,
        }),
        challenge,
      ).rejects.toThrow(/not allowed/i);
    }
  });

  it("refuses a verifier outside RFC 7636's own shape", async () => {
    const fixture = await setup();
    await approve(fixture, "opc_verifier_shape");
    await expect(
      fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
        code: "opc_verifier_shape",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        // 42 characters: one short of the minimum the RFC allows.
        codeVerifier: "v".repeat(42),
        accessToken: "opa_short_verifier",
        refreshToken: "opr_short_verifier",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

describe("redirect URI matching", () => {
  it("is byte for byte, not merely close", async () => {
    const fixture = await setup();
    const nearMisses = [
      `${REDIRECT_URI}/`,
      `${REDIRECT_URI}?extra=1`,
      REDIRECT_URI.replace("auth_callback", "auth_Callback"),
      REDIRECT_URI.replace("https://claude.ai", "https://claude.ai:443"),
      ` ${REDIRECT_URI}`,
    ];
    for (const uri of nearMisses) {
      await expect(
        approve(fixture, `opc_uri_${uri.length}`, { redirectUri: uri }),
        uri,
      ).rejects.toThrow(/not allowed/i);
    }
  });

  it("holds the token endpoint to the same URI the code was bound to", async () => {
    const fixture = await setup();
    await approve(fixture, "opc_uri_binding");
    await expect(
      fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
        code: "opc_uri_binding",
        clientId: CLIENT_ID,
        redirectUri: `${REDIRECT_URI}/`,
        codeVerifier: VERIFIER,
        accessToken: "opa_uri_binding",
        refreshToken: "opr_uri_binding",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

describe("authorization codes", () => {
  it("live for ten minutes and not a minute longer", async () => {
    const fixture = await setup();
    await approve(fixture, "opc_ttl");
    const row = await fixture.t.run(async (ctx) => {
      const rows = await ctx.db.query("oauthAuthorizationCodes").collect();
      return rows[0];
    });
    expect(row.expiresAt - row.createdAt).toBe(10 * 60 * 1000);

    // Push the same row into the past rather than moving the clock, so the
    // expiry branch is exercised without a fake timer that the scheduler
    // would also have to survive.
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
        code: "opc_ttl",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_ttl",
        refreshToken: "opr_ttl",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("kills the whole grant when one is presented twice", async () => {
    const fixture = await setup();
    const code = "opc_replay";
    await approve(fixture, code);
    await fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken: "opa_replay_first",
      refreshToken: "opr_replay_first",
      resource: RESOURCE,
    });
    // The token from the first, legitimate exchange works.
    await expect(
      fixture.t.query(api.agentApi.whoami, { apiKey: "opa_replay_first" }),
    ).resolves.toMatchObject({ agentId: fixture.agentId });

    await expect(
      fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
        code,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        accessToken: "opa_replay_second",
        refreshToken: "opr_replay_second",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_grant",
      reason: "authorization_code_replay",
    });

    // Not just "the second exchange failed": the first one's token is dead
    // too, which is the whole point of treating a replay as a theft.
    expect(await familyOf(fixture.t, code)).toEqual([{ revoked: true }]);
    await expect(
      fixture.t.query(api.agentApi.whoami, { apiKey: "opa_replay_first" }),
    ).rejects.toThrow(/invalid api key/i);
  });
});

describe("refresh tokens", () => {
  it("rotate, and a rotated one presented again kills the family", async () => {
    const fixture = await setup();
    const code = "opc_refresh_family";
    await approve(fixture, code);
    await fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken: "opa_gen1",
      refreshToken: "opr_gen1",
      resource: RESOURCE,
    });
    await fixture.t.mutation(api.oauth.refreshAccessToken, {
      refreshToken: "opr_gen1",
      clientId: CLIENT_ID,
      accessToken: "opa_gen2",
      nextRefreshToken: "opr_gen2",
      resource: RESOURCE,
    });
    // Rotation issued a new pair and retired the old one, without touching
    // the rest of the family.
    await expect(
      fixture.t.query(api.agentApi.whoami, { apiKey: "opa_gen2" }),
    ).resolves.toMatchObject({ agentId: fixture.agentId });

    await expect(
      fixture.t.mutation(api.oauth.refreshAccessToken, {
        refreshToken: "opr_gen1",
        clientId: CLIENT_ID,
        accessToken: "opa_gen3",
        nextRefreshToken: "opr_gen3",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_grant",
      reason: "refresh_token_replay",
    });

    const family = await familyOf(fixture.t, code);
    expect(family).toHaveLength(2);
    expect(family.every((row) => row.revoked)).toBe(true);
    await expect(
      fixture.t.query(api.agentApi.whoami, { apiKey: "opa_gen2" }),
    ).rejects.toThrow(/invalid api key/i);
    // And the replay cannot be laundered into a fresh pair by trying again.
    await expect(
      fixture.t.mutation(api.oauth.refreshAccessToken, {
        refreshToken: "opr_gen2",
        clientId: CLIENT_ID,
        accessToken: "opa_gen4",
        nextRefreshToken: "opr_gen4",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_grant" });
  });
});

describe("revocation", () => {
  it("takes the whole grant down, from either half of the pair", async () => {
    const fixture = await setup();
    const code = "opc_revoke_family";
    await approve(fixture, code);
    await fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken: "opa_rev1",
      refreshToken: "opr_rev1",
      resource: RESOURCE,
    });
    await fixture.t.mutation(api.oauth.refreshAccessToken, {
      refreshToken: "opr_rev1",
      clientId: CLIENT_ID,
      accessToken: "opa_rev2",
      nextRefreshToken: "opr_rev2",
      resource: RESOURCE,
    });
    // Revoking the ACCESS token of the live generation must also retire the
    // refresh token beside it, or a disconnect leaves a way back in.
    await fixture.t.mutation(api.oauth.revokeToken, { token: "opa_rev2" });
    const family = await familyOf(fixture.t, code);
    expect(family.every((row) => row.revoked)).toBe(true);
    await expect(
      fixture.t.mutation(api.oauth.refreshAccessToken, {
        refreshToken: "opr_rev2",
        clientId: CLIENT_ID,
        accessToken: "opa_rev3",
        nextRefreshToken: "opr_rev3",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("reports success for a token that never existed", async () => {
    const fixture = await setup();
    await expect(
      fixture.t.mutation(api.oauth.revokeToken, { token: "opa_never_issued" }),
    ).resolves.toEqual({ revoked: true });
  });
});

describe("userinfo", () => {
  it("names the tenant the token speaks for", async () => {
    const fixture = await setup();
    const code = "opc_userinfo";
    await approve(fixture, code);
    await fixture.t.mutation(api.oauth.exchangeAuthorizationCode, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: VERIFIER,
      accessToken: "opa_userinfo",
      refreshToken: "opr_userinfo",
      resource: RESOURCE,
    });
    await expect(
      fixture.t.query(api.oauth.userInfo, {
        accessToken: "opa_userinfo",
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      subject: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
      organizationId: fixture.workspaceId,
      organizationName: "Family QA",
    });
  });
});
