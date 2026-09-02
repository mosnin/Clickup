import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { canonicalMcpResource } from "./oauth-resource";

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

export function oauthIssuer() {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "https://operate.to"
  );
}

export const OAUTH_SCOPES = [
  "openid",
  "email",
  "operate:read",
  "operate:write",
] as const;

export function oauthResource() {
  return canonicalMcpResource(oauthIssuer());
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
    // RFC 8414 lists this beside the endpoint it describes, and a client
    // that reads the revocation endpoint out of this document has no other
    // way to learn it takes no client authentication.
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    subject_types_supported: ["public"],
    // org_id and org_name are the tenant claims /oauth/userinfo returns for
    // a token bound to a workspace agent. Advertised because a claim a
    // client cannot discover is a claim it will not ask for.
    claims_supported: [
      "sub",
      "email",
      "email_verified",
      "name",
      "org_id",
      "org_name",
    ],
    resource_parameter_supported: true,
    // RFC 9207. The authorize page echoes `iss` on both the success and the
    // deny redirect, so a client holding several connections can tell which
    // server answered before it spends its code at the wrong token endpoint.
    authorization_response_iss_parameter_supported: true,
  };
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
