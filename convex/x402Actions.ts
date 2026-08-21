"use node";

import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  billingConfigurationIssue,
  buildPaymentRequired,
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
  returns: v.object({
    settled: v.boolean(),
    balance: v.number(),
    creditsGranted: v.number(),
    txReference: v.optional(v.string()),
    network: v.string(),
    asset: v.string(),
  }),
  handler: async (
    ctx,
    { apiKey, xPayment, credits },
  ): Promise<SettleResult> => {
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new ConvexError("credits must be a positive integer");
    }
    const cfg = x402Config();
    // Fail closed: never settle (and never mint credits) unless a real
    // facilitator is configured or the mock is explicitly opted into for dev.
    const configurationIssue = billingConfigurationIssue(cfg);
    if (configurationIssue) {
      throw new ConvexError(
        `Billing unavailable: ${configurationIssue}. Configure X402_FACILITATOR_URL and X402_PAY_TO (production), or explicitly opt into the mock with a non-zero test receiver for development only.`,
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
      throw new ConvexError("X-PAYMENT is not valid base64 JSON");
    }

    // Determine the nonce up front so a failure can still be recorded.
    const nonce =
      payment.payload?.authorization?.nonce ??
      (payment.payload?.transaction as string | undefined) ??
      "";

    // Fail closed locally even when a real facilitator is configured. The
    // facilitator is an external HTTP hop; a 200 + `{isValid:true}` must
    // not mint credits for a payload that is short, on the wrong network,
    // or paying someone else. The mock already uses this check; the real
    // path used to skip it.
    const shape = validatePaymentShape(payment, requirements, cfg);
    if (!shape.ok) {
      if (nonce) {
        await ctx.runMutation(internal.x402.recordFailedPayment, {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          agentId: scope.agentId,
          nonce,
          reason: shape.reason,
          facilitator: cfg.facilitatorUrl ?? "mock",
        });
      }
      throw new ConvexError(`Payment failed: ${shape.reason}`);
    }

    const facilitatorLabel = cfg.facilitatorUrl ?? "mock";
    const result = cfg.facilitatorUrl
      ? await facilitatorSettle(cfg.facilitatorUrl, payment, requirements)
      : mockSettle(payment, requirements);

    if (!result.ok) {
      await ctx.runMutation(internal.x402.recordFailedPayment, {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        agentId: scope.agentId,
        nonce: shape.nonce,
        reason: result.reason ?? "settlement failed",
        facilitator: facilitatorLabel,
      });
      throw new ConvexError(`Payment failed: ${result.reason ?? "unknown"}`);
    }

    // Shape validation already required a nonce. Prefer it over a
    // facilitator-chosen tx ref so two accepted payloads cannot mint twice
    // under different replay keys.
    const settlementNonce = shape.nonce;
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
