/**
 * Official Operate MCP audiences and host aliases.
 *
 * Production answers on `www.operate.to`. The apex host 308-redirects there,
 * including POST /oauth/token and POST /api/mcp, so a client that treats
 * `https://operate.to` and `https://www.operate.to` as different resources
 * cannot complete OAuth. These two origins are one protected resource.
 *
 * Convex mutations are publicly callable. Audience checks therefore live
 * here — not only in the Next.js token route — and unofficial hosts such as
 * `https://attacker.example/api/mcp` are refused on every write.
 */

export const CANONICAL_PRODUCTION_ORIGIN = "https://operate.to";
export const SERVING_PRODUCTION_ORIGIN = "https://www.operate.to";
export const CANONICAL_PRODUCTION_MCP_RESOURCE = `${CANONICAL_PRODUCTION_ORIGIN}/api/mcp`;

const PRODUCTION_HOSTS = new Set(["operate.to", "www.operate.to"]);

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function productionAlias(hostname: string) {
  const host = hostname.toLowerCase();
  if (PRODUCTION_HOSTS.has(host)) return "operate.to";
  return host;
}

export function isOfficialOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.username !== "" || url.password !== "") return false;
    if (isLoopbackHost(url.hostname)) {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    return url.protocol === "https:" && PRODUCTION_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseOfficialMcpResource(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const officialHost =
    isLoopbackHost(url.hostname) ||
    PRODUCTION_HOSTS.has(url.hostname.toLowerCase());
  const officialProtocol = isLoopbackHost(url.hostname)
    ? url.protocol === "http:" || url.protocol === "https:"
    : url.protocol === "https:";
  if (
    !officialHost ||
    !officialProtocol ||
    url.pathname !== "/api/mcp" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url;
}

export function isOfficialMcpResource(value: string | undefined) {
  return value !== undefined && parseOfficialMcpResource(value) !== null;
}

export function sameMcpResource(left: string, right: string) {
  const a = parseOfficialMcpResource(left);
  const b = parseOfficialMcpResource(right);
  if (!a || !b) return false;
  if (productionAlias(a.hostname) !== productionAlias(b.hostname)) return false;
  if (PRODUCTION_HOSTS.has(a.hostname.toLowerCase())) return true;
  return a.port === b.port && a.protocol === b.protocol;
}

export function normalizeOfficialMcpResource(value: string) {
  const url = parseOfficialMcpResource(value);
  if (!url) {
    throw new Error("resource must be an official Operate MCP URL");
  }
  if (PRODUCTION_HOSTS.has(url.hostname.toLowerCase())) {
    return CANONICAL_PRODUCTION_MCP_RESOURCE;
  }
  return url.toString();
}

export function discoveryIssuer(
  requestUrl?: string,
  configuredIssuer?: string,
) {
  if (requestUrl) {
    try {
      const origin = new URL(requestUrl).origin;
      if (isOfficialOrigin(origin)) return origin;
    } catch {
      // Fall through to the configured issuer.
    }
  }
  if (configuredIssuer) {
    const clean = configuredIssuer.replace(/\/$/, "");
    if (isOfficialOrigin(clean)) return clean;
  }
  return SERVING_PRODUCTION_ORIGIN;
}

export function officialAuthorizationServers(preferredIssuer: string) {
  const preferred = preferredIssuer.replace(/\/$/, "");
  if (!isOfficialOrigin(preferred) || isLoopbackHost(new URL(preferred).hostname)) {
    return [preferred];
  }
  const aliases = [SERVING_PRODUCTION_ORIGIN, CANONICAL_PRODUCTION_ORIGIN];
  return [preferred, ...aliases.filter((origin) => origin !== preferred)];
}
