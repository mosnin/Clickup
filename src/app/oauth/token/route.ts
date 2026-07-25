import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthError,
  oauthJson,
  randomCredential,
} from "@/lib/oauth-server";

export async function POST(request: Request) {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!clientId) {
    return oauthError("invalid_client", "client_id is required", 401);
  }
  const accessToken = randomCredential("opa");
  const refreshToken = randomCredential("opr");
  try {
    if (grantType === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const redirectUri = String(form.get("redirect_uri") ?? "");
      const codeVerifier = String(form.get("code_verifier") ?? "");
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError(
          "invalid_request",
          "code, redirect_uri, and code_verifier are required",
        );
      }
      const result = await oauthConvexClient().mutation(
        api.oauth.exchangeAuthorizationCode,
        {
          code,
          clientId,
          redirectUri,
          codeVerifier,
          accessToken,
          refreshToken,
        },
      );
      return oauthJson({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: result.expiresIn,
        refresh_token: refreshToken,
        scope: result.scope,
      });
    }
    if (grantType === "refresh_token") {
      const currentRefreshToken = String(form.get("refresh_token") ?? "");
      if (!currentRefreshToken) {
        return oauthError("invalid_request", "refresh_token is required");
      }
      const result = await oauthConvexClient().mutation(
        api.oauth.refreshAccessToken,
        {
          refreshToken: currentRefreshToken,
          clientId,
          accessToken,
          nextRefreshToken: refreshToken,
        },
      );
      return oauthJson({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: result.expiresIn,
        refresh_token: refreshToken,
        scope: result.scope,
      });
    }
    return oauthError("unsupported_grant_type", "Unsupported grant_type");
  } catch (error) {
    return oauthError(
      "invalid_grant",
      error instanceof Error ? error.message : "Token grant failed",
    );
  }
}
