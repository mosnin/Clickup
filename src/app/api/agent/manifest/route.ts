import { buildManifest, manifestEtag } from "@/lib/agent-manifest";
import { oauthIssuer } from "@/lib/oauth-server";

// GET /api/agent/manifest — "has anything I learned changed?"
//
// Unauthenticated on purpose: it describes the shape of the public tool
// surface and the published skills, both of which any prospective agent can
// already read from /start. It contains nothing about anybody's workspace.
//
// The contract an agent follows: store the ETag, send If-None-Match on boot
// and after any unexpected 4xx. A 304 is the common case and costs almost
// nothing, which is what makes checking on every boot realistic rather than
// something a runtime does once and never again.
export async function GET(request: Request) {
  const manifest = await buildManifest(oauthIssuer(request));
  const etag = manifestEtag(manifest);

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=60" },
    });
  }

  return Response.json(manifest, {
    headers: {
      ETag: etag,
      // Short, because the point of the endpoint is noticing a change. A
      // long TTL here would make an agent's update check answer with
      // yesterday's surface, which is worse than not checking.
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}

export const dynamic = "force-dynamic";
