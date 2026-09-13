/**
 * Canonical RFC 8707 audience for every Operate MCP profile.
 *
 * Known `profile` values select presentation policy, not a
 * different protected resource. Clients may send the connection URL or the metadata resource. Both
 * normalize to the stable endpoint, so tokens are bound to that audience
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
  // Codex may send the connection URL rather than the metadata's canonical
  // resource. Only known catalog profiles identify this same protected API.
  const profile = url.searchParams.get("profile");
  const knownProfile = url.searchParams.size === 1 && url.searchParams.getAll("profile").length === 1 && ["chatgpt", "claude", "codex"].includes(profile ?? "");
  const operateHosts = new Set(["operate.to", "www.operate.to"]);
  const canonicalHostAlias = operateHosts.has(url.hostname) && operateHosts.has(expected.hostname) && !url.port && !expected.port && url.protocol === expected.protocol;
  if (
    (url.origin !== expected.origin && !canonicalHostAlias) ||
    url.pathname !== expected.pathname ||
    (url.search !== "" && !knownProfile) ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("resource must be the canonical Operate MCP URL");
  }
  return canonical;
}
