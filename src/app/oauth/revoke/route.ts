import { api } from "@convex/_generated/api";
import { oauthConvexClient } from "@/lib/oauth-server";

export async function POST(request: Request) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  if (token) {
    await oauthConvexClient().mutation(api.oauth.revokeToken, { token });
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
