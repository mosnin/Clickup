import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const RESOURCE = "https://www.operate.to/api/mcp";
const CLIENT_ID = "oauth-maintenance-client";
const SUBJECT = "oauth-maintenance-owner";
const REPLAY_EVIDENCE_RETENTION_MS = 44 * 24 * 60 * 60 * 1000;

function credentialHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function testBackend() {
  return convexTest(schema, modules);
}

async function pruneOAuthEvidence(t: ReturnType<typeof testBackend>) {
  await t.mutation(internal.maintenance.pruneOAuthAuthorizationCodes, {});
  await t.mutation(internal.maintenance.pruneOAuthAccessTokens, {});
}

describe("OAuth replay-evidence pruning", () => {
  it("keeps an expired consumed code while its grant is live and preserves exact replay recovery", async () => {
    const t = testBackend();
    const now = Date.now();
    const codeHash = credentialHash("expired-consumed-code");
    const codeChallenge = credentialHash("matching-pkce-verifier");

    await t.run(async (ctx) => {
      await ctx.db.insert("oauthAuthorizationCodes", {
        codeHash,
        clientId: CLIENT_ID,
        redirectUri: "https://client.example/callback",
        codeChallenge,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: now - 60_000,
        usedAt: now - 120_000,
        createdAt: now - 180_000,
      });
      await ctx.db.insert("oauthTokenGrants", {
        grantId: codeHash,
        clientId: CLIENT_ID,
        resource: RESOURCE,
        userClerkId: SUBJECT,
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
      });
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("oauthAuthorizationCodes")
          .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
          .unique(),
      ),
    ).resolves.not.toBeNull();

    await expect(
      t.mutation(internal.oauth.exchangeAuthorizationCode, {
        codeHash,
        clientId: CLIENT_ID,
        redirectUri: "https://client.example/callback",
        codeChallenge,
        accessTokenHash: credentialHash("unused-replay-access"),
        refreshTokenHash: credentialHash("unused-replay-refresh"),
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      ok: false,
      replayDetected: true,
      grantRevoked: true,
      recoveryStatus: "authorization_code_replay_revoked",
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("oauthTokenGrants")
          .withIndex("by_grant_id", (q) => q.eq("grantId", codeHash))
          .unique(),
      ),
    ).resolves.toMatchObject({
      revocationReason: "authorization_code_replay_recovery",
    });

    // Fresh terminal evidence still gets the full retry/recovery margin.
    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("oauthAuthorizationCodes")
          .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
          .unique(),
      ),
    ).resolves.not.toBeNull();
  });

  it("keeps an expired rotated refresh row while its successor family is live", async () => {
    const t = testBackend();
    const now = Date.now();
    const grantId = credentialHash("tracked-refresh-grant");
    const originalRefreshHash = credentialHash("tracked-original-refresh");
    const successorRefreshHash = credentialHash("tracked-successor-refresh");

    const originalTokenId = await t.run(async (ctx) => {
      await ctx.db.insert("oauthTokenGrants", {
        grantId,
        clientId: CLIENT_ID,
        resource: RESOURCE,
        userClerkId: SUBJECT,
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
      });
      return ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("tracked-original-access"),
        refreshTokenHash: originalRefreshHash,
        grantId,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: now + 60 * 60 * 1000,
        refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
        createdAt: now - 10_000,
      });
    });

    await expect(
      t.mutation(internal.oauth.refreshAccessToken, {
        refreshTokenHash: originalRefreshHash,
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("tracked-successor-access"),
        nextRefreshTokenHash: successorRefreshHash,
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      await ctx.db.patch(originalTokenId, { refreshExpiresAt: now - 1 });
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ctx.db.get(originalTokenId)),
    ).resolves.not.toBeNull();

    await expect(
      t.mutation(internal.oauth.refreshAccessToken, {
        refreshTokenHash: originalRefreshHash,
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("tracked-replay-access"),
        nextRefreshTokenHash: credentialHash("tracked-replay-refresh"),
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({
      ok: false,
      replayDetected: true,
      grantRevoked: true,
      recoveryStatus: "refresh_token_replay_revoked",
    });
    await expect(
      t.mutation(internal.oauth.refreshAccessToken, {
        refreshTokenHash: successorRefreshHash,
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("blocked-successor-access"),
        nextRefreshTokenHash: credentialHash("blocked-successor-refresh"),
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired refresh token/i);

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ctx.db.get(originalTokenId)),
    ).resolves.not.toBeNull();
  });

  it("retains unassociated legacy replay evidence until a durable authority fence is old enough", async () => {
    const t = testBackend();
    const now = Date.now();
    const replayedRefreshHash = credentialHash("legacy-replayed-refresh");
    const successorRefreshHash = credentialHash("legacy-successor-refresh");

    const replayedTokenId = await t.run(async (ctx) => {
      const replayedId = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("legacy-revoked-access"),
        refreshTokenHash: replayedRefreshHash,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: now - 60_000,
        refreshExpiresAt: now - 1,
        createdAt: now - 120_000,
        revokedAt: now - 60_000,
      });
      await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("legacy-successor-access"),
        refreshTokenHash: successorRefreshHash,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: now + 60 * 60 * 1000,
        refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
        createdAt: now - 30_000,
      });
      return replayedId;
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ctx.db.get(replayedTokenId)),
    ).resolves.not.toBeNull();

    await expect(
      t.mutation(internal.oauth.refreshAccessToken, {
        refreshTokenHash: replayedRefreshHash,
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("legacy-replay-access"),
        nextRefreshTokenHash: credentialHash("legacy-replay-refresh"),
        resource: RESOURCE,
      }),
    ).resolves.toMatchObject({ ok: false, replayDetected: true });
    await expect(
      t.mutation(internal.oauth.refreshAccessToken, {
        refreshTokenHash: successorRefreshHash,
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("legacy-blocked-access"),
        nextRefreshTokenHash: credentialHash("legacy-blocked-refresh"),
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/invalid or expired refresh token/i);

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ctx.db.get(replayedTokenId)),
    ).resolves.not.toBeNull();
    await expect(
      t.run(async (ctx) => ctx.db.query("oauthLegacyRevocations").first()),
    ).resolves.toMatchObject({ reason: "legacy_refresh_replay" });
  });

  it("prunes only durably terminal evidence after the 44-day retention window", async () => {
    const t = testBackend();
    const now = Date.now();
    const terminalAt = now - REPLAY_EVIDENCE_RETENTION_MS - 60_000;
    const insideMarginAt = now - REPLAY_EVIDENCE_RETENTION_MS + 60_000;
    const terminalGrantId = credentialHash("terminal-grant");
    const insideMarginGrantId = credentialHash("inside-margin-grant");
    const orphanCodeHash = credentialHash("orphan-consumed-code");
    const terminalLegacyAuthority = JSON.stringify([
      CLIENT_ID,
      RESOURCE,
      SUBJECT,
      null,
      null,
    ]);

    const ids = await t.run(async (ctx) => {
      await ctx.db.insert("oauthTokenGrants", {
        grantId: terminalGrantId,
        clientId: CLIENT_ID,
        resource: RESOURCE,
        userClerkId: SUBJECT,
        createdAt: terminalAt - 60_000,
        updatedAt: terminalAt,
        revokedAt: terminalAt,
        revocationReason: "token_revoked",
      });
      await ctx.db.insert("oauthTokenGrants", {
        grantId: insideMarginGrantId,
        clientId: CLIENT_ID,
        resource: RESOURCE,
        userClerkId: SUBJECT,
        createdAt: insideMarginAt - 60_000,
        updatedAt: insideMarginAt,
        revokedAt: insideMarginAt,
        revocationReason: "token_revoked",
      });
      const terminalCodeId = await ctx.db.insert("oauthAuthorizationCodes", {
        codeHash: terminalGrantId,
        clientId: CLIENT_ID,
        redirectUri: "https://client.example/callback",
        codeChallenge: credentialHash("terminal-code-challenge"),
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        usedAt: terminalAt,
        createdAt: terminalAt - 60_000,
      });
      const terminalTokenId = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("terminal-access"),
        refreshTokenHash: credentialHash("terminal-refresh"),
        grantId: terminalGrantId,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        refreshExpiresAt: terminalAt,
        createdAt: terminalAt - 60_000,
        revokedAt: terminalAt,
        rotatedAt: terminalAt,
      });
      const insideMarginCodeId = await ctx.db.insert(
        "oauthAuthorizationCodes",
        {
          codeHash: insideMarginGrantId,
          clientId: CLIENT_ID,
          redirectUri: "https://client.example/callback",
          codeChallenge: credentialHash("inside-margin-code-challenge"),
          scopes: ["operate:read"],
          resource: RESOURCE,
          userClerkId: SUBJECT,
          expiresAt: insideMarginAt,
          usedAt: insideMarginAt,
          createdAt: insideMarginAt - 60_000,
        },
      );
      const insideMarginTokenId = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("inside-margin-access"),
        refreshTokenHash: credentialHash("inside-margin-refresh"),
        grantId: insideMarginGrantId,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: insideMarginAt,
        refreshExpiresAt: insideMarginAt,
        createdAt: insideMarginAt - 60_000,
        revokedAt: insideMarginAt,
        rotatedAt: insideMarginAt,
      });
      const orphanCodeId = await ctx.db.insert("oauthAuthorizationCodes", {
        codeHash: orphanCodeHash,
        clientId: CLIENT_ID,
        redirectUri: "https://client.example/callback",
        codeChallenge: credentialHash("orphan-code-challenge"),
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        usedAt: terminalAt,
        createdAt: terminalAt - 60_000,
      });
      const orphanTokenId = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("orphan-access"),
        refreshTokenHash: credentialHash("orphan-refresh"),
        grantId: credentialHash("missing-grant"),
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        refreshExpiresAt: terminalAt,
        createdAt: terminalAt - 60_000,
        revokedAt: terminalAt,
        rotatedAt: terminalAt,
      });
      await ctx.db.insert("oauthLegacyRevocations", {
        authorityKey: terminalLegacyAuthority,
        revokedBefore: terminalAt,
        createdAt: terminalAt,
        updatedAt: terminalAt,
        reason: "legacy_refresh_replay",
      });
      const terminalLegacyTokenId = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("terminal-legacy-access"),
        refreshTokenHash: credentialHash("terminal-legacy-refresh"),
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        refreshExpiresAt: terminalAt,
        createdAt: terminalAt - 60_000,
        revokedAt: terminalAt,
      });
      return {
        terminalCodeId,
        terminalTokenId,
        insideMarginCodeId,
        insideMarginTokenId,
        orphanCodeId,
        orphanTokenId,
        terminalLegacyTokenId,
      };
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ({
        terminalCode: await ctx.db.get(ids.terminalCodeId),
        terminalToken: await ctx.db.get(ids.terminalTokenId),
        terminalLegacyToken: await ctx.db.get(ids.terminalLegacyTokenId),
        insideMarginCode: await ctx.db.get(ids.insideMarginCodeId),
        insideMarginToken: await ctx.db.get(ids.insideMarginTokenId),
        orphanCode: await ctx.db.get(ids.orphanCodeId),
        orphanToken: await ctx.db.get(ids.orphanTokenId),
      })),
    ).resolves.toEqual({
      terminalCode: null,
      terminalToken: null,
      terminalLegacyToken: null,
      insideMarginCode: expect.any(Object),
      insideMarginToken: expect.any(Object),
      orphanCode: expect.any(Object),
      orphanToken: expect.any(Object),
    });
  });

  it("advances durable cursors past more than one protected batch", async () => {
    const t = testBackend();
    const now = Date.now();
    const terminalAt = now - REPLAY_EVIDENCE_RETENTION_MS - 60_000;
    const terminalGrantId = credentialHash("cursor-terminal-grant");

    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("oauthAuthorizationCodes", {
          codeHash: credentialHash(`cursor-protected-code-${index}`),
          clientId: CLIENT_ID,
          redirectUri: "https://client.example/callback",
          codeChallenge: credentialHash(`cursor-challenge-${index}`),
          scopes: ["operate:read"],
          resource: RESOURCE,
          userClerkId: SUBJECT,
          expiresAt: now - 60_000,
          usedAt: now - 120_000,
          createdAt: now - 180_000,
        });
        await ctx.db.insert("oauthAccessTokens", {
          tokenHash: credentialHash(`cursor-protected-access-${index}`),
          refreshTokenHash: credentialHash(`cursor-protected-refresh-${index}`),
          grantId: credentialHash(`cursor-missing-grant-${index}`),
          clientId: CLIENT_ID,
          scopes: ["operate:read"],
          resource: RESOURCE,
          userClerkId: SUBJECT,
          expiresAt: now - 60_000,
          refreshExpiresAt: now - 1,
          createdAt: now - 180_000,
          revokedAt: now - 60_000,
        });
      }
    });

    const terminalIds = await t.run(async (ctx) => {
      await ctx.db.insert("oauthTokenGrants", {
        grantId: terminalGrantId,
        clientId: CLIENT_ID,
        resource: RESOURCE,
        userClerkId: SUBJECT,
        createdAt: terminalAt - 60_000,
        updatedAt: terminalAt,
        revokedAt: terminalAt,
        revocationReason: "token_revoked",
      });
      const code = await ctx.db.insert("oauthAuthorizationCodes", {
        codeHash: terminalGrantId,
        clientId: CLIENT_ID,
        redirectUri: "https://client.example/callback",
        codeChallenge: credentialHash("cursor-terminal-challenge"),
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        usedAt: terminalAt,
        createdAt: terminalAt - 60_000,
      });
      const token = await ctx.db.insert("oauthAccessTokens", {
        tokenHash: credentialHash("cursor-terminal-access"),
        refreshTokenHash: credentialHash("cursor-terminal-refresh"),
        grantId: terminalGrantId,
        clientId: CLIENT_ID,
        scopes: ["operate:read"],
        resource: RESOURCE,
        userClerkId: SUBJECT,
        expiresAt: terminalAt,
        refreshExpiresAt: terminalAt,
        createdAt: terminalAt - 60_000,
        revokedAt: terminalAt,
        rotatedAt: terminalAt,
      });
      return { code, token };
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ({
        code: await ctx.db.get(terminalIds.code),
        token: await ctx.db.get(terminalIds.token),
        cursors: await ctx.db.query("maintenanceCursors").collect(),
      })),
    ).resolves.toMatchObject({
      code: expect.any(Object),
      token: expect.any(Object),
      cursors: [expect.any(Object), expect.any(Object)],
    });

    await pruneOAuthEvidence(t);
    await expect(
      t.run(async (ctx) => ({
        code: await ctx.db.get(terminalIds.code),
        token: await ctx.db.get(terminalIds.token),
        cursors: await ctx.db.query("maintenanceCursors").collect(),
      })),
    ).resolves.toEqual({ code: null, token: null, cursors: [] });
  }, 30_000);
});
