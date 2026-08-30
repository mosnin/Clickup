import {
  convexHttpActionOrigin,
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
    const response = await fetch(
      `${convexHttpActionOrigin()}/oauth/internal/userinfo`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resource: oauthResource() }),
        cache: "no-store",
      },
    );
    const result = (await response.json().catch(() => null)) as {
      subject?: unknown;
      email?: unknown;
      emailVerified?: unknown;
      name?: unknown;
      error_description?: unknown;
    } | null;
    if (
      !response.ok ||
      typeof result?.subject !== "string" ||
      typeof result.email !== "string" ||
      result.emailVerified !== true
    ) {
      throw new Error(
        typeof result?.error_description === "string"
          ? result.error_description
          : "The access token is invalid",
      );
    }
    return oauthJson({
      sub: result.subject,
      email: result.email,
      email_verified: result.emailVerified,
      ...(typeof result.name === "string" ? { name: result.name } : {}),
    });
  } catch (error) {
    return unauthorized(
      error instanceof Error ? error.message : "The access token is invalid",
    );
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
