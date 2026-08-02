"use node";

// Minting a Chat identity.
//
// This file exists for exactly one reason: **key generation is the only part
// of the Chat substrate that needs randomness.** Everything else — hashing an
// event, signing it, verifying it — is deterministic and runs in the default
// V8 runtime, which is what lets an event be signed inside the transaction
// that writes it (00-decisions.md D2). A secp256k1 secret key cannot be
// derived from anything the caller already has, so it has to come from a
// CSPRNG, and a Convex mutation forbids randomness. Hence a `"use node"`
// action, and hence nothing else in this file.
//
// Modelled on convex/agentKeys.ts, which is the existing template for the same
// shape: generate in Node, write through an internal mutation, and hand the
// caller only the half it is allowed to see. The difference is which half that
// is. An API key is a bearer credential, so agentKeys returns the plaintext
// once and stores only a hash — the server never needs the original again. A
// signing key is the opposite: the *server* needs it forever (it signs on the
// principal's behalf, in the mutation) and the *caller* never needs it at all.
// So the secret is stored in full and returned to nobody, and what comes back
// is the pubkey — the public name of the identity, which is on every event
// anyway.
//
// A `"use node"` module may export only actions, which is why the table reads,
// the table writes and the access rules all live in ./identity.ts. That split
// is not an inconvenience to work around: it is the reason the one operation
// that needs a weaker runtime cannot quietly grow into the one that decides
// who is allowed to have an identity.

import { ConvexError, v } from "convex/values";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { action } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { publicKeyFromSecret } from "./_nostr";

/**
 * The three internal functions in ./identity.ts this action drives.
 *
 * Referenced through `anyApi` rather than `internal.buzz.identity` because the
 * checked-in `convex/_generated/api.d.ts` is a hand-rolled stub that predates
 * `convex/buzz/` and only `npx convex dev` can regenerate it (07-integration-map
 * §5). `anyApi` resolves the same paths at runtime; the cast is here so the
 * call sites below keep real argument and return types instead of `any`, which
 * is the part that would actually cost something. **Delete this block and use
 * `internal.buzz.identity.*` the first time the CLI regenerates the stub** —
 * a hand-written signature that outlives its generated twin is a signature
 * that will eventually describe a function that no longer looks like that.
 */
type KeyWriteArgs = {
  principalType: "user" | "agent";
  principalId: string;
  pubkey: string;
  secretKey: string;
};
const identityApi = anyApi.buzz.identity as unknown as {
  currentSubject: FunctionReference<
    "query",
    "internal",
    Record<string, never>,
    { subject: string }
  >;
  storeKey: FunctionReference<
    "mutation",
    "internal",
    KeyWriteArgs,
    { pubkey: string; created: boolean }
  >;
  rotateKey: FunctionReference<
    "mutation",
    "internal",
    KeyWriteArgs,
    { pubkey: string; retiredPubkey: string | null }
  >;
};

/**
 * Which principal to mint for.
 *
 * A discriminated union rather than `{principalType, principalId}` because the
 * two cases genuinely differ in where the id comes from, and the shape should
 * say so: minting for a person takes **no id at all** — it is read from the
 * authenticated session — so there is no argument in which one user could pass
 * another user's Clerk subject. An agent does need an id, and that id is
 * governance-checked. A flat `{type, id}` pair would make "mint for anybody"
 * expressible and leave a comment as the only thing preventing it.
 */
const principalArg = v.union(
  v.object({ type: v.literal("user") }),
  v.object({ type: v.literal("agent"), agentId: v.id("agents") }),
);

type PrincipalArg = { type: "user" } | { type: "agent"; agentId: Id<"agents"> };

/**
 * A fresh secp256k1 keypair, as lowercase hex.
 *
 * `schnorr.utils.randomPrivateKey()` rather than 32 raw CSPRNG bytes: a valid
 * secret key is an integer in [1, n-1], and while a uniform 32-byte string is
 * astronomically unlikely to fall outside that, "astronomically unlikely" is
 * how you get a key that silently fails to sign years later. noble rejects and
 * resamples; it is the curve's own answer, and it costs nothing.
 */
