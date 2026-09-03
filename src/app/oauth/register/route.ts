import { createHash } from "node:crypto";
import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthError,
  oauthIssuer,
  oauthJson,
  randomCredential,
} from "@/lib/oauth-server";

export async function POST(request: Request) {
  let input: {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  try {
    input = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
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
    // RFC 7591 §3.2.2 defines two codes here and they are not
    // interchangeable: invalid_redirect_uri says fix the URIs, and
    // invalid_client_metadata says fix something else. Answering the first
    // for a rejected client_name sent implementers hunting through their
    // redirect URIs for a fault that was never there.
    return oauthError(
      /redirect/i.test(description)
        ? "invalid_redirect_uri"
        : "invalid_client_metadata",
      description,
    );
  }
  return oauthJson(
    {
      client_id: clientId,
      // RFC 7591 §3.2.1. Seconds, not milliseconds.
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid email operate:read operate:write",
      client_uri: `${oauthIssuer()}/plugins`,
    },
    201,
  );
}
