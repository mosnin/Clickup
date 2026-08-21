import {
  oauthDiscoveryMetadata,
  oauthJson,
  oauthOptions,
} from "@/lib/oauth-server";

// OpenID discovery is required for ChatGPT Enterprise workspace-domain
// restrictions. Identity claims are returned by /oauth/userinfo; ID tokens
// are optional for this integration and deliberately not advertised.
export function GET(request?: Request) {
  return oauthJson(oauthDiscoveryMetadata(request), 200, undefined, request);
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
