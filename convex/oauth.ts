import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { requireAgentByKeyHash, sha256Hex } from "./_agentAuth";
import {
  oauthResourcesMatch,
  oauthLegacyAuthorityKey,
  requireOAuthResource,
  type OAuthResourceKind,
} from "./_oauthResource";
import {
  consumeRateLimit,
  DCR_REGISTRATION_RULE,
} from "./_rateLimit";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_AUTHORIZATION_CHOICES = 100;
const ALLOWED_SCOPES = new Set([
  "openid",
  "email",
  "operate:read",
  "operate:write",
  "companyos:account:read",
  "companyos:data:read",
]);
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function requireText(value: string, field: string, max: number) {
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new ConvexError(`${field} must be 1-${max} characters`);
  }
  return clean;
}

function requireCredentialHash(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ConvexError(`${field} must be a SHA-256 hash`);
  }
  return value;
}

function normalizeScopes(scope: string, resourceKind: OAuthResourceKind) {
  const scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) {
    scopes.push(
      resourceKind === "companyos"
        ? "companyos:account:read"
        : "operate:read",
    );
  }
  for (const item of scopes) {
    if (!ALLOWED_SCOPES.has(item)) {
      throw new ConvexError(`Unsupported OAuth scope: ${item}`);
    }
  }
  if (scopes.includes("operate:write") && !scopes.includes("operate:read")) {
    scopes.unshift("operate:read");
  }
  if (scopes.includes("email") && !scopes.includes("openid")) {
    scopes.unshift("openid");
  }
  if (
    scopes.includes("companyos:data:read") &&
    !scopes.includes("companyos:account:read")
  ) {
    scopes.unshift("companyos:account:read");
  }
  const hasMcpScope = scopes.some((item) => item.startsWith("operate:"));
  const hasCompanyOsScope = scopes.some((item) =>
    item.startsWith("companyos:"),
  );
  if (
    (resourceKind === "mcp" && hasCompanyOsScope) ||
    (resourceKind === "companyos" && hasMcpScope)
  ) {
    throw new ConvexError("OAuth scopes do not match the protected resource");
  }
  return scopes;
}

function validRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

function hexToBase64Url(hex: string) {
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) {
      out += BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    }
    if (c !== undefined) out += BASE64[c & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

export function pkceChallenge(verifier: string) {
  return hexToBase64Url(sha256Hex(verifier));
}

function legacyAuthorityKey(
  token: Doc<"oauthAccessTokens">,
  canonicalResource: string,
) {
  return oauthLegacyAuthorityKey({
    clientId: token.clientId,
    resource: canonicalResource,
    userClerkId: token.userClerkId,
    ...(token.agentId ? { agentId: token.agentId } : {}),
    ...(token.workspaceId ? { workspaceId: token.workspaceId } : {}),
  });
}

async function legacyAuthorityWasRevoked(
  ctx: MutationCtx,
  token: Doc<"oauthAccessTokens">,
  canonicalResource: string,
) {
  const revocation = await ctx.db
    .query("oauthLegacyRevocations")
    .withIndex("by_authority_key", (q) =>
      q.eq("authorityKey", legacyAuthorityKey(token, canonicalResource)),
    )
    .unique();
  return (
    revocation !== null && token.createdAt <= revocation.revokedBefore
  );
}

async function revokeLegacyAuthority(
  ctx: MutationCtx,
  token: Doc<"oauthAccessTokens">,
  canonicalResource: string,
  now: number,
) {
  const authorityKey = legacyAuthorityKey(token, canonicalResource);
  const existing = await ctx.db
    .query("oauthLegacyRevocations")
    .withIndex("by_authority_key", (q) => q.eq("authorityKey", authorityKey))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      revokedBefore: Math.max(existing.revokedBefore, now),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("oauthLegacyRevocations", {
      authorityKey,
      revokedBefore: now,
      createdAt: now,
      updatedAt: now,
      reason: "legacy_refresh_replay",
    });
  }
}

async function canUseAgent(
  ctx: Parameters<typeof requireIdentity>[0],
  agent: Doc<"agents">,
  subject: string,
) {
  if (agent.parentType === "user") return agent.parentId === subject;
  const workspaceId = agent.parentId as Id<"workspaces">;
  const [workspace, membership] = await Promise.all([
    ctx.db.get(workspaceId),
    ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", subject).eq("workspaceId", workspaceId),
      )
      .unique(),
  ]);
  // Workspace agents can see the whole workspace by design, including
  // private Spaces. Only the workspace owner already holds that authority;
  // letting any member select the agent would be a privilege escalation.
  return workspace?.ownerClerkId === subject && membership !== null;
}

