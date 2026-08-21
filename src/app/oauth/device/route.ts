import { randomInt } from "node:crypto";
import { api } from "@convex/_generated/api";
import {
  oauthConvexClient,
  oauthError,
  oauthFields,
  oauthIssuer,
  oauthJson,
  oauthOptions,
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
  // RFC 8628 posts form-encoded; an agent hand-rolling curl sends JSON,
  // often with no Content-Type. Same reader as /oauth/token and /oauth/revoke.
  const field = await oauthFields(request);
  const clientName = field("client_name") || field("client");

  const issuer = oauthIssuer(request);
  const deviceCode = randomCredential("opd");

  // Convex cannot see the caller's address, so the rate limit's subject has
  // to be read here and passed in. The secret is what stops somebody calling
  // that public mutation directly with an invented clientIp — see
  // deviceRateSubject in convex/agentAuth.ts for how it degrades when unset.
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const clientIp =
    forwarded.split(",")[0].trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    undefined;
  const proxySecret = process.env.DEVICE_PROXY_SECRET;

  // A collision is a live user code being handed to two agents at once, and
  // the mutation refuses it rather than letting one human's approval reach
  // the wrong runtime. Retry with a fresh code; three attempts makes the
  // odds of a genuine failure negligible.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = userCode();
    try {
      const result = await oauthConvexClient().mutation(
        api.agentAuth.createDeviceRequest,
        { deviceCode, userCode: code, clientName, clientIp, proxySecret },
      );
      const verificationUri = `${issuer}/link`;
      const verificationUriComplete = `${issuer}/link?code=${encodeURIComponent(code)}`;
      return oauthJson(
        {
          device_code: deviceCode,
          user_code: code,
          verification_uri: verificationUri,
          // RFC 8628 §3.3.1. Agents that render a QR code use this one.
          verification_uri_complete: verificationUriComplete,
          // Libraries that read `_url` instead of `_uri`.
          verification_url: verificationUri,
          verification_url_complete: verificationUriComplete,
          expires_in: result.expiresIn,
          interval: result.interval,
        },
        200,
        undefined,
        request,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // A collision means this user code is live for somebody else; retrying
      // with a fresh one is the correct response and costs nothing.
      if (message.includes("collision")) continue;
      // Anything else is terminal for this request. Rate limiting gets its
      // own status because a client that retries a 429 as if it were a 500
      // is precisely the client the limit exists to stop.
      if (message.includes("Too many")) {
        return oauthError("slow_down", message, 429, request);
      }
      return oauthError(
        "server_error",
        "Could not start device authorization",
        500,
        request,
      );
    }
  }
  return oauthError("server_error", "Could not allocate a user code", 503, request);
}

// Some agent runtimes probe an endpoint with GET before posting to it.
// 405 + Allow: POST is the method fix; verification_url is where a
// human completes the grant, so a GET probe is not a dead end.
export function GET(request: Request) {
  const issuer = oauthIssuer(request);
  const verificationUri = `${issuer}/link`;
  return oauthJson(
    {
      error: "invalid_request",
      error_description: "This endpoint accepts POST",
      verification_uri: verificationUri,
      verification_url: verificationUri,
    },
    405,
    { Allow: "POST" },
    request,
  );
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
