/**
 * Next/Vercel 308s `/oauth/token/` → `/oauth/token`. Many OAuth clients
 * drop the POST body on 308 (same class as the apex host redirect).
 * Middleware rewrites these internally so the handler sees the canonical
 * path and the client never follows a redirect.
 *
 * Lives in its own module so Edge middleware does not import
 * `oauth-server.ts` (`node:crypto` / Convex).
 */
export function stripOAuthTrailingSlash(pathname: string) {
  if (pathname.length < 2 || !pathname.endsWith("/")) return null;
  const stripped = pathname.slice(0, -1);
  if (
    stripped.startsWith("/oauth/") ||
    stripped === "/api/mcp" ||
    stripped.startsWith("/api/mcp/") ||
    stripped.startsWith("/.well-known/")
  ) {
    return stripped;
  }
  return null;
}
