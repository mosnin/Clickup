import { createHash, randomBytes } from "node:crypto";
import { api } from "@convex/_generated/api";
import {
  DEVICE_GRANT,
  inferGrantType,
  deviceErrorCode,
  oauthBasicClientId,
  oauthConvexClient,
  oauthError,
  oauthFields,
  oauthOptions,
  oauthPostOnly,
  oauthIssuer,
  oauthJson,
  randomCredential,
  servingMcpUrl,
} from "@/lib/oauth-server";
import { validateMcpResource } from "@/lib/oauth-resource";

// What to tell the agent alongside each RFC error code. The code is what a
// runtime branches on; this is what a person reads in a log when their agent
// stopped and they want to know why.
const DEVICE_ERROR_HELP: Record<string, (interval?: number) => string> = {
  authorization_pending: () =>
    "Waiting for a human to approve this request at /link",
  slow_down: (interval) =>
    `Polling too fast. Wait ${interval ?? 5}s between requests.`,
  access_denied: () => "The request was declined",
  expired_token: () => "This code expired. Start again to get a new one.",
  invalid_grant: () => "Unknown or already-used device code",
};

// RFC 8628 §3.5 — the device grant's half of the token endpoint.
//
// Unlike the authorization-code grant above, this one issues an agent API
// key (`cua_…`) rather than an OAuth access token, because that is the
// credential /api/mcp and every function in agentApi.ts actually accept. It
// is minted HERE and only its hash crosses into Convex, so the plaintext
// never exists in the database at any point — not even for the ten minutes
// between a human approving and the poller collecting.
async function deviceGrant(deviceCode: string, request: Request) {
  if (!deviceCode) {
    return oauthError("invalid_request", "device_code is required", 400, request);
  }
  // Generated before the call because the mutation stores the hash and
  // returns nothing that could reconstruct it.
  const key = `cua_${randomBytes(24).toString("hex")}`;
  const result = await oauthConvexClient().mutation(
    api.agentAuth.claimDeviceRequest,
    {
      deviceCode,
      keyHash: createHash("sha256").update(key).digest("hex"),
      keyPrefix: key.slice(0, 12),
    },
  );

  // The mapping itself lives in oauth-server.ts so it can be tested without
  // a Convex deployment — see tests/agent-device-http.test.ts.
  const error = deviceErrorCode(result.state, result.slowDown);
  if (error) {
    return oauthError(error, DEVICE_ERROR_HELP[error](result.interval), 400);
  }

  const issuer = oauthIssuer(request);
  return oauthJson(
    {
      // RFC 8628 §3.5 / RFC 6749 §5.1 require access_token. api_key is the
      // same cua_ value for scripts that already read that field. There is
      // still no refresh token; expires_in is the 90-day device-key TTL.
      access_token: key,
      api_key: key,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      agent_id: result.agentId,
      agent_name: result.agentName,
      agent_created: result.agentCreated,
      scope_name: result.scopeName,
      mcp_url: servingMcpUrl(issuer),
      manifest_url: `${issuer}/api/agent/manifest`,
    },
    200,
    undefined,
    request,
  );
}

export async function POST(request: Request) {
  // RFC 8628 posts form-encoded; an agent hand-rolling this with curl will
  // reach for JSON. Accept both — see /oauth/device for the same reasoning.
  const field = await oauthFields(request);

  const grantType = inferGrantType(field);
  // Checked before client_id, because the device grant has no registered
  // client to identify: the device code IS the credential.
  if (grantType === DEVICE_GRANT) {
    try {
      return await deviceGrant(field("device_code"), request);
    } catch (error) {
      return oauthError(
        "invalid_grant",
        error instanceof Error ? error.message : "Device grant failed",
        400,
        request,
      );
    }
  }

  const clientId = field("client_id") || oauthBasicClientId(request);
  if (!clientId) {
    return oauthError("invalid_client", "client_id is required", 401, request);
  }
  const accessToken = randomCredential("opa");
  const refreshToken = randomCredential("opr");
  // Empty resource defaults to the official audience. Clients that omit
  // RFC 8707 `resource` (they already fetched PRM) used to 400 here
  // after a successful body parse.
  const rawResource = field("resource") || field("audience") || undefined;
  let resource: string;
  try {
    resource = validateMcpResource(rawResource, oauthIssuer(request));
  } catch (error) {
    return oauthError(
      "invalid_target",
      error instanceof Error ? error.message : "Invalid resource",
      400,
      request,
    );
  }
  try {
    if (grantType === "authorization_code") {
      const code = field("code");
      const redirectUri = field("redirect_uri");
      const codeVerifier = field("code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError(
          "invalid_request",
          "code, redirect_uri, and code_verifier are required",
          400,
          request,
        );
      }
      const result = await oauthConvexClient().mutation(
        api.oauth.exchangeAuthorizationCode,
        {
          code,
          clientId,
          redirectUri,
          codeVerifier,
          accessToken,
          refreshToken,
          resource,
        },
      );
      return oauthJson(
        {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: refreshToken,
          scope: result.scope,
        },
        200,
        undefined,
        request,
      );
    }
    if (grantType === "refresh_token") {
      const currentRefreshToken = field("refresh_token");
      if (!currentRefreshToken) {
        return oauthError(
          "invalid_request",
          "refresh_token is required",
          400,
          request,
        );
      }
      const result = await oauthConvexClient().mutation(
        api.oauth.refreshAccessToken,
        {
          refreshToken: currentRefreshToken,
          clientId,
          accessToken,
          nextRefreshToken: refreshToken,
          resource,
        },
      );
      if (!result.ok) {
        return oauthError("invalid_grant", result.error, 400, request);
      }
      return oauthJson(
        {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: refreshToken,
          scope: result.scope,
        },
        200,
        undefined,
        request,
      );
    }
    return oauthError(
      "unsupported_grant_type",
      "Unsupported grant_type",
      400,
      request,
    );
  } catch (error) {
    return oauthError(
      "invalid_grant",
      error instanceof Error ? error.message : "Token grant failed",
      400,
      request,
    );
  }
}

export function GET(request: Request) {
  return oauthPostOnly(request);
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
