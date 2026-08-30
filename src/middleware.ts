import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

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
// look like a credential problem. Company OS connector routes carry their own
// audience-bound OAuth token, and x402 authenticates with a signed payment
// authorization, so neither belongs in Clerk's session parser either.
const isSelfAuthenticated = createRouteMatcher([
  "/api/mcp",
  "/api/companyos(.*)",
  "/api/x402",
]);

const clerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export default function middleware(req: NextRequest, event: never) {
  if (isSelfAuthenticated(req)) return NextResponse.next();
  return clerk(req, event);
}

export const config = {
  matcher: [
    // Run on every route except Next.js internals and static assets.
    "/((?!_next|.*\\..*|favicon.ico).*)",
    "/(api|trpc)(.*)",
  ],
};
