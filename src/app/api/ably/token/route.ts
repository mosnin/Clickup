import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import * as Ably from "ably";
import { api } from "@convex/_generated/api";

// Ably token endpoint.
//
// The browser never sees the Ably API key. It asks here, we ask Convex which
// channels this signed-in person may touch, and we mint a token whose
// capability list is exactly that — so the tenancy boundary is enforced by the
// same authorization code that guards every query, not by client-side
// discipline.
//
// Tokens are short-lived by Ably's default (1h) and the client SDK renews
// through this same endpoint, so revoking a workspace membership stops the
// stream within an hour without any extra plumbing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.ABLY_API_KEY;
  if (!key) {
    // Unconfigured is a supported state: the dashboard works without a live
    // stream, so tell the client plainly instead of failing hard.
    return Response.json({ error: "realtime_disabled" }, { status: 503 });
  }

  const { userId, getToken } = await auth();
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return Response.json({ error: "convex_unconfigured" }, { status: 500 });
  }

  // Ask Convex as this user — never with an admin key. If their token is stale
  // or their memberships changed, the answer changes with it.
  const token = await getToken({ template: "convex" });
  if (!token) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);

  let allowed: {
    clerkId: string;
    displayName: string;
    inbox: string;
    scopes: string[];
  };
  try {
    allowed = await convex.query(api.realtimeAuth.channels, {});
  } catch (err) {
    console.error("[ably] channel authorization failed", err);
    return Response.json({ error: "authorization_failed" }, { status: 502 });
  }

  // Read-side only for scope channels; presence needs enter/leave on top. No
  // publish capability anywhere: clients never originate events, they act
  // through Convex mutations and the server publishes the consequence.
  const capability: Record<string, Ably.capabilityOp[]> = {
    [allowed.inbox]: ["subscribe"],
  };
  for (const channel of allowed.scopes) {
    capability[channel] = ["subscribe", "presence"];
  }

  const rest = new Ably.Rest({ key });
  const tokenRequest = await rest.auth.createTokenRequest({
    clientId: allowed.clerkId,
    capability,
  });

  return Response.json(tokenRequest, {
    headers: { "Cache-Control": "no-store" },
  });
}
