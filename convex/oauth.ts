import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { requireAgentByKey, sha256Hex } from "./_agentAuth";
import {
  consumeRateLimit,
  DCR_REGISTRATION_RULE,
} from "./_rateLimit";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
const ALLOWED_SCOPES = new Set([
  "openid",
  "email",
  "operate:read",
  "operate:write",
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
  if (scopes.includes("email") && !scopes.includes("openid")) {
    scopes.unshift("openid");
  }
  return scopes;
}

function requireMcpResource(value: string) {
  const clean = requireText(value, "resource", 2048);
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    throw new ConvexError("resource must be the canonical MCP HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/api/mcp" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConvexError("resource must be the canonical MCP HTTPS URL");
  }
  return url.toString();
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

// RFC 7636 §4.1: the verifier is 43 to 128 characters of the unreserved set.
// Checked before it is hashed, so a malformed verifier is refused on its
// shape rather than on a comparison it was never going to win.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

// Timing-safe string comparison.
//
// node's timingSafeEqual is not available in the Convex isolate, so this is
// the same idea by hand: fold every difference into one accumulator and
// always walk the longer of the two strings, so the work done depends on the
// lengths and never on where the first differing character sits. Comparing
// PKCE challenges with `!==` leaks that position to anyone who can time the
// token endpoint, which is the one comparison in this file an attacker gets
// to repeat at will.
function timingSafeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    // charCodeAt past the end is NaN, and `| 0` turns that into a stable 0
    // rather than letting the loop exit early on the shorter string.
    diff |= (a.charCodeAt(index) | 0) ^ (b.charCodeAt(index) | 0);
  }
  return diff === 0;
}

// The grant family an authorization code opens. Derived from the code rather
// than stored alongside it, so the identifier exists before the first token
// does and every rotation can carry the same one.
function grantIdFor(code: string) {
  return sha256Hex(`grant:${code}`);
}

// Revoke every token ever minted under one grant.
//
// This is the response to a replay, not to an ordinary failure. A code
// presented twice or a rotated refresh token presented again means either
// the client is broken or somebody else has a copy, and there is no way to
// tell which from here, so the grant dies and the person reconnects. RFC
// 6749 §10.5 and OAuth 2.1 §4.3.1 both ask for exactly this.
//
// `grantId` is optional on the row because tokens issued before the field
// existed have none. Called with no grant id, this revokes only the row it
// was handed, which is what the server did before this function existed. A
// legacy authorization code has no row to hand over, so replaying one of
// those in the ten minutes after a deploy revokes nothing; the alternative
// is a table scan on every replay, and the window closes by itself.
async function revokeGrantFamily(
  ctx: MutationCtx,
  grantId: string | undefined,
  fallback?: Id<"oauthAccessTokens">,
) {
  const now = Date.now();
  if (!grantId) {
    if (!fallback) return 0;
    const row = await ctx.db.get(fallback);
    if (row && row.revokedAt === undefined) {
      await ctx.db.patch(fallback, { revokedAt: now });
      return 1;
    }
    return 0;
  }
  const family = await ctx.db
    .query("oauthAccessTokens")
    .withIndex("by_grant", (q) => q.eq("grantId", grantId))
    .collect();
  let revoked = 0;
  for (const row of family) {
    if (row.revokedAt !== undefined) continue;
    await ctx.db.patch(row._id, { revokedAt: now });
    revoked += 1;
  }
  return revoked;
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
      !CODE_CHALLENGE.test(args.codeChallenge)
    ) {
      throw new ConvexError("Invalid OAuth authorization request");
    }
    const scopes = normalizeScopes(args.scope);
    const resource = requireMcpResource(args.resource);
    const identity = await requireIdentity(ctx);
    const ownedWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerClerkId", identity.subject))
      .collect();
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
      resource,
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
    resource: v.string(),
    codeChallenge: v.string(),
    // Required, and required to be S256.
    //
    // The query that renders the consent screen already refuses anything
    // else, but the query is not what mints a code: this mutation is, and a
    // caller that skipped straight to it used to be able to bind a `plain`
    // challenge. That code was unredeemable (the token endpoint only ever
    // hashes), so this closes a dead end rather than a hole, but a dead end
    // that answers "approved" is worse than one that answers "no".
    codeChallengeMethod: v.string(),
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
      args.codeChallengeMethod !== "S256" ||
      !CODE_CHALLENGE.test(args.codeChallenge) ||
      !agent ||
      agent.status !== "active" ||
      !(await canUseAgent(ctx, agent, identity.subject))
    ) {
      throw new ConvexError("OAuth authorization is not allowed");
    }
    const scopes = normalizeScopes(args.scope);
    const resource = requireMcpResource(args.resource);
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
      grantId: grantIdFor(code),
      clientId: client.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scopes,
      resource,
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
    resource: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const resource = requireMcpResource(args.resource);
    const row = await ctx.db
      .query("oauthAuthorizationCodes")
      .withIndex("by_code_hash", (q) =>
        q.eq("codeHash", sha256Hex(args.code)),
      )
      .unique();
    // A code presented a second time is a security event, not a mistake.
    // Either the client is retrying a request whose answer it lost, or the
    // code leaked and somebody beat the real client to it, and nothing
    // visible here tells the two apart. So the whole grant dies: every token
    // the first exchange minted is revoked, and the person reconnects.
    //
    // Returned rather than thrown, because a Convex mutation that throws
    // rolls back everything it wrote, including the revocation, which is
    // the entire point of noticing. The token endpoint turns this verdict
    // into the 400 invalid_grant the client sees.
    if (row && row.usedAt !== undefined) {
      const revoked = await revokeGrantFamily(
        ctx,
        row.grantId ?? grantIdFor(args.code),
      );
      return {
        ok: false as const,
        error: "invalid_grant" as const,
        reason: "authorization_code_replay" as const,
        revoked,
      };
    }
    if (
      !row ||
      row.expiresAt <= now ||
      row.clientId !== args.clientId ||
      row.redirectUri !== args.redirectUri ||
      row.resource !== resource ||
      !CODE_VERIFIER.test(args.codeVerifier) ||
      !timingSafeEqual(pkceChallenge(args.codeVerifier), row.codeChallenge)
    ) {
      throw new ConvexError("Invalid or expired authorization code");
    }
    await ctx.db.patch(row._id, { usedAt: now });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: sha256Hex(args.accessToken),
      refreshTokenHash: sha256Hex(args.refreshToken),
      clientId: row.clientId,
      scopes: row.scopes,
      resource,
      grantId: row.grantId,
      agentId: row.agentId,
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

