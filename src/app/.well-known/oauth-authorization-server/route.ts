import { oauthIssuer, oauthJson } from "@/lib/oauth-server";

export function GET() {
  const issuer = oauthIssuer();
  return oauthJson({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    // RFC 8628 §4. How an agent runtime with no browser connects: it is the
    // flow `curl -fsSL /start` tells an agent to run, and advertising it
    // here is what lets a client discover it instead of being told.
    device_authorization_endpoint: `${issuer}/oauth/device`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["operate:read", "operate:write"],
  });
}
