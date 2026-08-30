import {
  COMPANY_OS_OAUTH_SCOPES,
  companyOsOAuthResource,
  oauthIssuer,
  oauthJson,
} from "@/lib/oauth-server";

export function GET() {
  const issuer = oauthIssuer();
  return oauthJson({
    resource: companyOsOAuthResource(),
    authorization_servers: [issuer],
    scopes_supported: [...COMPANY_OS_OAUTH_SCOPES],
    resource_documentation: `${issuer}/.well-known/companyos-connector`,
    bearer_methods_supported: ["header"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
