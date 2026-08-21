/**
 * Next/Vercel 308s `/oauth/token/` → `/oauth/token`. Many OAuth clients
 * drop the POST body on 308 (same class as the apex host redirect).
 * `skipTrailingSlashRedirect` stops that 308; without a rewrite the
 * slashed URL 404s (`/link/`, `/api/x402/`, doubled slashes).
 *
 * Machine paths rewrite without Clerk (token/MCP must not go through
 * JWT middleware). Human paths (`/oauth/authorize`, `/link`) rewrite
 * *after* Clerk so `auth()` still sees the session.
 *
 * Never `/dashboard/` — a rewrite that skipped Clerk would skip
 * `auth.protect()`.
 *
 * Lives in its own module so Edge middleware does not import
 * `oauth-server.ts` (`node:crypto` / Convex).
 */
export function isMachineOAuthPath(pathname: string) {
  return (
    pathname === "/oauth/token" ||
    pathname === "/oauth/device" ||
    pathname === "/oauth/revoke" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/userinfo" ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname === "/api/x402" ||
    pathname.startsWith("/api/x402/") ||
    pathname === "/api/agent" ||
    pathname.startsWith("/api/agent/") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/start" ||
    pathname === "/connect" ||
    pathname === "/install" ||
    pathname.startsWith("/install/") ||
    pathname === "/skills" ||
    pathname.startsWith("/skills/")
  );
}

export function isHumanOAuthPath(pathname: string) {
  return (
    pathname === "/oauth/authorize" ||
    pathname.startsWith("/oauth/authorize/") ||
    pathname === "/link" ||
    pathname.startsWith("/link/")
  );
}

export function isAuthorizePath(pathname: string) {
  return (
    pathname === "/oauth/authorize" || pathname.startsWith("/oauth/authorize/")
  );
}

/** OPTIONS must be answered before Clerk on authorize/link. */
export function isOAuthOptionsPath(pathname: string) {
  return isMachineOAuthPath(pathname) || isHumanOAuthPath(pathname);
}

export const OAUTH_CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, If-None-Match, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-PAYMENT, X-Payment";

export const OAUTH_CORS_EXPOSE_HEADERS =
  "WWW-Authenticate, ETag, Mcp-Session-Id, X-PAYMENT-RESPONSE";

/**
 * Public OAuth/MCP discovery is readable cross-origin. Lives here so
 * Edge middleware can answer OPTIONS without importing `oauth-server`
 * (`node:crypto` / Convex).
 */
export function oauthCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": OAUTH_CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": OAUTH_CORS_EXPOSE_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

export function oauthOptions() {
  return new Response(null, {
    status: 204,
    headers: oauthCorsHeaders(),
  });
}

export function isMcpBrowserOrigin(origin: string | null) {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return true;
  }
  if (
    host === "chatgpt.com" ||
    host === "www.chatgpt.com" ||
    host === "chat.openai.com" ||
    host === "claude.ai" ||
    host === "www.claude.ai" ||
    host === "claude.com" ||
    host === "www.claude.com" ||
    host === "cursor.com" ||
    host === "www.cursor.com"
  ) {
    return true;
  }
  return (
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".claude.ai") ||
    host.endsWith(".claude.com") ||
    host.endsWith(".cursor.com")
  );
}

/**
 * 200 MCP responses stay origin-allowlisted (Bearer is not a cookie, but
 * a stolen key in page JS should not become readable). 401 and OPTIONS
 * are public: a browser must read `WWW-Authenticate` / pass preflight
 * even from `www.chatgpt.com`, localhost inspector, or a new subdomain
 * we have not listed yet.
 */
export function applyMcpCors(req: Request, response: Response) {
  const origin = req.headers.get("origin");
  const known = isMcpBrowserOrigin(origin);
  const open = req.method === "OPTIONS" || response.status === 401;
  if (!open && !known) return response;

  const headers = new Headers(response.headers);
  headers.set(
    "Access-Control-Allow-Origin",
    known && origin ? origin : origin && open ? origin : "*",
  );
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", OAUTH_CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Expose-Headers", OAUTH_CORS_EXPOSE_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function asJsonRecord(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (
    Array.isArray(body) &&
    body.length === 1 &&
    body[0] &&
    typeof body[0] === "object" &&
    !Array.isArray(body[0])
  ) {
    return body[0] as Record<string, unknown>;
  }
  return null;
}

/**
 * RFC 6749 allows POST to authorize. We only have a GET page, so
 * middleware 303s here (not 308 — that would drop the body) onto
 * `/oauth/authorize?...`.
 */
export async function readAuthorizeParams(request: Request) {
  const merged = new URLSearchParams(new URL(request.url).searchParams);
  const setIfEmpty = (key: string, value: string) => {
    if (value && !merged.get(key)) merged.set(key, value);
  };
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") setIfEmpty(key, value);
      }
    } catch {
      // Fall through with query only.
    }
    return merged;
  }
  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "").trim();
  if (
    contentType.includes("application/json") ||
    text.startsWith("{") ||
    text.startsWith("[")
  ) {
    try {
      const record = asJsonRecord(JSON.parse(text) as unknown);
      if (record) {
        for (const [key, value] of Object.entries(record)) {
          if (value === undefined || value === null) continue;
          setIfEmpty(key, typeof value === "string" ? value : String(value));
        }
        return merged;
      }
    } catch {
      // Fall through to form.
    }
  }
  const params = new URLSearchParams(text);
  for (const [key, value] of params.entries()) setIfEmpty(key, value);
  return merged;
}

export function isOAuthSlashRewritePath(pathname: string) {
  return (
    isMachineOAuthPath(pathname) ||
    isHumanOAuthPath(pathname) ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/")
  );
}

export function stripOAuthTrailingSlash(pathname: string) {
  if (pathname.length < 2) return null;
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const stripped =
    collapsed.length > 1 && collapsed.endsWith("/")
      ? collapsed.slice(0, -1)
      : collapsed;
  if (stripped === pathname) return null;
  if (isOAuthSlashRewritePath(stripped)) return stripped;
  return null;
}