export const registerClient = mutation({
  args: {
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    registrationSubject: v.string(),
  },
  handler: async (ctx, args) => {
    const registrationSubject = requireText(
      args.registrationSubject,
      "registrationSubject",
      160,
    );
    await consumeRateLimit(
      ctx,
      DCR_REGISTRATION_RULE,
      registrationSubject,
      "Too many OAuth client registrations; try again later",
    );
    const clientId = requireText(args.clientId, "clientId", 160);
    const clientName = requireText(args.clientName, "clientName", 120);
    const redirectUris = [...new Set(args.redirectUris)];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      redirectUris.some((uri) => !validRedirectUri(uri))
    ) {
      throw new ConvexError(
        "redirect_uris must contain 1-10 HTTPS URLs (localhost HTTP is allowed)",
      );
    }
    const existing = await ctx.db
      .query("oauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
      .unique();
    if (existing) throw new ConvexError("OAuth client already exists");
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName,
      redirectUris,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      createdAt: Date.now(),
    });
    return { clientId, clientName, redirectUris };
  },
});

export const authorizationRequest = query({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    scope: v.string(),
    resource: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
  },
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (
      !client ||
      !client.redirectUris.includes(args.redirectUri) ||
      args.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(args.codeChallenge)
    ) {
      throw new ConvexError("Invalid OAuth authorization request");
    }
    const parsedResource = requireOAuthResource(args.resource);
    const scopes = normalizeScopes(args.scope, parsedResource.kind);
    const identity = await requireIdentity(ctx);

    if (parsedResource.kind === "companyos") {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
        .take(MAX_AUTHORIZATION_CHOICES);
      const workspaces = (
        await Promise.all(
          memberships
            .filter((membership) => membership.role !== "member")
            .map(async (membership) => {
              const workspace = await ctx.db.get(membership.workspaceId);
              if (!workspace || workspace.suspendedAt !== undefined) return null;
              return {
                workspaceId: workspace._id,
                name: workspace.name,
                slug: workspace.slug,
                role: membership.role,
              };
            }),
        )
      ).filter((workspace) => workspace !== null);
      return {
        authorizationKind: "companyos" as const,
        clientName: client.clientName,
        scopes,
        resource: parsedResource.resource,
        agents: [],
        workspaces,
      };
    }

    const ownedWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerClerkId", identity.subject))
      .take(MAX_AUTHORIZATION_CHOICES);
    const workspaceIds = new Set(
      ownedWorkspaces.map((workspace) => workspace._id as string),
    );
    const agents = (
      await Promise.all([
        ctx.db
          .query("agents")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "user").eq("parentId", identity.subject),
          )
          .take(MAX_AUTHORIZATION_CHOICES),
        ...[...workspaceIds].map((workspaceId) =>
          ctx.db
            .query("agents")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "workspace").eq("parentId", workspaceId),
            )
            .take(MAX_AUTHORIZATION_CHOICES),
        ),
      ])
    )
      .flat()
      .filter((agent) => agent.status === "active");
    const workspaceNames = new Map(
      (
        await Promise.all(
          [...workspaceIds].map((workspaceId) =>
            ctx.db.get(workspaceId as Doc<"memberships">["workspaceId"]),
          ),
        )
      )
        .filter((workspace) => workspace !== null)
        .map((workspace) => [workspace._id as string, workspace.name]),
    );
    return {
      authorizationKind: "mcp" as const,
      clientName: client.clientName,
      scopes,
      resource: parsedResource.resource,
      agents: agents
        .slice(0, MAX_AUTHORIZATION_CHOICES)
        .map((agent) => ({
          agentId: agent._id,
          name: agent.name,
          scopeName:
            agent.parentType === "user"
              ? "Personal space"
              : (workspaceNames.get(agent.parentId) ?? "Workspace"),
          role: agent.role ?? "member",
        })),
      workspaces: [],
    };
  },
});

