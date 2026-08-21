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
