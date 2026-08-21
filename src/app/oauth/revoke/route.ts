import { api } from "@convex/_generated/api";
import { oauthConvexClient, oauthFields } from "@/lib/oauth-server";

export async function POST(request: Request) {
  const field = await oauthFields(request);
  const token = field("token");
  if (token) {
    await oauthConvexClient().mutation(api.oauth.revokeToken, { token });
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
