import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { stripOAuthTrailingSlash } from "@/lib/oauth-slash";

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
  "/api/x402",
]);
const isPublicDiscovery = createRouteMatcher(["/.well-known/(.*)"]);

const clerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export default function middleware(req: NextRequest, event: never) {
  const stripped = stripOAuthTrailingSlash(req.nextUrl.pathname);
  if (stripped) {
    const url = req.nextUrl.clone();
    url.pathname = stripped;
    return NextResponse.rewrite(url);
  }
  if (isSelfAuthenticated(req) || isPublicDiscovery(req)) {
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
  ],
};
