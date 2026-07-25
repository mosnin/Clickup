import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { sha256Hex } from "./_agentAuth";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
const ALLOWED_SCOPES = new Set(["operate:read", "operate:write"]);
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function requireText(value: string, field: string, max: number) {
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new ConvexError(`${field} must be 1-${max} characters`);
  }
  return clean;
}

function normalizeScopes(scope: string) {
  const scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) scopes.push("operate:read");
  for (const item of scopes) {
    if (!ALLOWED_SCOPES.has(item)) {
      throw new ConvexError(`Unsupported OAuth scope: ${item}`);
    }
  }
  if (scopes.includes("operate:write") && !scopes.includes("operate:read")) {
    scopes.unshift("operate:read");
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

function pkceChallenge(verifier: string) {
  return hexToBase64Url(sha256Hex(verifier));
}

async function canUseAgent(
  ctx: Parameters<typeof requireIdentity>[0],
  agent: Doc<"agents">,
  subject: string,
) {
  if (agent.parentType === "user") return agent.parentId === subject;
  return (
    (await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", subject)
          .eq("workspaceId", agent.parentId as Id<"workspaces">),
      )
      .unique()) !== null
  );
}

export const registerClient = mutation({
  args: {
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
  },
  handler: async (ctx, args) => {
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
    const scopes = normalizeScopes(args.scope);
    const identity = await requireIdentity(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    const workspaceIds = new Set(
      memberships.map((membership) => membership.workspaceId as string),
    );
    const agents = (
      await Promise.all([
        ctx.db
          .query("agents")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "user").eq("parentId", identity.subject),
          )
          .collect(),
        ...[...workspaceIds].map((workspaceId) =>
          ctx.db
            .query("agents")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "workspace").eq("parentId", workspaceId),
            )
            .collect(),
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
      clientName: client.clientName,
      scopes,
      agents: agents.map((agent) => ({
        agentId: agent._id,
        name: agent.name,
        scopeName:
          agent.parentType === "user"
            ? "Personal space"
            : (workspaceNames.get(agent.parentId) ?? "Workspace"),
        role: agent.role ?? "member",
      })),
    };
  },
});

export const approveAuthorization = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    scope: v.string(),
    codeChallenge: v.string(),
    code: v.string(),
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const client = await ctx.db
      .query("oauthClients")
      .withIndex("by_client_id", (q) => q.eq("clientId", args.clientId))
      .unique();
    const agent = await ctx.db.get(args.agentId);
    if (
      !client ||
      !client.redirectUris.includes(args.redirectUri) ||
      !agent ||
      agent.status !== "active" ||
      !(await canUseAgent(ctx, agent, identity.subject))
    ) {
      throw new ConvexError("OAuth authorization is not allowed");
    }
    const scopes = normalizeScopes(args.scope);
    if (
      (agent.role ?? "member") === "readonly" &&
      scopes.includes("operate:write")
    ) {
      throw new ConvexError(
        "This agent is read-only and cannot grant operate:write",
      );
    }
    const code = requireText(args.code, "code", 240);
    await ctx.db.insert("oauthAuthorizationCodes", {
      codeHash: sha256Hex(code),
      clientId: client.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scopes,
      agentId: agent._id,
      userClerkId: identity.subject,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      createdAt: Date.now(),
    });
    return { approved: true };
  },
});

export const exchangeAuthorizationCode = mutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeVerifier: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("oauthAuthorizationCodes")
      .withIndex("by_code_hash", (q) =>
        q.eq("codeHash", sha256Hex(args.code)),
      )
      .unique();
    if (
      !row ||
      row.usedAt !== undefined ||
      row.expiresAt <= now ||
      row.clientId !== args.clientId ||
      row.redirectUri !== args.redirectUri ||
      pkceChallenge(args.codeVerifier) !== row.codeChallenge
    ) {
      throw new ConvexError("Invalid or expired authorization code");
    }
    await ctx.db.patch(row._id, { usedAt: now });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: sha256Hex(args.accessToken),
      refreshTokenHash: sha256Hex(args.refreshToken),
      clientId: row.clientId,
      scopes: row.scopes,
      agentId: row.agentId,
      userClerkId: row.userClerkId,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
    });
    return {
      scope: row.scopes.join(" "),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
    };
  },
});

export const refreshAccessToken = mutation({
  args: {
    refreshToken: v.string(),
    clientId: v.string(),
    accessToken: v.string(),
    nextRefreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const current = await ctx.db
      .query("oauthAccessTokens")
      .withIndex("by_refresh_hash", (q) =>
        q.eq("refreshTokenHash", sha256Hex(args.refreshToken)),
      )
      .unique();
    if (
      !current ||
      current.revokedAt !== undefined ||
      current.refreshExpiresAt <= now ||
      current.clientId !== args.clientId
    ) {
      throw new ConvexError("Invalid or expired refresh token");
    }
    await ctx.db.patch(current._id, { revokedAt: now });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: sha256Hex(args.accessToken),
      refreshTokenHash: sha256Hex(args.nextRefreshToken),
      clientId: current.clientId,
      scopes: current.scopes,
      agentId: current.agentId,
      userClerkId: current.userClerkId,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
    });
    return {
      scope: current.scopes.join(" "),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
    };
  },
});

export const revokeToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const hash = sha256Hex(token);
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
      await ctx.db.patch(row._id, { revokedAt: Date.now() });
    }
    return { revoked: true };
  },
});
