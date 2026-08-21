import {
  oauthIssuer,
  oauthJson,
  oauthOptions,
} from "@/lib/oauth-server";

/**
 * RFC 6415. Some OpenID discovery walks host-meta before webfinger.
 * JRD (same document host-meta.json would serve) pointing at the www
 * issuer and the webfinger lrdd template. Machine path: skip Clerk.
 */
export function GET(request: Request) {
  const issuer = oauthIssuer(request);
  return oauthJson(
    {
      subject: issuer,
      links: [
        {
          rel: "lrdd",
          type: "application/jrd+json",
          template: `${issuer}/.well-known/webfinger?resource={uri}`,
        },
        {
          rel: "http://openid.net/specs/connect/1.0/issuer",
          href: issuer,
        },
      ],
    },
    200,
    { "Content-Type": "application/jrd+json" },
    request,
  );
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
