import { oauthDiscoveryMetadata, oauthJson } from "@/lib/oauth-server";

export function GET() {
  return oauthJson(oauthDiscoveryMetadata());
}
