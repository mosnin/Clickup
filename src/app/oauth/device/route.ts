import { randomInt } from "node:crypto";
import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthError,
  oauthIssuer,
  oauthJson,
  randomCredential,
} from "@/lib/oauth-server";

// RFC 8628 §3.1 — the device authorization endpoint.
//
// This is the entry point for `curl -fsSL operate.to/start`: an agent runtime
// with no browser asks for a code here, prints it, and a human approves it at
// /link. The token endpoint (/oauth/token, device_code grant) hands back the
// API key once approval lands.
//
// Unauthenticated by design. The caller is a machine that has no credential
// yet — that is the grant's whole purpose — and the row it creates is inert
// until a signed-in human approves it.

// Uppercase, no glyph pairs a person can confuse. Must match
// DEVICE_CODE_ALPHABET in convex/agentAuth.ts, which validates the shape.
const ALPHABET = "ACDEFGHJKMNPQRTUVWXY3479";

function userCode() {
  // randomInt, not Math.random: this is the code a human types to bind an
  // agent to their workspace, so guessing one must not be cheaper than
  // guessing a key. 24^8 ≈ 1.1e11 over a 10-minute window.
  let out = "";
  for (let i = 0; i < 8; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function POST(request: Request) {
  // RFC 8628 posts form-encoded, but an agent hand-rolling this with curl
  // will reach for JSON. Accept both rather than making the first thing an
  // agent tries fail on a content type.
  let clientName = "";
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { client_name?: string; client?: string };
      clientName = String(body.client_name ?? body.client ?? "");
    } else {
      const form = await request.formData();
      clientName = String(form.get("client_name") ?? form.get("client") ?? "");
    }
  } catch {
    clientName = "";
  }

  const issuer = oauthIssuer();
  const deviceCode = randomCredential("opd");

  // A collision is a live user code being handed to two agents at once, and
  // the mutation refuses it rather than letting one human's approval reach
  // the wrong runtime. Retry with a fresh code; three attempts makes the
  // odds of a genuine failure negligible.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = userCode();
    try {
      const result = await oauthConvexClient().mutation(
        api.agentAuth.createDeviceRequest,
        { deviceCode, userCode: code, clientName },
      );
      return oauthJson({
        device_code: deviceCode,
        user_code: code,
        verification_uri: `${issuer}/link`,
        // RFC 8628 §3.3.1. Agents that render a QR code use this one.
        verification_uri_complete: `${issuer}/link?code=${encodeURIComponent(code)}`,
        expires_in: result.expiresIn,
        interval: result.interval,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("collision")) {
        return oauthError(
          "server_error",
          "Could not start device authorization",
          500,
        );
      }
    }
  }
  return oauthError("server_error", "Could not allocate a user code", 503);
}

// Some agent runtimes probe an endpoint with GET before posting to it.
// Answering with the method requirement is more useful than a 404 from the
// catch-all, because the fix is one word in their request.
export function GET() {
  return oauthError(
    "invalid_request",
    "The device authorization endpoint accepts POST",
    405,
  );
}
