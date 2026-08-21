import { servingOrigin } from "@/lib/oauth-resource";

const OFFICIAL_ORIGIN = "https://www.operate.to";

// The origin baked into generated shell scripts.
//
// Stricter than oauthIssuer() on purpose: this value ends up inside a script
// people pipe into `sh`, so a misconfigured env var must degrade to the real
// site rather than to whatever it happens to say. Anything with credentials,
// a path, a query, or a non-HTTPS scheme is not a deployment origin and is
// refused rather than repaired. Apex is valid HTTPS but 308s POSTs, so it
// is rewritten to www — `/connect` POSTs the device grant and the token
// exchange, and a 308 would drop both bodies.
export function publicOrigin(): string {
  const configured = process.env.OPERATE_PUBLIC_URL;
  if (!configured) return OFFICIAL_ORIGIN;
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return OFFICIAL_ORIGIN;
    }
    return servingOrigin(parsed.origin);
  } catch {
    return OFFICIAL_ORIGIN;
  }
}
