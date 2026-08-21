import {
  oauthDiscoveryMetadata,
  oauthJson,
  oauthOptions,
  oauthPostOnly,
} from "@/lib/oauth-server";

/**
 * Clients that resolve `.` against `token_endpoint` GET `/oauth/` and
 * used to 404. Same metadata as the authorization-server well-known.
 * Machine path: rewrite without Clerk; OPTIONS must not hit sign-in.
 */
export function GET(request?: Request) {
  return oauthJson(oauthDiscoveryMetadata(request), 200, undefined, request);
}

export function POST() {
  return oauthPostOnly();
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
