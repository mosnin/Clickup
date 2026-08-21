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
