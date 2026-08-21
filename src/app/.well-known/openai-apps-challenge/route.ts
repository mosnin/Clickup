import { oauthCorsHeaders, oauthOptions } from "@/lib/oauth-slash";

export function GET() {
  const token = process.env.OPENAI_APPS_CHALLENGE;
  if (!token) {
    return new Response("Not configured", {
      status: 404,
      headers: oauthCorsHeaders(),
    });
  }
  return new Response(token, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...oauthCorsHeaders(),
    },
  });
}

export function OPTIONS() {
  return oauthOptions();
}
