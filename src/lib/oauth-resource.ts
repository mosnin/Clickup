/**
 * Canonical RFC 8707 audience for every Operate MCP profile.
 *
 * `?profile=chatgpt` and `?profile=claude` select presentation policy, not a
 * different protected resource. Production serves on www; the apex host
 * 308-redirects there. Both hostnames are one audience. Unofficial hosts are
 * refused so a token cannot be bound to an attacker-controlled resource and
 * then replayed against Convex.
 */
import {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  discoveryIssuer,
  isOfficialMcpResource,
  normalizeOfficialMcpResource,
  officialAuthorizationServers,
  sameMcpResource,
} from "@convex/_oauthResource";

export {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  discoveryIssuer,
  isOfficialMcpResource,
  officialAuthorizationServers,
  sameMcpResource,
};

export function canonicalMcpResource(issuer: string) {
  return new URL("/api/mcp", issuer).toString();
}

export function validateMcpResource(
  candidate: string | null | undefined,
  issuer: string,
) {
  if (!candidate) {
    try {
      return normalizeOfficialMcpResource(canonicalMcpResource(issuer));
    } catch {
      return CANONICAL_PRODUCTION_MCP_RESOURCE;
    }
  }
  return normalizeOfficialMcpResource(candidate);
}
