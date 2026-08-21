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
    headers: { "Cache-Control": "no-store", ...oauthCorsHeaders(request) },
  });
}

export function GET(request: Request) {
  return oauthPostOnly(request);
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
