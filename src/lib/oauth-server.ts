import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import {
  canonicalCompanyOsResource,
  canonicalMcpResource,
} from "./oauth-resource";

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

export function normalizeOAuthIssuer(raw?: string) {
  const value = raw?.trim() || "https://www.operate.to";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be an absolute application origin");
  }
  const isLocal =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !isLocal) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("NEXT_PUBLIC_APP_URL must be an HTTPS application origin");
  }
  const host = url.hostname.toLowerCase();
  if (host === "operate.to" || host === "www.operate.to") {
    return "https://www.operate.to";
  }
  return url.origin;
}

export function oauthIssuer() {
  return normalizeOAuthIssuer(process.env.NEXT_PUBLIC_APP_URL);
}

export const MCP_OAUTH_SCOPES = [
  "openid",
  "email",
  "operate:read",
  "operate:write",
] as const;

export const COMPANY_OS_OAUTH_SCOPES = [
  "companyos:account:read",
  "companyos:data:read",
] as const;

export const OAUTH_SCOPES = [
  ...MCP_OAUTH_SCOPES,
  ...COMPANY_OS_OAUTH_SCOPES,
] as const;

export function oauthResource() {
  return canonicalMcpResource(oauthIssuer());
}

export function companyOsOAuthResource() {
  return canonicalCompanyOsResource(oauthIssuer());
}

export function oauthDiscoveryMetadata() {
  const issuer = oauthIssuer();
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

export function oauthConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

export function convexHttpActionOrigin() {
  const configured = process.env.CONVEX_SITE_URL?.trim();
  if (configured) return new URL(configured).origin;
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!cloud) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  const url = new URL(cloud);
  if (!url.hostname.endsWith(".convex.cloud")) {
    throw new Error("CONVEX_SITE_URL is required for this Convex deployment");
  }
  url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
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
