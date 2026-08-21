import { servingMcpUrl } from "@/lib/oauth-resource";
import {
  authorizationServerMetadataUrl,
  oauthIssuer,
  oauthJson,
  oauthOptions,
  oauthResource,
  protectedResourceMetadataUrl,
} from "@/lib/oauth-server";

export function GET(request?: Request) {
  const issuer = oauthIssuer(request);
  return oauthJson(
    {
      url: servingMcpUrl(issuer),
      resource: oauthResource(request),
      resource_metadata: protectedResourceMetadataUrl(issuer),
      as_uri: authorizationServerMetadataUrl(issuer),
    },
    200,
    undefined,
    request,
  );
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
