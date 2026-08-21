import {
  oauthIssuer,
  oauthJson,
  oauthOptions,
} from "@/lib/oauth-server";

/**
 * RFC 7033. ChatGPT Enterprise workspace-domain checks hit webfinger
 * before OpenID discovery. Point every resource at the www issuer —
 * the same document `/.well-known/openid-configuration` already serves.
 */
export function GET(request?: Request) {
  const issuer = oauthIssuer(request);
  const resource =
    (request && new URL(request.url).searchParams.get("resource")) || issuer;
  return oauthJson(
    {
      subject: resource,
      links: [
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
