import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";

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
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url);
  return url.searchParams.get("apiKey");
}

function creditsFrom(req: Request, bodyCredits?: unknown): number {
  const url = new URL(req.url);
  const raw = url.searchParams.get("credits") ?? bodyCredits;
  const n = Number(raw ?? 1000);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("credits must be a positive integer");
  }
  return n;
}

async function handle(req: Request): Promise<Response> {
  const apiKey = bearer(req);
  if (!apiKey) {
    return Response.json(
      { error: "Missing API key. Send Authorization: Bearer cua_..." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  let credits: number;
  try {
    credits = creditsFrom(req, body.credits);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "bad credits" },
      { status: 400 },
    );
  }

  const client = convexClient();
  const xPayment =
    req.headers.get("x-payment") ?? (body.xPayment as string | undefined);

  // No payment yet → return the 402 challenge.
  if (!xPayment) {
    try {
      const challenge = await client.query(
        asQuery(api.x402.topupRequirements),
        { apiKey, credits },
      );
      return Response.json(challenge, { status: 402 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /invalid api key/i.test(message) ? 401 : 400;
      return Response.json({ error: message }, { status });
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
    return Response.json(result, {
      status: 200,
      headers: { "X-PAYMENT-RESPONSE": encoded },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /invalid api key/i.test(message)
      ? 401
      : /already been settled/i.test(message)
        ? 409
        : 402;
    return Response.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
