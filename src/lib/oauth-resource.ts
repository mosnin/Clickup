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

export function validateMcpResource(
  candidate: string | null | undefined,
  issuer: string,
) {
  const canonical = canonicalMcpResource(issuer);
  if (!candidate) return canonical;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("resource must be the canonical Operate MCP URL");
  }

  const expected = new URL(canonical);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("resource must be the canonical Operate MCP URL");
  }
  return canonical;
}