export const approveAuthorization = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    scope: v.string(),
    resource: v.string(),
    codeChallenge: v.string(),
    codeHash: v.string(),
    agentId: v.optional(v.id("agents")),
    workspaceId: v.optional(v.id("workspaces")),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (
      !client ||
      !client.redirectUris.includes(args.redirectUri) ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(args.codeChallenge)
    ) {
      throw new ConvexError("OAuth authorization is not allowed");
    }
    const parsedResource = requireOAuthResource(args.resource);
    const scopes = normalizeScopes(args.scope, parsedResource.kind);
    let agentId: Id<"agents"> | undefined;
    let workspaceId: Id<"workspaces"> | undefined;

    if (parsedResource.kind === "companyos") {
      if (!args.workspaceId || args.agentId) {
        throw new ConvexError("Choose one authorized Operate workspace");
      }
      const [workspace, membership] = await Promise.all([
        ctx.db.get(args.workspaceId),
        ctx.db
          .query("memberships")
          .withIndex("by_user_and_workspace", (q) =>
            q
              .eq("userClerkId", identity.subject)
              .eq("workspaceId", args.workspaceId!),
          )
          .unique(),
      ]);
      if (
        !workspace ||
        workspace.suspendedAt !== undefined ||
        !membership ||
        membership.role === "member"
      ) {
        throw new ConvexError(
          "Only an active workspace owner or admin can authorize Company OS",
        );
      }
      workspaceId = workspace._id;
    } else {
      if (!args.agentId || args.workspaceId) {
        throw new ConvexError("Choose one authorized Operate agent");
      }
      const agent = await ctx.db.get(args.agentId);
      if (
        !agent ||
        agent.status !== "active" ||
        !(await canUseAgent(ctx, agent, identity.subject))
      ) {
        throw new ConvexError("OAuth authorization is not allowed");
      }
      if (
        (agent.role ?? "member") === "readonly" &&
        scopes.includes("operate:write")
      ) {
        throw new ConvexError(
          "This agent is read-only and cannot grant operate:write",
        );
      }
      agentId = agent._id;
    }
    const codeHash = requireCredentialHash(args.codeHash, "codeHash");
    await ctx.db.insert("oauthAuthorizationCodes", {
      codeHash,
      clientId: client.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scopes,
      resource: parsedResource.resource,
      ...(agentId ? { agentId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      userClerkId: identity.subject,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      createdAt: Date.now(),
    });
    return { approved: true };
  },
});

export const exchangeAuthorizationCode = internalMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    accessTokenHash: v.string(),
    refreshTokenHash: v.string(),
    resource: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { resource } = requireOAuthResource(args.resource);
    const codeHash = requireCredentialHash(args.codeHash, "codeHash");
    const row = await ctx.db
      .query("oauthAuthorizationCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
      .unique();
    const requestMatches =
      row !== null &&
      row.clientId === args.clientId &&
      row.redirectUri === args.redirectUri &&
      oauthResourcesMatch(row.resource, resource) &&
      args.codeChallenge === row.codeChallenge;
    if (row?.usedAt !== undefined && requestMatches) {
      const grant = await ctx.db
        .query("oauthTokenGrants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", row.codeHash))
        .unique();
      // Exchanges issued by this implementation atomically create the grant
      // family and consume the code. A missing family is therefore corrupt or
      // predates this recovery contract, and must not be reported as cleaned.
      if (!grant) {
        throw new ConvexError("Invalid or expired authorization code");
      }
      if (grant.revokedAt === undefined) {
        await ctx.db.patch(grant._id, {
          revokedAt: now,
          updatedAt: now,
          revocationReason: "authorization_code_replay_recovery",
        });
      }
      if (row.workspaceId) {
        const installation = await ctx.db
          .query("companyOsInstallations")
          .withIndex("by_workspace_and_client_and_status", (q) =>
            q
              .eq("workspaceId", row.workspaceId!)
              .eq("oauthClientId", row.clientId)
              .eq("status", "active"),
          )
          .first();
        if (installation?.oauthGrantId === row.codeHash) {
          await ctx.db.patch(installation._id, {
            status: "disconnected",
            disconnectedAt: now,
            oauthRevokedBefore: now,
            updatedAt: now,
          });
        }
      }
      return {
        ok: false as const,
        replayDetected: true as const,
        grantRevoked: true as const,
        recoveryStatus: "authorization_code_replay_revoked" as const,
      };
    }
    if (
      !row ||
      row.usedAt !== undefined ||
      row.expiresAt <= now ||
      !requestMatches
    ) {
      throw new ConvexError("Invalid or expired authorization code");
    }
    if (row.workspaceId) {
      const bindings = await ctx.db
        .query("companyOsInstallations")
        .withIndex("by_workspace_and_client", (q) =>
          q
            .eq("workspaceId", row.workspaceId!)
            .eq("oauthClientId", row.clientId),
        )
        .take(2);
      if (bindings.length > 1) {
        throw new ConvexError("Invalid or expired authorization code");
      }
      const binding = bindings[0];
      if (
        binding?.oauthRevokedBefore !== undefined &&
        row.createdAt <= binding.oauthRevokedBefore
      ) {
        throw new ConvexError("Invalid or expired authorization code");
      }
    }
    const accessTokenHash = requireCredentialHash(
      args.accessTokenHash,
      "accessTokenHash",
    );
    const refreshTokenHash = requireCredentialHash(
      args.refreshTokenHash,
      "refreshTokenHash",
    );
    const grantId = row.codeHash;
    await ctx.db.patch(row._id, { usedAt: now });
    await ctx.db.insert("oauthTokenGrants", {
      grantId,
      clientId: row.clientId,
      resource,
      userClerkId: row.userClerkId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: accessTokenHash,
      refreshTokenHash,
      grantId,
      clientId: row.clientId,
      scopes: row.scopes,
      resource,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      userClerkId: row.userClerkId,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
    });
    return {
      ok: true as const,
      scope: row.scopes.join(" "),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
    };
  },
});

