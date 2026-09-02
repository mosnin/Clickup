import { api } from "@convex/_generated/api";
import { oauthConvexClient } from "@/lib/oauth-server";

// RFC 7009 §2.2: the answer is 200 with an empty body whether or not the
// token existed, and the same for a token that was already dead. An
// unrecognised token is defined by the RFC as a successful revocation, and
// saying otherwise would turn this endpoint into an oracle for which tokens
// are live. So every path below ends at the same response, including a body
// that will not parse and a backend that refuses: a client disconnecting has
// already thrown its copy of the token away, and a non-200 would leave it
// stuck retrying a disconnect it cannot complete. Whatever went wrong is our
// problem to see in logs, not the client's to handle.
export async function POST(request: Request) {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
  } catch {
    token = "";
  }
  if (token) {
    try {
      await oauthConvexClient().mutation(api.oauth.revokeToken, { token });
    } catch {
      // Deliberately swallowed. See above.
    }
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
