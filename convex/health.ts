import { query } from "./_generated/server";

// Public and deliberately content-free: Vercel, uptime monitors, and release
// automation can prove that the application can reach its system of record
// without possessing a user or agent credential. Config flags are presence
// only — never values — so a stranger cannot read secrets from /api/health.
export const ping = query({
  args: {},
  handler: async () => {
    const payTo = (process.env.X402_PAY_TO ?? "").trim();
    return {
      ok: true,
      config: {
        resend: Boolean(
          process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL,
        ),
        openai: Boolean(process.env.OPENAI_API_KEY),
        ably: Boolean(process.env.ABLY_API_KEY),
        x402Facilitator: Boolean(process.env.X402_FACILITATOR_URL),
        x402PayTo: Boolean(payTo) && !/^0x0{40}$/i.test(payTo),
        adminAllowlist: Boolean(
          (process.env.PLATFORM_ADMIN_EMAILS ?? "").trim(),
        ),
        deviceProxy: Boolean(process.env.DEVICE_PROXY_SECRET),
      },
    };
  },
});
