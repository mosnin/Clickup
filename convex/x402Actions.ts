"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  buildPaymentRequired,
  facilitatorConfigured,
  validatePaymentShape,
  x402Config,
  type PaymentPayload,
  type PaymentRequirements,
} from "./_x402";

// Explicit result type breaks the self-referential type inference that
// otherwise arises when an action calls internal functions from the same
// deployment (the api type includes this action).
type SettleResult = {
  settled: boolean;
  balance: number;
  creditsGranted: number;
  txReference?: string;
  network: string;
  asset: string;
};

// x402 settlement (Node runtime — it makes external HTTP calls to the
// payment facilitator). The agent submits the base64 X-PAYMENT it built from
// a 402 challenge; we verify and settle it, then credit the wallet via the
// internal applySettlement mutation. Verification always runs before any
// credit is granted, so a forged payload never mints credits.

type FacilitatorResult = {
  ok: boolean;
  reason?: string;
  txReference?: string;
  payer?: string;
};

// Real facilitator: POST /verify then /settle per the x402 facilitator API.
async function facilitatorSettle(
  url: string,
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<FacilitatorResult> {
  const body = {
    x402Version: 1,
    paymentPayload: payment,
    paymentRequirements: requirements,
  };
  const verifyRes = await fetch(`${url.replace(/\/$/, "")}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!verifyRes.ok) {
    return { ok: false, reason: `facilitator verify HTTP ${verifyRes.status}` };
  }
  const verify = (await verifyRes.json()) as {
    isValid?: boolean;
    invalidReason?: string;
    payer?: string;
  };
  if (!verify.isValid) {
    return { ok: false, reason: verify.invalidReason ?? "payment invalid" };
  }
  const settleRes = await fetch(`${url.replace(/\/$/, "")}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!settleRes.ok) {
    return { ok: false, reason: `facilitator settle HTTP ${settleRes.status}` };
  }
  const settle = (await settleRes.json()) as {
    success?: boolean;
    errorReason?: string;
    transaction?: string;
    txHash?: string;
    payer?: string;
  };
  if (!settle.success) {
    return { ok: false, reason: settle.errorReason ?? "settlement failed" };
  }
  return {
    ok: true,
    txReference: settle.transaction ?? settle.txHash,
    payer: settle.payer ?? verify.payer,
  };
}

// Mock facilitator: used when X402_FACILITATOR_URL is unset. It performs the
// same structural validation a real facilitator would (version, scheme,
// network, amount, payTo) and produces a deterministic settlement reference
// derived from the payment nonce — so the full flow is exercisable in dev
// and tests without a chain, and swaps out for a real facilitator by env.
function mockSettle(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): FacilitatorResult {
  const cfg = x402Config();
  const shape = validatePaymentShape(payment, requirements, cfg);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  return {
    ok: true,
    txReference: `mock:${shape.nonce}`,
    payer: shape.payer,
  };
}

function decodeXPayment(xPayment: string): PaymentPayload {
  const json = Buffer.from(xPayment, "base64").toString("utf8");
  const parsed = JSON.parse(json) as PaymentPayload;
  return parsed;
}

export const settleTopup = action({
  // xPayment is the base64-encoded X-PAYMENT header the agent built.
  args: {
    apiKey: v.string(),
    xPayment: v.string(),
    credits: v.number(),
  },
  handler: async (ctx, { apiKey, xPayment, credits }): Promise<SettleResult> => {
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error("credits must be a positive integer");
    }
    const cfg = x402Config();
    // Fail closed: never settle (and never mint credits) unless a real
    // facilitator is configured or the mock is explicitly opted into for dev.
    if (!facilitatorConfigured(cfg)) {
      throw new Error(
        "Payment facilitator not configured. Set X402_FACILITATOR_URL (production), or X402_ALLOW_MOCK=1 for development only.",
      );
    }
    const scope: {
      scopeType: "user" | "workspace";
      scopeId: string;
      agentId: Id<"agents">;
    } = await ctx.runQuery(internal.x402.resolveScopeByKey, { apiKey });
    const requirements = buildPaymentRequired(
      credits,
      `x402://credits/${scope.scopeType}/${scope.scopeId}`,
      cfg,
    ).accepts[0];

    let payment: PaymentPayload;
    try {
      payment = decodeXPayment(xPayment);
    } catch {
      throw new Error("X-PAYMENT is not valid base64 JSON");
    }

    // Determine the nonce up front so a failure can still be recorded.
    const nonce =
      payment.payload?.authorization?.nonce ??
      (payment.payload?.transaction as string | undefined) ??
      "";

    const facilitatorLabel = cfg.facilitatorUrl ?? "mock";
    const result = cfg.facilitatorUrl
      ? await facilitatorSettle(cfg.facilitatorUrl, payment, requirements)
      : mockSettle(payment, requirements);

    if (!result.ok) {
      if (nonce) {
        await ctx.runMutation(internal.x402.recordFailedPayment, {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          agentId: scope.agentId,
          nonce,
          reason: result.reason ?? "settlement failed",
          facilitator: facilitatorLabel,
        });
      }
      throw new Error(`Payment failed: ${result.reason ?? "unknown"}`);
    }

    // A settlement must carry a stable, non-empty reference (the payment
    // nonce, or the on-chain tx ref) — it's the replay key. Refuse if neither.
    const settlementNonce = nonce || result.txReference;
    if (!settlementNonce) {
      throw new Error("Settlement produced no payment reference");
    }
    const applied: { balance: number; creditsGranted: number } =
      await ctx.runMutation(internal.x402.applySettlement, {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        agentId: scope.agentId,
        asset: cfg.asset,
        network: cfg.network,
        amountAtomic: requirements.maxAmountRequired,
        creditsGranted: credits,
        payer: result.payer,
        nonce: settlementNonce,
        txReference: result.txReference,
        facilitator: facilitatorLabel,
      });

    return {
      settled: true,
      balance: applied.balance,
      creditsGranted: applied.creditsGranted,
      txReference: result.txReference,
      network: cfg.network,
      asset: cfg.assetSymbol,
    };
  },
});