export const refreshAccessToken = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    clientId: v.string(),
    accessTokenHash: v.string(),
    nextRefreshTokenHash: v.string(),
    resource: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { resource } = requireOAuthResource(args.resource);
    const refreshTokenHash = requireCredentialHash(
      args.refreshTokenHash,
      "refreshTokenHash",
    );
    const accessTokenHash = requireCredentialHash(
      args.accessTokenHash,
      "accessTokenHash",
    );
    const nextRefreshTokenHash = requireCredentialHash(
      args.nextRefreshTokenHash,
      "nextRefreshTokenHash",
    );
    const current = await ctx.db
      .query("oauthAccessTokens")
      .withIndex("by_refresh_hash", (q) =>
        q.eq("refreshTokenHash", refreshTokenHash),
      )
      .unique();
    const metadataMatches =
      current?.clientId === args.clientId &&
      oauthResourcesMatch(current.resource, resource);
    if (
      current &&
      !current.grantId &&
      metadataMatches &&
      (await legacyAuthorityWasRevoked(ctx, current, resource))
    ) {
      throw new ConvexError("Invalid or expired refresh token");
    }
    if (current?.revokedAt !== undefined && metadataMatches) {
      const isTrackedReplay =
        current.grantId !== undefined && current.rotatedAt !== undefined;
      const isLegacyReplay = current.grantId === undefined;
      let trackedGrantWasFound = false;
      if (isTrackedReplay) {
        const grant = await ctx.db
          .query("oauthTokenGrants")
          .withIndex("by_grant_id", (q) => q.eq("grantId", current.grantId!))
          .unique();
        if (grant) {
          trackedGrantWasFound = true;
          if (grant.revokedAt === undefined) {
            await ctx.db.patch(grant._id, {
              revokedAt: now,
              updatedAt: now,
              revocationReason: "refresh_token_replay_recovery",
            });
          }
        }
      } else if (isLegacyReplay) {
        // Historical rotations did not retain a family id or rotatedAt. A
        // revoked legacy refresh presented with matching metadata is treated
        // as replay and installs a cutoff for its exact legacy authority.
        await revokeLegacyAuthority(ctx, current, resource, now);
      }
      if ((isTrackedReplay || isLegacyReplay) && current.workspaceId) {
        const installation = await ctx.db
          .query("companyOsInstallations")
          .withIndex("by_workspace_and_client_and_status", (q) =>
            q
              .eq("workspaceId", current.workspaceId!)
              .eq("oauthClientId", current.clientId)
              .eq("status", "active"),
          )
          .first();
        if (
          installation &&
          current.grantId &&
          installation.oauthGrantId === current.grantId
        ) {
          await ctx.db.patch(installation._id, {
            status: "disconnected",
            disconnectedAt: now,
            oauthRevokedBefore: now,
            updatedAt: now,
          });
        }
      }
      if (isTrackedReplay && trackedGrantWasFound) {
        return {
          ok: false as const,
          replayDetected: true as const,
          grantRevoked: true as const,
          recoveryStatus: "refresh_token_replay_revoked" as const,
          scope: current.scopes.join(" "),
        };
      }
      if (isLegacyReplay) {
        return { ok: false as const, replayDetected: true as const };
      }
    }
    if (
      !current ||
      current.revokedAt !== undefined ||
      current.refreshExpiresAt <= now ||
      !metadataMatches
    ) {
      throw new ConvexError("Invalid or expired refresh token");
    }
    if (current.workspaceId) {
      const bindings = await ctx.db
        .query("companyOsInstallations")
        .withIndex("by_workspace_and_client", (q) =>
          q
            .eq("workspaceId", current.workspaceId!)
            .eq("oauthClientId", current.clientId),
        )
        .take(2);
      if (bindings.length > 1) {
        return { ok: false as const, replayDetected: true as const };
      }
      const binding = bindings[0];
      if (
        binding?.oauthRevokedBefore !== undefined &&
        current.createdAt <= binding.oauthRevokedBefore
      ) {
        return { ok: false as const, replayDetected: true as const };
      }
    }
    let grantId = current.grantId;
    if (!grantId) {
      grantId = current._id;
      await ctx.db.insert("oauthTokenGrants", {
        grantId,
        clientId: current.clientId,
        resource,
        userClerkId: current.userClerkId,
        createdAt: current.createdAt,
        updatedAt: now,
      });
    } else {
      const grant = await ctx.db
        .query("oauthTokenGrants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", grantId!))
        .unique();
      if (!grant || grant.revokedAt !== undefined) {
        throw new ConvexError("Invalid or expired refresh token");
      }
    }
    await ctx.db.patch(current._id, { revokedAt: now, rotatedAt: now, grantId });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: accessTokenHash,
      refreshTokenHash: nextRefreshTokenHash,
      grantId,
      clientId: current.clientId,
      scopes: current.scopes,
      resource,
      ...(current.agentId ? { agentId: current.agentId } : {}),
      ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
      userClerkId: current.userClerkId,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
    });
    return {
      ok: true as const,
      scope: current.scopes.join(" "),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
    };
  },
});