export const refreshAccessToken = mutation({
  args: {
    refreshToken: v.string(),
    clientId: v.string(),
    accessToken: v.string(),
    nextRefreshToken: v.string(),
    resource: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const resource = requireMcpResource(args.resource);
    const current = await ctx.db
      .query("oauthAccessTokens")
      .withIndex("by_refresh_hash", (q) =>
        q.eq("refreshTokenHash", sha256Hex(args.refreshToken)),
      )
      .unique();
    // The other half of replay detection. Refresh tokens rotate on every
    // use, so a row that still exists but is already revoked means this
    // token was spent once before. Rotation alone cannot tell a theft from a
    // retry; rotation PLUS killing the family on reuse can, because whoever
    // holds the stolen copy and whoever holds the real one both lose access
    // and exactly one of them notices legitimately.
    if (current && current.revokedAt !== undefined) {
      const revoked = await revokeGrantFamily(
        ctx,
        current.grantId,
        current._id,
      );
      return {
        ok: false as const,
        error: "invalid_grant" as const,
        reason: "refresh_token_replay" as const,
        revoked,
      };
    }
    if (
      !current ||
      current.refreshExpiresAt <= now ||
      current.clientId !== args.clientId ||
      current.resource !== resource
    ) {
      throw new ConvexError("Invalid or expired refresh token");
    }
    await ctx.db.patch(current._id, { revokedAt: now });
    await ctx.db.insert("oauthAccessTokens", {
      tokenHash: sha256Hex(args.accessToken),
      refreshTokenHash: sha256Hex(args.nextRefreshToken),
      clientId: current.clientId,
      scopes: current.scopes,
      resource,
      grantId: current.grantId,
      agentId: current.agentId,
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

// RFC 7009. Revoking one token revokes the grant it belongs to.
//
// The RFC's own words are that the server SHOULD invalidate the other tokens
// based on the same grant, and it is what a person means by "disconnect":
// leaving the paired access token alive for its last hour after somebody
// revoked the refresh token would be a surprise, not a feature. Answering
// the same `{ revoked: true }` for a token that never existed is deliberate,
// so the endpoint above it can always answer 200 without branching.
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
    if (row) await revokeGrantFamily(ctx, row.grantId, row._id);
    return { revoked: true };
  },
});

// OIDC UserInfo for ChatGPT Enterprise workspace-domain restrictions. The
// signed Clerk webhook is the source of truth for whether the primary email
// is verified; an OAuth token alone is never enough to assert that claim.
//
// Operate is multi tenant, so the answer also says WHICH tenant this token
// speaks for: a person can own several workspaces, and "who is this" without
// "where" is not enough for a client that has to decide what the token may
// see. The tenant is the token's agent's workspace, not the person's
// favourite one, because that is what the grant was actually bound to. A
// token bound to a personal-space agent has no organization and reports
// none rather than inventing one.
export const userInfo = query({
  args: { accessToken: v.string(), resource: v.string() },
  handler: async (ctx, args) => {
    const resource = requireMcpResource(args.resource);
    const { agent, key } = await requireAgentByKey(
      ctx,
      args.accessToken,
      "read",
      resource,
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
    const workspace =
      agent.parentType === "workspace"
        ? await ctx.db.get(agent.parentId as Id<"workspaces">)
        : null;
    return {
      subject: key.userClerkId,
      email: user.email,
      emailVerified: true as const,
      name: user.name,
      organizationId: workspace ? (workspace._id as string) : undefined,
      organizationName: workspace ? workspace.name : undefined,
    };
  },
});
