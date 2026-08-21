import { servingMcpUrl } from "@/lib/oauth-resource";
import {
  oauthIssuer,
  oauthJson,
  oauthOptions,
  oauthResource,
  protectedResourceMetadataUrl,
} from "@/lib/oauth-server";

export function GET(request?: Request) {
  const issuer = oauthIssuer(request);
  return oauthJson({
    url: servingMcpUrl(issuer),
    resource: oauthResource(request),
    resource_metadata: protectedResourceMetadataUrl(issuer),
  });
}

export function OPTIONS() {
  return oauthOptions();
}
