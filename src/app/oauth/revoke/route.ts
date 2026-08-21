import { api } from "@convex/_generated/api";
import {
  oauthBearer,
  oauthConvexClient,
  oauthCorsHeaders,
  oauthFields,
  oauthOptions,
  oauthPostOnly,
} from "@/lib/oauth-server";

export async function POST(request: Request) {
  const field = await oauthFields(request);
  const token = field("token") || oauthBearer(request);
  if (token) {
    await oauthConvexClient().mutation(api.oauth.revokeToken, { token });
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", ...oauthCorsHeaders() },
  });
}

export function GET() {
  return oauthPostOnly();
}

export function OPTIONS() {
  return oauthOptions();
}
