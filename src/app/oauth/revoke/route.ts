import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthCorsHeaders,
  oauthFields,
  oauthOptions,
  oauthPostOnly,
  operateRequestCredential,
} from "@/lib/oauth-server";

export async function POST(request: Request) {
  const field = await oauthFields(request);
  const token = operateRequestCredential(
    request,
    field("token") || field("access_token") || field("api_key"),
  );
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
