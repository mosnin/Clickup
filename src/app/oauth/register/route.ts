import { createHash } from "node:crypto";
import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthError,
  oauthIssuer,
  oauthJson,
  oauthJsonObject,
  randomCredential,
} from "@/lib/oauth-server";

export async function POST(request: Request) {
  const parsed = await oauthJsonObject(request);
  if (!parsed) {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const input = parsed as {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  if (
    !input.client_name ||
    !Array.isArray(input.redirect_uris) ||
    input.token_endpoint_auth_method === "client_secret_basic" ||
    input.token_endpoint_auth_method === "client_secret_post"
  ) {
    return oauthError(
      "invalid_client_metadata",
      "A public PKCE client_name and redirect_uris are required",
    );
  }
  const clientId = randomCredential("opc");
  const source =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  // Only the digest is persisted in the generic rate-limit table. The raw
  // address remains in infrastructure logs under the normal retention policy.
  const registrationSubject = createHash("sha256")
    .update(`oauth-dcr:${source}`)
    .digest("hex");
  try {
    await oauthConvexClient().mutation(api.oauth.registerClient, {
      clientId,
      clientName: input.client_name,
      redirectUris: input.redirect_uris,
      registrationSubject,
    });
  } catch (error) {
    const description =
      error instanceof Error ? error.message : "Client registration failed";
    if (/too many oauth client registrations/i.test(description)) {
      return oauthError("temporarily_unavailable", description, 429);
    }
    return oauthError(
      "invalid_redirect_uri",
      description,
    );
  }
  return oauthJson(
    {
      client_id: clientId,
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid email operate:read operate:write",
      client_uri: `${oauthIssuer(request)}/plugins`,
    },
    201,
  );
}