export const revokeToken = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const hash = requireCredentialHash(args.tokenHash, "tokenHash");
    const row =
      (await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", hash))
        .unique()) ??
      (await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_refresh_hash", (q) => q.eq("refreshTokenHash", hash))
        .unique());
    if (row && row.revokedAt === undefined) {
      await ctx.db.patch(row._id, { revokedAt: now });
    }
    if (row?.grantId) {
      const grant = await ctx.db
        .query("oauthTokenGrants")
        .withIndex("by_grant_id", (q) => q.eq("grantId", row.grantId!))
        .unique();
      if (grant && grant.revokedAt === undefined) {
        await ctx.db.patch(grant._id, {
          revokedAt: now,
          updatedAt: now,
          revocationReason: "token_revoked",
        });
      }
    }
    if (row?.workspaceId) {
      const installation = await ctx.db
        .query("companyOsInstallations")
        .withIndex("by_workspace_and_client_and_status", (q) =>
          q
            .eq("workspaceId", row.workspaceId!)
            .eq("oauthClientId", row.clientId)
            .eq("status", "active"),
        )
        .first();
      if (
        installation &&
        row.grantId &&
        installation.oauthGrantId === row.grantId
      ) {
        await ctx.db.patch(installation._id, {
          status: "disconnected",
          disconnectedAt: now,
          oauthRevokedBefore: now,
          updatedAt: now,
        });
      }
    }
    return { revoked: true };
  },
});

// OIDC UserInfo for ChatGPT Enterprise workspace-domain restrictions. The
// signed Clerk webhook is the source of truth for whether the primary email
// is verified; an OAuth token alone is never enough to assert that claim.
export const userInfo = internalQuery({
  args: { accessTokenHash: v.string(), resource: v.string() },
  handler: async (ctx, args) => {
    const parsedResource = requireOAuthResource(args.resource);
    if (parsedResource.kind !== "mcp") {
      throw new ConvexError("UserInfo requires the Operate MCP resource");
    }
    const { key } = await requireAgentByKeyHash(
      ctx,
      requireCredentialHash(args.accessTokenHash, "accessTokenHash"),
      "read",
      parsedResource.resource,
    );
    if (!("clientId" in key)) {
      throw new ConvexError("UserInfo requires an OAuth access token");
    }
    if (!key.scopes.includes("openid") || !key.scopes.includes("email")) {
      throw new ConvexError("OAuth token is missing openid or email scope");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", key.userClerkId))
      .unique();
    if (!user?.email || user.emailVerified !== true) {
      throw new ConvexError("The account has no verified primary email");
    }
    return {
      subject: key.userClerkId,
      email: user.email,
      emailVerified: true as const,
      name: user.name,
    };
  },
});
