import {
  OAUTH_SCOPES,
  oauthIssuer,
  oauthJson,
  oauthResource,
} from "@/lib/oauth-server";

export function GET() {
  const issuer = oauthIssuer();
  return oauthJson({
    resource: oauthResource(),
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: `${issuer}/plugins`,
    bearer_methods_supported: ["header"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
