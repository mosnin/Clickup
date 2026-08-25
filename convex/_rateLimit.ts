import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";

// Fixed-window rate limiting, keyed by an opaque string.
//
// Generic because there are already three callers with nothing in common
// except needing a ceiling: unauthenticated device-code creation (keyed by
// IP), authenticated user-code lookup (keyed by Clerk subject), and approval
// attempts. Writing three bespoke counters is how a limit ends up missing
// from the fourth caller.
//
// Fixed windows rather than sliding, deliberately. A sliding window needs one
// row per hit to know what to expire, and a table that grows per request is
// precisely the thing being defended against. The cost is that a caller can
// burst up to 2× the limit across a window boundary; for these callers —
// where the limit exists to make brute force expensive, not to smooth load —
// that factor of two changes nothing.
//
// Same shape as the agentUsage counters in _agentAuth.ts, on purpose.

export type RateLimitRule = {
  /** Distinct budget name, so two callers sharing a subject don't collide. */
  name: string;
  /** Hits permitted per window. */
  limit: number;
  windowMs: number;
};

// The window a timestamp falls in. Integer division, so every caller in the
// same window agrees on its identity without storing a start time.
function windowId(now: number, windowMs: number) {
  return Math.floor(now / windowMs);
}

/**
 * Count one hit against `rule` for `subject`.
 *
 * Returns the number of hits remaining after this one. Throws a ConvexError
 * when the budget is spent — the message is deliberately vague about how
 * close the caller is, since the callers being limited are hostile.
 */
export async function consumeRateLimit(
  ctx: MutationCtx,
  rule: RateLimitRule,
  subject: string,
  message: string,
): Promise<number> {
  const now = Date.now();
  const window = windowId(now, rule.windowMs);
  const key = `${rule.name}:${subject}`;

  const existing = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  // A row from an older window is reused rather than deleted: one row per
  // key forever, so the table is bounded by distinct callers rather than by
  // traffic. Retention prunes rows nobody has touched in a while.
  if (!existing) {
    await ctx.db.insert("rateLimits", {
      key,
      window,
      count: 1,
      updatedAt: now,
    });
    return rule.limit - 1;
  }

  if (existing.window !== window) {
    await ctx.db.patch(existing._id, { window, count: 1, updatedAt: now });
    return rule.limit - 1;
  }

  if (existing.count >= rule.limit) {
    throw new ConvexError(message);
  }

  await ctx.db.patch(existing._id, {
    count: existing.count + 1,
    updatedAt: now,
  });
  return rule.limit - existing.count - 1;
}

// ── The rules ──────────────────────────────────────────────────────────

// Unauthenticated. Generous enough that a developer restarting an agent in a
// loop never notices, tight enough that one host cannot fill the table.
export const DEVICE_REQUEST_RULE: RateLimitRule = {
  name: "device_create",
  limit: 30,
  windowMs: 10 * 60 * 1000,
};

// Dynamic client registration is intentionally unauthenticated, but it must
// not be an unbounded database-write endpoint. OpenAI reuses a registered
// client, so this ceiling is far above normal traffic while still containing
// a single source that tries to manufacture clients in a loop.
export const DCR_REGISTRATION_RULE: RateLimitRule = {
  name: "oauth_dcr",
  limit: 60,
  windowMs: 10 * 60 * 1000,
};

// The one that matters.
//
// A person connecting an agent types one code, gets it wrong at most a
// couple of times, and is done. Someone making hundreds of lookups is
// enumerating — and the payoff for a hit is binding somebody else's agent
// runtime to a workspace they control, so the ceiling is low and the window
// is long. Legitimate use never approaches it.
export const CODE_LOOKUP_RULE: RateLimitRule = {
  name: "code_lookup",
  limit: 20,
  windowMs: 10 * 60 * 1000,
};

// Invite tokens are capability URLs. A person accepting one they were sent
// never needs more than a handful of tries; hundreds of accepts is guessing.
export const INVITE_ACCEPT_RULE: RateLimitRule = {
  name: "invite_accept",
  limit: 20,
  windowMs: 10 * 60 * 1000,
};
