// x402 protocol helpers (pure — no ctx, no db). Shared by the Convex
// functions in x402.ts (deterministic isolate) and the settlement action in
// x402Actions.ts (Node runtime). Implements the shapes from the x402 spec:
// an HTTP 402 challenge carries payment requirements; the client re-requests
// with an `X-PAYMENT` header carrying a base64-encoded, signed authorization;
// a facilitator verifies and settles it on-chain.
//
// In this platform, agents pay to top up a prepaid *credit* balance, and
// metered actions consume credits. Money never floats: amounts are atomic
// asset units (strings/BigInt) and credits are integers.

export const X402_VERSION = 1;
export const PAYMENT_REQUIRED_PREFIX = "X402_PAYMENT_REQUIRED:";

// Marker every metered-action shortfall throws. The MCP layer and the /api/
// x402 route recognize the prefix and surface the embedded requirements.
export function paymentRequiredError(payload: unknown): Error {
  return new Error(`${PAYMENT_REQUIRED_PREFIX} ${JSON.stringify(payload)}`);
}

export type X402Config = {
  network: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  payTo: string;
  facilitatorUrl: string | null;
  // Atomic asset units charged per 1 platform credit.
  creditPriceAtomic: number;
  // Credits consumed per metered agent action (when metering is enabled).
  actionCredits: number;
};

// Resolve config from deployment env vars, with testnet-friendly defaults so
// the flow works out of the box against the mock facilitator. Point these at
// mainnet + a real facilitator (X402_FACILITATOR_URL) for production.
export function x402Config(): X402Config {
  const env = (k: string): string | undefined => process.env[k] || undefined;
  return {
    network: env("X402_NETWORK") ?? "base-sepolia",
    // Base Sepolia USDC by default.
    asset: env("X402_ASSET") ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    assetSymbol: env("X402_ASSET_SYMBOL") ?? "USDC",
    assetDecimals: Number(env("X402_ASSET_DECIMALS") ?? "6"),
    payTo: env("X402_PAY_TO") ?? "0x0000000000000000000000000000000000000000",
    facilitatorUrl: env("X402_FACILITATOR_URL") ?? null,
    creditPriceAtomic: Number(env("X402_CREDIT_PRICE_ATOMIC") ?? "1000"),
    actionCredits: Number(env("X402_ACTION_CREDITS") ?? "1"),
  };
}

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
};

export type PaymentRequiredResponse = {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
};

// Atomic asset units owed for `credits` credits.
export function creditsToAtomic(credits: number, cfg: X402Config): string {
  return (BigInt(Math.trunc(credits)) * BigInt(cfg.creditPriceAtomic)).toString();
}

// How many whole credits an atomic payment buys (floor).
export function atomicToCredits(atomic: string, cfg: X402Config): number {
  const price = BigInt(cfg.creditPriceAtomic);
  if (price <= 0n) return 0;
  return Number(BigInt(atomic) / price);
}

// Human-readable price of `credits`, e.g. "1.00 USDC".
export function creditsToDisplayAmount(
  credits: number,
  cfg: X402Config,
): string {
  const atomic = BigInt(creditsToAtomic(credits, cfg));
  const scale = BigInt(10) ** BigInt(cfg.assetDecimals);
  const whole = atomic / scale;
  const frac = atomic % scale;
  const fracStr = frac
    .toString()
    .padStart(cfg.assetDecimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fracStr ? "." + fracStr : ""} ${cfg.assetSymbol}`;
}

// Build the x402 402 challenge body for buying `credits` credits.
export function buildPaymentRequired(
  credits: number,
  resource: string,
  cfg: X402Config,
): PaymentRequiredResponse {
  const maxAmountRequired = creditsToAtomic(credits, cfg);
  return {
    x402Version: X402_VERSION,
    accepts: [
      {
        scheme: "exact",
        network: cfg.network,
        maxAmountRequired,
        resource,
        description: `Top up ${credits} platform credit${credits === 1 ? "" : "s"}`,
        mimeType: "application/json",
        payTo: cfg.payTo,
        maxTimeoutSeconds: 120,
        asset: cfg.asset,
        extra: {
          name: cfg.assetSymbol,
          version: "2",
          decimals: cfg.assetDecimals,
          creditsGranted: credits,
          creditPriceAtomic: cfg.creditPriceAtomic,
          displayAmount: creditsToDisplayAmount(credits, cfg),
        },
      },
    ],
    error: "X-PAYMENT header required to purchase credits",
  };
}

// The decoded X-PAYMENT payload the client sends back (x402 "exact" scheme).
export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature?: string;
    authorization?: {
      from?: string;
      to?: string;
      value?: string;
      validAfter?: string;
      validBefore?: string;
      nonce?: string;
    };
    // Some facilitators accept a pre-broadcast transaction reference.
    transaction?: string;
    [k: string]: unknown;
  };
};

// Structural validation shared by the mock facilitator and real-facilitator
// pre-checks: right version/scheme/network and enough value authorized.
export function validatePaymentShape(
  payment: PaymentPayload,
  req: PaymentRequirements,
  cfg: X402Config,
): { ok: true; nonce: string; payer?: string } | { ok: false; reason: string } {
  if (payment.x402Version !== X402_VERSION)
    return { ok: false, reason: "unsupported x402Version" };
  if (payment.scheme !== req.scheme)
    return { ok: false, reason: "scheme mismatch" };
  if (payment.network !== cfg.network)
    return { ok: false, reason: "network mismatch" };
  const auth = payment.payload?.authorization;
  const nonce = auth?.nonce ?? (payment.payload?.transaction as string | undefined);
  if (!nonce) return { ok: false, reason: "missing payment nonce" };
  if (auth?.value !== undefined) {
    try {
      if (BigInt(auth.value) < BigInt(req.maxAmountRequired))
        return { ok: false, reason: "insufficient authorized amount" };
    } catch {
      return { ok: false, reason: "invalid amount" };
    }
  }
  if (auth?.to && req.payTo && auth.to.toLowerCase() !== req.payTo.toLowerCase())
    return { ok: false, reason: "wrong payTo address" };
  return { ok: true, nonce, payer: auth?.from };
}
