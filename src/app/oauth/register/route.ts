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
  try {
    await oauthConvexClient().mutation(api.oauth.registerClient, {
      clientId,
      clientName: input.client_name,
      redirectUris: input.redirect_uris,
    });
  } catch (error) {
    return oauthError(
      "invalid_redirect_uri",
      error instanceof Error ? error.message : "Client registration failed",
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
      scope: "operate:read operate:write",
      client_uri: `${oauthIssuer()}/plugins`,
    },
    201,
  );
}
