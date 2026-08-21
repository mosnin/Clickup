import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import {
  isAuthorizePath,
  isMachineOAuthPath,
  isOAuthOptionsPath,
  oauthCorsHeaders,
  readAuthorizeParams,
  stripOAuthTrailingSlash,
} from "@/lib/oauth-slash";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
  "/invite(.*)",
  // The Chat dashboard is a second logged-in shell, not a page inside the
  // first, so it needs its own entry here.
  "/chat(.*)",
]);

// Routes that authenticate themselves and must never be touched by Clerk.
//
// /api/mcp carries an agent API key as its bearer token (`cua_…`), verified
// against Convex by the route itself. Running clerkMiddleware over it made two
// systems interpret one token: Clerk found a non-JWT where a session token
// should be and emitted "invalid JWT" diagnostics on requests that were
// authenticating perfectly well. That noise is what made a transport outage
// look like a credential problem. Same reasoning for the x402 endpoint, which
// authenticates with a signed payment authorization.
const isSelfAuthenticated = createRouteMatcher([
  "/api/mcp",
  "/api/mcp/(.*)",
  "/mcp",
  "/mcp/(.*)",
  "/api/x402",
]);
const isPublicDiscovery = createRouteMatcher(["/.well-known/(.*)"]);

const clerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
  // Human OAuth (`/oauth/authorize/`, `/link/`): Clerk must run first so
  // `auth()` sees the session, then rewrite so skipTrailingSlashRedirect
  // does not 404 the slashed URL.
  const stripped = stripOAuthTrailingSlash(req.nextUrl.pathname);
  if (stripped && !isMachineOAuthPath(stripped)) {
    const url = req.nextUrl.clone();
    url.pathname = stripped;
    return NextResponse.rewrite(url);
  }
});

export default async function middleware(req: NextRequest, event: never) {
  const stripped = stripOAuthTrailingSlash(req.nextUrl.pathname);
  const path = stripped ?? req.nextUrl.pathname;
  // OPTIONS on authorize/link must not reach Clerk (a sign-in redirect
  // fails CORS preflight). Machine OPTIONS are answered here too so a
  // slashed URL never 404s the preflight.
  if (req.method === "OPTIONS" && isOAuthOptionsPath(path)) {
    return new NextResponse(null, {
      status: 204,
      headers: oauthCorsHeaders(req),
    });
  }
  // POST authorize is a 404 today (page is GET-only). 303 to GET with the
  // body as query — not 308, which would drop the body.
  if (req.method === "POST" && isAuthorizePath(path)) {
    const params = await readAuthorizeParams(req);
    const url = req.nextUrl.clone();
    url.pathname = "/oauth/authorize";
    url.search = params.toString();
    return NextResponse.redirect(url, 303);
  }
  if (
    isMachineOAuthPath(path) ||
    isSelfAuthenticated(req) ||
    isPublicDiscovery(req)
  ) {
    if (stripped) {
      const url = req.nextUrl.clone();
      url.pathname = stripped;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }
  return clerk(req, event);
}

export const config = {
  matcher: [
    // Run on every route except Next.js internals and static assets.
    "/((?!_next|.*\\..*|favicon.ico).*)",
    "/(api|trpc)(.*)",
    // `.well-known` contains a dot, so the first pattern skips it. We still
    // need to rewrite `/…/api/mcp/` here so a 308 does not drop a GET that
    // an OAuth client constructed from the resource path.
    "/.well-known/:path*",
    // `/mcp/.well-known/…` has a dot, so the first pattern skips it, and
    // it is not under `/api`. Without this the /mcp → /api/mcp rewrite
    // never runs and discovery 404s.
    "/mcp/:path*",
  ],
};
