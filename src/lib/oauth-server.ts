import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  discoveryIssuer,
  servingMcpUrl,
  servingOrigin,
  validateMcpResource,
} from "./oauth-resource";

export { servingMcpUrl, servingOrigin };

// RFC 8628 §3.4. Lives here rather than beside the handler that reads it,
// because a Next route file may only export HTTP handlers and the documented
// config values — an extra export fails the build.
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// The state Convex reports → the error code RFC 8628 §3.5 defines.
//
// Pure, and separated from the handler, because this mapping is the entire
// contract a polling agent codes against: every agent runtime that already
// speaks the device grant branches on these exact strings, so getting one
// wrong turns a working connection into a runtime that gives up or spins.
// Returning `null` means "not an error" — the key is issued.
export type DeviceClaimState =
  | "pending"
  | "approved"
  | "denied"
  | "claimed"
  | "expired"
  | "not_found";

export function deviceErrorCode(
  state: DeviceClaimState,
  slowDown = false,
): string | null {
  switch (state) {
    case "approved":
      return null;
    // slow_down is not advice: by the time it is returned, the interval the
    // client must respect has already grown server-side.
    case "pending":
      return slowDown ? "slow_down" : "authorization_pending";
    case "denied":
      return "access_denied";
    case "expired":
      return "expired_token";
    // A replayed device code gets invalid_grant rather than a second key,
    // and an unknown one is answered identically so nobody can probe for
    // live codes.
    case "claimed":
    case "not_found":
      return "invalid_grant";
  }
}

export function oauthIssuer(request?: Request) {
  return discoveryIssuer(
    request?.url,
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, ""),
  );
}

export function mcpWwwAuthenticate(request: Request) {
  const origin = oauthIssuer(request);
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="operate:read"`;
}

export const OAUTH_SCOPES = [
  "openid",
  "email",
  "operate:read",
  "operate:write",
] as const;

export function oauthResource(request?: Request) {
  try {
    return validateMcpResource(undefined, oauthIssuer(request));
  } catch {
    return CANONICAL_PRODUCTION_MCP_RESOURCE;
  }
}

export function oauthDiscoveryMetadata(request?: Request) {
  const issuer = oauthIssuer(request);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    device_authorization_endpoint: `${issuer}/oauth/device`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      DEVICE_GRANT,
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    subject_types_supported: ["public"],
    claims_supported: ["sub", "email", "email_verified", "name"],
    resource_parameter_supported: true,
  };
}

/**
 * Token, device, and revoke all accept JSON or form bodies. An agent
 * hand-rolling curl reaches for JSON, often with no Content-Type, a
 * UTF-8 BOM, or `Content-Type: application/json` around a form body.
 * One text parse: strip a BOM, try JSON if labelled or the body starts
 * with `{`, otherwise application/x-www-form-urlencoded. A failed JSON
 * parse falls through to form — labelled-JSON + `token=…` used to
 * return empty and skip revoke.
 */
export async function oauthFields(
  request: Request,
): Promise<(name: string) => string> {
  const contentType = request.headers.get("content-type") ?? "";
  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  const labelledJson = contentType.includes("application/json");
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (labelledJson || looksJson) {
    try {
      const body = JSON.parse(trimmed) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        return (name) => {
          const value = record[name];
          if (value === undefined || value === null) return "";
          return typeof value === "string" ? value : String(value);
        };
      }
    } catch {
      // Fall through: a JSON Content-Type is sometimes wrapped around
      // an RFC form body.
    }
  }
  const params = new URLSearchParams(trimmed);
  return (name) => params.get(name) ?? "";
}

/** DCR (RFC 7591) is JSON. Strip a BOM so request.json() is not the only path. */
export async function oauthJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "").trim();
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Caller maps null to invalid_client_metadata.
  }
  return null;
}

export function oauthConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

export function randomCredential(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function oauthJson(
  body: Record<string, unknown>,
  status = 200,
) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

export function oauthError(
  error: string,
  description: string,
  status = 400,
) {
  return oauthJson({ error, error_description: description }, status);
}
