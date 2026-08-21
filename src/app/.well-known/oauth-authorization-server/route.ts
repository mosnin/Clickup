import {
  oauthDiscoveryMetadata,
  oauthJson,
  oauthOptions,
} from "@/lib/oauth-server";

export function GET(request?: Request) {
  return oauthJson(oauthDiscoveryMetadata(request), 200, undefined, request);
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
