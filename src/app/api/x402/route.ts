import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";
import {
  oauthBearer,
  oauthCorsHeaders,
  oauthFields,
  oauthOptions,
  oauthWwwAuthenticate,
} from "@/lib/oauth-server";
import { foldSearchAll } from "@/lib/oauth-slash";

// Protocol-faithful x402 endpoint for topping up agent credits.
//
//   POST /api/x402?credits=1000
//   Authorization: Bearer cua_...
//
// Without an X-PAYMENT header the endpoint replies HTTP 402 with the payment
// requirements (the x402 challenge). The agent builds a signed X-PAYMENT for
// those requirements and re-POSTs; the endpoint verifies + settles it through
// the facilitator, credits the wallet, and replies 200 with an
// X-PAYMENT-RESPONSE header. This is the same flow the MCP tools expose, in
// raw HTTP so any x402-capable client can pay without speaking MCP.

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

function asQuery(ref: unknown): FunctionReference<"query"> {
  return ref as FunctionReference<"query">;
}
function asAction(ref: unknown): FunctionReference<"action"> {
  return ref as FunctionReference<"action">;
}

function bearer(req: Request): string | null {
  return oauthBearer(req) || null;
}

function x402Json(
  body: unknown,
  status = 200,
  extra?: Record<string, string>,
  request?: Request,
) {
  const headers: Record<string, string> = {
    ...oauthCorsHeaders(request),
    ...extra,
  };
  if (
    (status === 401 || status === 403) &&
    !headers["WWW-Authenticate"] &&
    request
  ) {
    headers["WWW-Authenticate"] = oauthWwwAuthenticate(
      request,
      "invalid_token",
    );
  }
  return Response.json(body, { status, headers });
}

function creditsFrom(req: Request, bodyCredits?: unknown): number {
  const url = new URL(req.url);
  const raw = foldSearchAll(url.searchParams, "credits") || bodyCredits;
  const n = Number(raw ?? 1000);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("credits must be a positive integer");
  }
  return n;
}

async function handle(req: Request): Promise<Response> {
  const apiKey = bearer(req);
  if (!apiKey) {
    return x402Json(
      { error: "Missing API key. Send Authorization: Bearer cua_..." },
      401,
      {
        "WWW-Authenticate": oauthWwwAuthenticate(
          req,
          "invalid_token",
          "A Bearer access token is required",
        ),
      },
      req,
    );
  }

  const field = await oauthFields(req);

  let credits: number;
  try {
    credits = creditsFrom(req, field("credits") || undefined);
  } catch (err) {
    return x402Json(
      { error: err instanceof Error ? err.message : "bad credits" },
      400,
      undefined,
      req,
    );
  }

  const client = convexClient();
  const xPayment =
    req.headers.get("x-payment") ||
    field("xPayment") ||
    field("x_payment") ||
    field("X-PAYMENT") ||
    undefined;

  // No payment yet → return the 402 challenge.
  if (!xPayment) {
    try {
      // Convex intentionally redacts thrown server errors at this boundary.
      // Read readiness first so an incomplete payment deployment maps to a
      // truthful 503 instead of a generic 400 "Server Error".
      const wallet = (await client.query(asQuery(api.x402.walletByKey), {
        apiKey,
      })) as {
        pricing?: {
          available?: boolean;
          configurationIssue?: string | null;
        };
      };
      if (wallet.pricing?.available === false) {
        return x402Json(
          {
            error: `Billing unavailable: ${
              wallet.pricing.configurationIssue ?? "payment setup is incomplete"
            }`,
          },
          503,
          undefined,
          req,
        );
      }
      const challenge = await client.query(
        asQuery(api.x402.topupRequirements),
        { apiKey, credits },
      );
      return x402Json(challenge, 402, undefined, req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /invalid api key/i.test(message)
        ? 401
        : /billing unavailable|not configured/i.test(message)
          ? 503
          : 400;
      return x402Json({ error: message }, status, undefined, req);
    }
  }

  // Payment present → verify, settle, and credit.
  try {
    const result = (await client.action(asAction(api.x402Actions.settleTopup), {
      apiKey,
      xPayment,
      credits,
    })) as Record<string, unknown>;
    const encoded = Buffer.from(JSON.stringify(result)).toString("base64");
    return x402Json(result, 200, { "X-PAYMENT-RESPONSE": encoded }, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /invalid api key/i.test(message)
      ? 401
      : /already been settled/i.test(message)
        ? 409
        : /billing unavailable|not configured/i.test(message)
          ? 503
          : 402;
    return x402Json({ error: message }, status, undefined, req);
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

export function OPTIONS(request: Request) {
  return oauthOptions(request);
}
