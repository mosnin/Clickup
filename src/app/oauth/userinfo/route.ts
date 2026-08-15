import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthJson,
  oauthResource,
} from "@/lib/oauth-server";

function unauthorized(description: string) {
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description.replaceAll('"', "'")}"`,
      },
    },
  );
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return unauthorized("A Bearer access token is required");

  try {
    const result = await oauthConvexClient().query(api.oauth.userInfo, {
      accessToken: match[1],
      resource: oauthResource(),
    });
    return oauthJson({
      sub: result.subject,
      email: result.email,
      email_verified: result.emailVerified,
      ...(result.name ? { name: result.name } : {}),
    });
  } catch (error) {
    return unauthorized(
      error instanceof Error ? error.message : "The access token is invalid",
    );
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
