// Who signs, and who signed.
//
// The Chat log is a log of *signed* events (00-decisions.md D1/D2), so every
// write path needs one more thing than the Work side ever did: the private key
// of the principal doing the writing. This file is the only place that answers
// that question, in both directions —
//
//   forward   principal → the key it signs with   (requireSigningIdentity)
//   backward  pubkey    → the principal it names  (principalForPubkey)
//
// and it is deliberately *not* where keys are made. Generation needs a CSPRNG,
// a Convex mutation is deterministic by construction, and so minting lives in
// the `"use node"` action in ./keys.ts. The consequence is the single most
// important rule in this file: **a mutation cannot mint.** See
// requireSigningIdentity for what that means for a principal with no key.
//
// This file also owns the `buzzKeys` table — every read and every write of it.
// keys.ts holds only the randomness, because a `"use node"` module may export
// nothing but actions, and because "generate 32 bytes" and "decide who is
// allowed to have an identity" are different jobs that should not share a file.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireIdentity } from "../_authz";
import type { Actor } from "../_agentAuth";
import { publicKeyFromSecret } from "./_nostr";
import { relaySigningIdentity } from "./relay";

/** What the principal half of a key row looks like as an argument. */
const principalType = v.union(v.literal("user"), v.literal("agent"));

export type PrincipalType = "user" | "agent";

/** A principal: a Clerk subject, or an `agents` document id. */
export type Principal = { type: PrincipalType; id: string };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The pubkey a principal signs with *now*, or null if it has none yet.
 *
 * Live key only. This answers a forward-looking question — "who is this
 * principal, address them / show them / expect their next event under this
 * key" — and a retired key answers it wrongly: it names a real identity that
 * nothing new will ever be signed by. `principalForPubkey` is the function for
 * the historical direction, and it deliberately does the opposite.
 */
export async function pubkeyFor(
  ctx: QueryCtx,
  principal: PrincipalType,
  principalId: string,
): Promise<string | null> {
  const row = await liveKeyRow(ctx, principal, principalId);
  return row?.pubkey ?? null;
}

/**
 * The principal behind a pubkey — including a **retired** one.
 *
 * This is the read that makes rotation safe. An event is signed once and kept
 * forever; a year later its `pubkey` field still has to name somebody, and if
 * rotation had deleted the old row every message that principal ever wrote
 * would render as an anonymous 64-hex string. Retiring rather than deleting is
 * what buys "old events stay verifiable *and* attributable forever" — the
 * signature itself needs no row at all (verification is pure: sig, id, pubkey),
 * but the *name* does.
 */
export async function principalForPubkey(
  ctx: QueryCtx,
  pubkey: string,
): Promise<Principal | null> {
  const row = await ctx.db
    .query("buzzKeys")
    .withIndex("by_pubkey", (q) => q.eq("pubkey", pubkey))
    .first();
  if (!row) return null;
  return { type: row.principalType, id: row.principalId };
}

/**
 * The key an actor signs an event with, or a loud refusal.
 *
 * Called from inside the publish transaction, immediately before signing, so
 * that an event and its signature are produced together (D2). The returned
 * `secretKey` never leaves the server: it goes straight into `signEvent` and
 * the caller keeps the signed event, not the key.
 *
 * Three things this deliberately does *not* do:
 *
 * 1. **It does not mint.** A mutation has no CSPRNG, so it could not generate a
 *    real key even if we wanted it to; the alternative — a fixed or derived
 *    "key" — is a forgeable identity, which is worse than no identity. So a
 *    keyless principal is a hard error, and the error names the bootstrap that
 *    should have run. If you ever see it, a surface let somebody reach a
 *    composer without going through that bootstrap: it is a wiring bug, not
 *    something a user did.
 *
 *    Where the bootstrap runs: **every entry into Chat mints first.** For a
 *    person that is the Chat shell, which calls the `buzz.keys.mint` action
 *    once on mount, exactly the way `<EnsureUser />` bootstraps the user row —
 *    idempotent, so it is safe on every load and cheap after the first. For an
 *    agent it is the moment the agent is attached to a room (a human action,
 *    running in an action context where minting is possible), never the
 *    agent's own first write — an agent must not be able to summon its own
 *    identity, because that is what makes governance identity-scoped rather
 *    than flag-scoped (02-agents.md §10.3).
 *
 * 2. **It does not fall back to writing unsigned.** There is no unsigned path
 *    to fall back to. An "unsigned event" is not a degraded event, it is a
 *    different kind of object that the rest of the log cannot verify, order or
 *    attribute — one of them in the table and the log's whole guarantee is
 *    "signed, except the ones that aren't".
 *
 * 3. **It does not re-authorize the actor.** The caller resolved this `Actor`
 *    from Clerk or from an agent API key already; checking again here would be
 *    a second answer to a question that has one, and the two would drift.
 */
