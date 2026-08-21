import { officialAuthorizationServers } from "@/lib/oauth-resource";
import {
  OAUTH_SCOPES,
  oauthIssuer,
  oauthJson,
  oauthOptions,
  oauthResource,
} from "@/lib/oauth-server";

export function GET(request: Request) {
  const issuer = oauthIssuer(request);
  const authorizationServers = officialAuthorizationServers(issuer);
  return oauthJson(
    {
      resource: oauthResource(request),
      authorization_servers: authorizationServers,
      authorization_server: authorizationServers[0],
      scopes_supported: [...OAUTH_SCOPES],
      resource_documentation: `${issuer}/plugins`,
      bearer_methods_supported: ["header", "query"],
      token_types_supported: ["Bearer"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    200,
    undefined,
    request,
  );
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
