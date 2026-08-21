import { officialAuthorizationServers } from "@/lib/oauth-resource";
import {
  OAUTH_SCOPES,
  oauthIssuer,
  oauthJson,
  oauthOptions,
  oauthResource,
} from "@/lib/oauth-server";

export function GET(request?: Request) {
  const issuer = oauthIssuer(request);
  return oauthJson({
    resource: oauthResource(request),
    authorization_servers: officialAuthorizationServers(issuer),
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: `${issuer}/plugins`,
    bearer_methods_supported: ["header"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export function OPTIONS() {
  return oauthOptions();
}