export async function requireSigningIdentity(
  ctx: MutationCtx,
  actor: Actor,
): Promise<{ pubkey: string; secretKey: string }> {
  if (actor.type === "system") {
    // One exception, and it is narrower than the rule it sits under: a
    // *community relay* (./relay.ts). Relay-signed kinds — membership
    // notifications, a room's system rows — exist so that a member cannot
    // forge them, so somebody has to be able to sign them, and that somebody
    // is the community rather than the deployment: one keypair per workspace
    // or personal space, derived from a deployment secret, never stored.
    // `relaySigningIdentity` returns null for every other system actor, so the
    // refusal below is unchanged for the case it was written about.
    const relay = relaySigningIdentity(actor);
    if (relay) return relay;

    // A cron or a scheduler has no identity to sign as, and giving the system
    // a shared keypair would put events in the log whose author is "the
    // server" — unattributable, unrevokable, and indistinguishable from a
    // compromised one. System-triggered work must be attributed to the
    // principal it acts for, which means the caller picks an Actor before it
    // gets here.
    throw new ConvexError(
      "The Chat log has no system identity: a system-triggered event must be attributed to the user or agent it acts for.",
    );
  }

  const row = await liveKeyRow(ctx, actor.type, actor.id);
  if (!row) {
    throw new ConvexError(
      `${actor.name || actor.id} has no Chat signing key yet. Keys are minted by the buzz.keys.mint action (a Node action — a mutation has no CSPRNG and cannot mint one); this principal reached a write without that bootstrap having run.`,
    );
  }
  return { pubkey: row.pubkey, secretKey: row.secretKey };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * A pubkey, as something a person can read.
 *
 * Kept separate from `principalForPubkey` rather than folded into it because
 * they fail differently and are called from different places: resolution is
 * exact and is used by write paths, whereas display is best-effort — a key
 * whose user row was deleted still has to render *something* rather than
 * throw in the middle of a transcript. Every message in the UI calls this, so
 * callers rendering a window of messages should cache by pubkey (see
 * `chat.thread`'s author cache for the shape).
 */
export async function describePubkey(
  ctx: QueryCtx,
  pubkey: string,
): Promise<{
  type: PrincipalType;
  id: string;
  name: string;
  isAgent: boolean;
} | null> {
  const principal = await principalForPubkey(ctx, pubkey);
  if (!principal) return null;

  if (principal.type === "agent") {
    // normalizeId rather than a cast: a principalId that is no longer a valid
    // agents id (an agent deleted, or a row written by an older build) must
    // read as "unknown agent", not crash the transcript it appears in.
    const agentId = ctx.db.normalizeId("agents", principal.id);
    const agent = agentId ? await ctx.db.get(agentId) : null;
    return {
      ...principal,
      name: agent?.name ?? "Unknown agent",
      isAgent: true,
    };
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", principal.id))
    .unique();
  return {
    ...principal,
    name: user?.name ?? user?.email ?? "Someone",
    isAgent: false,
  };
}

// ---------------------------------------------------------------------------
// The caller's own identity, for the UI
// ---------------------------------------------------------------------------

/**
 * The signed-in user's Chat pubkey, or null before the mint bootstrap has run.
 *
 * Returns the public half and nothing else. There is no query or mutation
 * anywhere that returns `secretKey` — the field exists only inside the two
 * internal mutations below and inside `requireSigningIdentity`, whose caller
 * is a signing transaction rather than a client. `tests/buzz-identity.test.ts`
 * asserts that shape rather than trusting this comment.
 */
export const myPubkey = query({
  args: {},
  handler: async (ctx): Promise<{ pubkey: string | null }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { pubkey: null };
    return { pubkey: await pubkeyFor(ctx, "user", identity.subject) };
  },
});

// ---------------------------------------------------------------------------
// Writes — internal only, driven by the Node action in ./keys.ts
// ---------------------------------------------------------------------------

/**
 * Store a freshly generated keypair, or hand back the one that already exists.
 *
 * Internal because the only legitimate caller is `keys.mint`, which has done
 * the access check and produced the randomness. Note what that means for the
 * split: **the transaction, not the action, is where idempotency is decided.**
 * The action cannot check-then-write without a window in between, and two
 * mints racing through that window would give one principal two live keys —
 * at which point half its events are signed by a key the other half of the
 * product does not recognise. Re-checking here, inside the transaction that
 * inserts, closes it: the loser of the race discards its keypair (which was
 * never anywhere) and returns the winner's pubkey.
 *
 * This is also why `mint` generates unconditionally instead of asking first.
 * A wasted keypair costs a hash; a TOCTOU window costs an identity.
 */
export const storeKey = internalMutation({
  args: {
    principalType,
    principalId: v.string(),
    pubkey: v.string(),
    secretKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pubkey: string; created: boolean }> => {
    assertKeypairAgrees(args.pubkey, args.secretKey);
    const existing = await liveKeyRow(ctx, args.principalType, args.principalId);
    if (existing) return { pubkey: existing.pubkey, created: false };

    await ctx.db.insert("buzzKeys", {
      principalType: args.principalType,
      principalId: args.principalId,
      pubkey: args.pubkey,
      secretKey: args.secretKey,
      createdAt: Date.now(),
    });
    return { pubkey: args.pubkey, created: true };
  },
});

/**
 * Rotate: retire the live key and insert a new one, in one transaction.
 *
 * One transaction because the two halves are the same act. Retire-then-insert
 * across two calls leaves a window with no live key, during which every write
 * by that principal fails; insert-then-retire leaves a window with two, during
 * which which key signs is a coin flip.
 *
 * The old row is retired, never deleted. Its events keep verifying — the
 * signature is over the event id and checks against the pubkey embedded in the
 * event, so it needs nothing from this table — but `principalForPubkey` needs
 * the row to keep saying *whose* those events are. Deleting it would silently
 * anonymise the principal's entire history, which is exactly the outcome
 * rotation is supposed to be safe against.
 */
export const rotateKey = internalMutation({
  args: {
    principalType,
    principalId: v.string(),
    pubkey: v.string(),
    secretKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pubkey: string; retiredPubkey: string | null }> => {
    assertKeypairAgrees(args.pubkey, args.secretKey);
    const now = Date.now();

    // Plural on purpose: if an older build ever left two live rows, rotation
    // is the moment to converge on one rather than the moment to inherit the
    // ambiguity.
    const live = await ctx.db
      .query("buzzKeys")
      .withIndex("by_principal", (q) =>
        q
          .eq("principalType", args.principalType)
          .eq("principalId", args.principalId)
          .eq("retiredAt", undefined),
      )
      .collect();
    for (const row of live) await ctx.db.patch(row._id, { retiredAt: now });

    await ctx.db.insert("buzzKeys", {
      principalType: args.principalType,
      principalId: args.principalId,
      pubkey: args.pubkey,
      secretKey: args.secretKey,
      createdAt: now,
    });
    return { pubkey: args.pubkey, retiredPubkey: live[0]?.pubkey ?? null };
  },
});

/**
 * The user half of "may I mint for this principal": who is calling.
 *
 * A principal id for a person is never an argument — it is read from the
 * authenticated session here, so there is no field a caller could put somebody
 * else's Clerk subject into. Minting for yourself needs no membership check (a
 * personal space is your own), but it does go through `requireIdentity`, which
 * is where an account hold is enforced: a suspended user must not be able to
 * acquire a *fresh* signing identity any more than they can write with an old
 * one.
 *
 * The agent half is not here, because it already exists —
 * `internal.agents._assertManageAccess` is this codebase's one answer to "may
 * this person govern this agent", and `keys.mint` calls it rather than
 * re-deriving a second one that would drift from workspace roles.
 */
export const currentSubject = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ subject: string }> => {
    return await requireIdentity(ctx);
  },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function liveKeyRow(
  ctx: QueryCtx | MutationCtx,
  principal: PrincipalType,
  principalId: string,
): Promise<Doc<"buzzKeys"> | null> {
  // `retiredAt: undefined` is part of the index key, so "the live one" is an
  // index range rather than a filter over every key this principal ever held.
  return await ctx.db
    .query("buzzKeys")
    .withIndex("by_principal", (q) =>
      q
        .eq("principalType", principal)
        .eq("principalId", principalId)
        .eq("retiredAt", undefined),
    )
    .first();
}

/**
 * Refuse to store a pubkey that is not the public half of the secret beside it.
 *
 * The action derives both, so this can only fire on a bug — but the row it
 * would otherwise write is permanently broken in the worst way: every event
 * signed with it claims an author whose signature verifies against nobody, and
 * the failure surfaces at read time, in somebody else's client, long after the
 * cause. Cheap check, unbounded blast radius avoided.
 */
function assertKeypairAgrees(pubkey: string, secretKey: string): void {
  if (publicKeyFromSecret(secretKey) !== pubkey) {
    throw new ConvexError("Refusing to store a keypair whose halves disagree");
  }
}
