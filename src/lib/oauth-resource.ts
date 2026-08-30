/**
 * Canonical RFC 8707 audience for every Operate MCP profile.
 *
 * `?profile=chatgpt` and `?profile=claude` select presentation policy, not a
 * different protected resource. OpenAI sends the exact `resource` published
 * in protected-resource metadata, so tokens are bound to the stable endpoint
 * and cannot be replayed against another service.
 */
export function canonicalMcpResource(issuer: string) {
  return new URL("/api/mcp", issuer).toString();
}

/**
 * Dedicated OAuth audience for the read-only Company OS connector.
 *
 * This is deliberately distinct from /api/mcp. A Company OS sync token must
 * never inherit an agent's tool authority, and an MCP token must never be
 * accepted by the export surface.
 */
export function canonicalCompanyOsResource(issuer: string) {
  return new URL("/api/companyos", issuer).toString();
}

export type OAuthResourceKind = "mcp" | "companyos";

export function oauthResourceKind(
  resource: string,
  issuer: string,
): OAuthResourceKind {
  if (resource === canonicalMcpResource(issuer)) return "mcp";
  if (resource === canonicalCompanyOsResource(issuer)) return "companyos";
  throw new Error("resource must be a canonical Operate protected resource");
}

export function validateOAuthResource(
  candidate: string | null | undefined,
  issuer: string,
) {
  if (!candidate) return canonicalMcpResource(issuer);

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("resource must be a canonical Operate protected resource");
  }

  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("resource must be a canonical Operate protected resource");
  }

  const expectedOrigin = new URL(issuer);
  if (
    expectedOrigin.origin === "https://www.operate.to" &&
    url.protocol === "https:" &&
    url.hostname === "operate.to" &&
    url.port === ""
  ) {
    // Migration compatibility for grants minted before www became the single
    // non-redirecting production issuer. New metadata still advertises www.
    url.hostname = "www.operate.to";
  }

  const normalized = url.toString();
  oauthResourceKind(normalized, issuer);
  return normalized;
}

export function validateMcpResource(
  candidate: string | null | undefined,
  issuer: string,
) {
  const canonical = validateOAuthResource(candidate, issuer);
  if (oauthResourceKind(canonical, issuer) !== "mcp") {
    throw new Error("resource must be the canonical Operate MCP URL");
  }
  return canonical;
}
