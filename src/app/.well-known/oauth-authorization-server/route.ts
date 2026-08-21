import {
  oauthDiscoveryMetadata,
  oauthJson,
  oauthOptions,
} from "@/lib/oauth-server";

export function GET(request?: Request) {
  return oauthJson(oauthDiscoveryMetadata(request));
}

export function OPTIONS() {
  return oauthOptions();
}
