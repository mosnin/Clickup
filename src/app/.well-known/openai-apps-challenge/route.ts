import { oauthCorsHeaders, oauthOptions } from "@/lib/oauth-slash";

export function GET(request: Request) {
  const token = process.env.OPENAI_APPS_CHALLENGE;
  if (!token) {
    return new Response("Not configured", {
      status: 404,
      headers: oauthCorsHeaders(request),
    });
  }
  return new Response(token, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...oauthCorsHeaders(request),
    },
  });
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
