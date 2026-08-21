import { oauthDiscoveryMetadata, oauthJson } from "@/lib/oauth-server";

export function GET(request?: Request) {
  return oauthJson(oauthDiscoveryMetadata(request));
}
