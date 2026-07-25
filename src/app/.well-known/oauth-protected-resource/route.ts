import { oauthIssuer, oauthJson } from "@/lib/oauth-server";

export function GET() {
  const issuer = oauthIssuer();
  return oauthJson({
    resource: `${issuer}/api/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["operate:read", "operate:write"],
    resource_documentation: `${issuer}/plugins`,
    bearer_methods_supported: ["header"],
  });
}