function generateKeypair(): { pubkey: string; secretKey: string } {
  const secretKey = bytesToHex(schnorr.utils.randomPrivateKey());
  return { pubkey: publicKeyFromSecret(secretKey), secretKey };
}

/**
 * Resolve the principal *and* check the caller may mint for it.
 *
 * Both branches delegate; neither invents a rule. "Who am I" is
 * `identity.currentSubject`, which goes through `_authz.requireIdentity` and
 * therefore inherits account holds. "May I govern this agent" is
 * `agents._assertManageAccess`, the same internal query `agentKeys.createKey`
 * uses — so a Chat signing key follows exactly the same workspace-role rules
 * as an API key, and a personal agent stays self-managed. Inventing a second
 * governance notion here is how an agent ends up mintable by someone who
 * cannot pause it.
 */
async function resolvePrincipal(
  ctx: ActionCtx,
  principal: PrincipalArg,
): Promise<{ principalType: "user" | "agent"; principalId: string }> {
  if (principal.type === "agent") {
    // Throws if the caller cannot manage this agent.
    await ctx.runQuery(internal.agents._assertManageAccess, {
      agentId: principal.agentId,
    });
    return { principalType: "agent", principalId: principal.agentId };
  }
  const { subject } = await ctx.runQuery(identityApi.currentSubject, {});
  return { principalType: "user", principalId: subject };
}

/**
 * Mint the principal's Chat signing key, or return the one it already has.
 *
 * **Idempotent**, and that is the contract callers rely on: this is the shell's
 * bootstrap, called on every entry into Chat, so it has to be safe to call a
 * thousand times. A principal that already has a live key gets that key's
 * *pubkey* back and nothing is written — never a second key (two live keys
 * means half a principal's events are signed by an identity the other half of
 * the product does not recognise), and never the secret (see the file header:
 * no caller has any use for it, so no caller is given it).
 *
 * The check that makes it idempotent is inside `identity.storeKey`, not here.
 * An action cannot read-then-write atomically, so two concurrent bootstraps
 * would both see "no key" and both insert. Generating unconditionally and
 * letting the transaction decide costs one discarded keypair in a race and
 * removes the window entirely.
 */
export const mint = action({
  args: { principal: principalArg },
  handler: async (
    ctx,
    { principal },
  ): Promise<{ pubkey: string; created: boolean }> => {
    // Redundant with the checks inside resolvePrincipal, and kept anyway:
    // it turns "not signed in" into that sentence at the action boundary
    // instead of whatever the first internal call happens to say.
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError("Not authenticated");
    }

    const target = await resolvePrincipal(ctx, principal);
    const keypair = generateKeypair();
    return await ctx.runMutation(identityApi.storeKey, {
      ...target,
      ...keypair,
    });
  },
});

/**
 * Rotate: retire the current key and mint a replacement.
 *
 * The thing rotation must not do is invalidate history, and it doesn't — a
 * signature verifies against the pubkey carried *on the event*, so every event
 * signed by the retired key still verifies forever, with no reference to this
 * table at all. What the retired row keeps providing is the *name*: it stays
 * in `buzzKeys` with `retiredAt` set so `principalForPubkey` can still say
 * whose those old events were. Deleting it would leave a year of messages
 * signed by a 64-hex string belonging to nobody.
 *
 * Deliberately not idempotent, unlike `mint` — "give me a new key" means a new
 * key every time, and quietly returning the existing one would make a rotation
 * requested after a suspected leak look like it happened when it did not.
 */
export const rotate = action({
  args: { principal: principalArg },
  handler: async (
    ctx,
    { principal },
  ): Promise<{ pubkey: string; retiredPubkey: string | null }> => {
    // Redundant with the checks inside resolvePrincipal, and kept anyway:
    // it turns "not signed in" into that sentence at the action boundary
    // instead of whatever the first internal call happens to say.
    if (!(await ctx.auth.getUserIdentity())) {
      throw new ConvexError("Not authenticated");
    }

    const target = await resolvePrincipal(ctx, principal);
    const keypair = generateKeypair();
    return await ctx.runMutation(identityApi.rotateKey, {
      ...target,
      ...keypair,
    });
  },
});
