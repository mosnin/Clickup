import { api } from "@convex/_generated/api";
import {
  oauthBearer,
  oauthConvexClient,
  oauthCorsHeaders,
  oauthFields,
  oauthJson,
  oauthOptions,
  oauthResource,
  oauthWwwAuthenticate,
} from "@/lib/oauth-server";

function unauthorized(description: string, request?: Request) {
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "WWW-Authenticate": oauthWwwAuthenticate(
          request,
          "invalid_token",
          description,
        ),
        ...oauthCorsHeaders(),
      },
    },
  );
}

async function userInfo(request: Request) {
  const field = await oauthFields(request);
  const accessToken = oauthBearer(request) || field("access_token") || field("token");
  if (!accessToken) {
    return unauthorized("A Bearer access token is required", request);
  }

  try {
    const result = await oauthConvexClient().query(api.oauth.userInfo, {
      accessToken,
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
      request,
    );
  }
}

export async function GET(request: Request) {
  return userInfo(request);
}

export async function POST(request: Request) {
  return userInfo(request);
}

export function OPTIONS() {
  return oauthOptions();
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
