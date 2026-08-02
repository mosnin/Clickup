// The relay principal: the one signer a member cannot be.
//
// Buzz's log has two classes of author. Most events are written by a person or
// an agent and signed with that principal's own key. A small set is written by
// the *relay* — the membership notifications (44100/44101), the system rows in
// a channel (40099), the huddle roster deltas (48101–48103), the group-state
// rollups (39000–39002). Those exist precisely so they cannot be forged by a
// member: "Ada was removed from #ops" is only worth anything if Ada could not
// have written it herself. `_kinds.ts` marks them `relaySigned` and refuses
// them from any actor whose type is not `"system"`.
//
// Which left them unwritable, and that was recorded as a known blocker in C2b:
// `identity.ts` refuses to sign for a `"system"` actor, on the correct grounds
// that a shared server keypair puts unattributable, unrevokable events in the
// log — indistinguishable from a compromised one, and belonging to no tenant.
//
// This file is the way out, and it is one idea: **the relay is not the
// deployment, it is the community.** Every community (a workspace, or a
// person's personal space — D4) has its own relay identity, with its own
// keypair and therefore its own pubkey on every event it signs. So:
//
//   (a) a member cannot forge one. Two independent locks, and they are in
//       different places on purpose. The vocabulary lock: `validateEvent`
//       refuses a relay-signed kind from a `user` or `agent` actor, and no
//       client-reachable surface constructs a `system` actor — `log.publish`
//       builds a user actor out of the Clerk session, and the agent surface
//       builds an agent actor out of an API key. The cryptographic lock: even
//       a caller who reached the write path could not produce the *signature*,
//       because the relay's secret is derived from a deployment secret that no
//       query returns and no row holds.
//   (b) it is attributable to a community rather than to the deployment. One
//       keypair per scope, so an exported event says which community's relay
//       signed it, and a compromise is bounded by that community rather than
//       by the install.
//   (c) `identity.ts`'s refusal stands. It is extended by exactly one branch,
//       and the extension is narrower than the rule it sits under: a bare
//       `system` actor — a cron, a scheduler, "the server" — is refused
//       exactly as before. Only an actor naming a *community relay principal*
//       resolves, and this file is the only thing that can name one.
//
// Why the key is derived rather than stored, which is the one place this
// departs from "minted like any other":
//
//   - **A mutation cannot mint.** Generation needs a CSPRNG; a Convex mutation
//     is deterministic by construction, which is why `keys.ts` is a `"use
//     node"` action. But a membership notification has to be written *in the
//     same transaction as the membership row* — a change that is committed and
//     a notification that is scheduled are two things that can disagree. A
//     stored relay key would mean every channel write depended on a bootstrap
//     action having already run for that community, and the failure mode of a
//     missed bootstrap is a silent one: the room works, and nobody is told
//     anything. Derivation is available in every transaction, for every
//     community, with no bootstrap at all.
//   - **`buzzKeys` cannot describe it anyway.** Its `principalType` is
//     `user | agent`, and a relay is neither; filing it as one would make
//     `principalForPubkey` name the community relay as a person.
//   - A pleasant consequence: no relay private key exists in the database, so
//     a database dump does not contain one.
//
// The cost, stated rather than hidden: the seed is a deployment secret, so
// rotating it rotates every community's relay identity. Events signed by the
// old one keep verifying forever — a signature checks against the pubkey
// carried on the event and needs nothing from here — but `relayPubkeyFor` will
// no longer match them. Nothing should recognise a relay event by comparing
// pubkeys for that reason; recognise it by its *kind*, which is structural: a
// relay-signed kind can only have been written by a relay.

import { ConvexError } from "convex/values";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Actor } from "../_agentAuth";
import { kindSpec } from "./_kinds";
import { publicKeyFromSecret } from "./_nostr";
// Type-only, and that matters: `identity.ts` imports this module, and `log.ts`
// imports `identity.ts`. A value import of `log.ts` here would close that ring
// at runtime. `import type` is erased outright under `isolatedModules`, so the
// shapes are shared and the cycle never exists.
import type { PublishArgs, Scope } from "./log";

/** The deployment secret every community relay key is derived from. */
export const RELAY_SEED_ENV = "BUZZ_RELAY_SEED";

/**
 * How short a seed is too short to be one.
 *
 * 32 characters, so `BUZZ_RELAY_SEED=dev` is refused rather than accepted as a
 * relay identity anybody can reproduce. The check is cheap and it catches the
 * only realistic misuse: a placeholder set during setup and never replaced.
 */
const MIN_SEED_LENGTH = 32;

/**
 * Names a relay principal apart from any other principal id.
 *
 * A Clerk subject is `user_…` and an agent id is a Convex document id, so this
 * prefix cannot collide with either — but the reason it exists is not
 * collision avoidance. It is that `parseRelayPrincipalId` must be able to get
 * the *community* back out of the actor, because that is what decides which
 * key signs, and an id that did not carry it would need a second argument that
 * some call site would eventually get wrong.
 */
const RELAY_PRINCIPAL_PREFIX = "relay:";

/** The secp256k1 group order. A secret key is an integer in [1, n-1]. */
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Domain separation. Every hash this file computes is prefixed with a string
 * naming what it is for, so the same seed used for something else can never
 * produce the same bytes. Versioned, so a future change to the derivation is a
 * new namespace rather than a silent re-keying of every community.
 */
const DERIVATION_DOMAIN = "operate.to/buzz/relay/v1";

// ---------------------------------------------------------------------------
// The principal
// ---------------------------------------------------------------------------

/** `relay:workspace:<id>` — the community relay's principal id. */
export function relayPrincipalId(scope: Scope): string {
  return `${RELAY_PRINCIPAL_PREFIX}${scope.scopeType}:${scope.scopeId}`;
}

/**
 * The community behind a relay principal id, or null if this is not one.
 *
 * Null rather than a throw: this is the predicate `identity.ts` uses to tell a
 * relay actor from an ordinary `system` actor, and "not a relay" is an
 * expected, ordinary answer there — the refusal that follows it is the one
 * that was already written.
 */
export function parseRelayPrincipalId(principalId: string): Scope | null {
  if (!principalId.startsWith(RELAY_PRINCIPAL_PREFIX)) return null;
  const rest = principalId.slice(RELAY_PRINCIPAL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const scopeType = rest.slice(0, separator);
  const scopeId = rest.slice(separator + 1);
  if (scopeType !== "user" && scopeType !== "workspace") return null;
  if (scopeId.length === 0) return null;
  return { scopeType, scopeId };
}

/**
 * The actor a relay-signed publish is made under.
 *
 * `type: "system"` because that is what `validateEvent` requires of a
 * relay-signed kind (§16.21), and `id` names the community so
 * `requireSigningIdentity` can resolve the right key. The name is what appears
 * in an error message, so it says what it is rather than "system".
 */
export function relayActor(scope: Scope): Actor {
  return {
    type: "system",
    id: relayPrincipalId(scope),
    name: `${scope.scopeType === "user" ? "personal" : "workspace"} relay`,
  };
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

function relaySeed(): string {
  const seed = process.env[RELAY_SEED_ENV]?.trim();
  if (!seed || seed.length < MIN_SEED_LENGTH) {
    // Fail closed, loudly, naming the fix. The alternative — falling back to a
    // constant so that an unconfigured deployment "works" — would hand every
    // install the same relay identity, which is precisely the forgeable,
    // unattributable identity this whole file exists to avoid. A Chat that
    // refuses to write a system message is recoverable in one command; a Chat
    // whose membership notifications anyone can mint is not recoverable at all.
    throw new ConvexError(
      `Chat has no relay identity: set a high-entropy ${RELAY_SEED_ENV} (at least ${MIN_SEED_LENGTH} characters) on the Convex deployment — npx convex env set ${RELAY_SEED_ENV} $(openssl rand -hex 32)`,
    );
  }
  return seed;
}

/**
 * The community's relay keypair, derived from the seed and the scope.
 *
 * A hash of (domain ‖ seed ‖ scope ‖ counter), rejected and re-hashed if it
 * lands outside [1, n-1]. The counter loop is not paranoia theatre about
 * probability — it is the same rule `schnorr.utils.randomPrivateKey` follows,
 * and a "one in 2^128" branch that is wrong is a key that silently fails to
 * sign years later, in production, for one community.
 *
 * Deterministic on purpose. It is what lets the relay sign inside the
 * transaction that changes membership, with no minting step, no stored secret,
 * and no bootstrap for a community that has never had a channel before.
 */
export function relayKeypairFor(scope: Scope): { pubkey: string; secretKey: string } {
  const seed = relaySeed();
  for (let counter = 0; counter < 256; counter += 1) {
    const digest = sha256(
      utf8ToBytes(
        // A NUL separator so that ("ab", "c") and ("a", "bc") cannot hash the
        // same — a scope id cannot contain one. Written as an escape rather
        // than a raw byte: a literal NUL makes the file register as binary,
        // git shows no diff and grep skips it (the same trap log.ts hit).
        `${DERIVATION_DOMAIN}\u0000${seed}\u0000${scope.scopeType}\u0000${scope.scopeId}\u0000${counter}`,
      ),
    );
    const secretKey = bytesToHex(digest);
    const scalar = BigInt(`0x${secretKey}`);
    if (scalar > 0n && scalar < SECP256K1_N) {
      return { pubkey: publicKeyFromSecret(secretKey), secretKey };
    }
  }
  // Unreachable short of a broken hash: every iteration has a ~1 - 2^-128
  // chance of landing in range. Loud anyway, because the alternative to a
  // throw here is an infinite loop inside a transaction.
  throw new ConvexError("Could not derive a relay key for this community");
}

/**
 * The public half, for display and verification. Never returns the secret.
 *
 * Callers wanting to render "who wrote this" for a relay event may compare
 * against this — but see the file header: prefer the event's *kind*, which
 * survives a seed rotation.
 */
export function relayPubkeyFor(scope: Scope): string {
  return relayKeypairFor(scope).pubkey;
}

/**
 * An unguessable, deterministic label for a string inside one community.
 *
 * It lives here because this is the module that holds the seed, and it exists
 * for one job: a room's id is the id of the event that created it, so that
 * event needs something unique in it, and the obvious candidate — the room's
 * name — is the one thing a private room is keeping. A keyed hash gives the
 * event uniqueness without carrying the name: two rooms created in the same
 * second differ, and a member reading the community-wide log learns that a room
 * was created and nothing about which.
 *
 * Deterministic, so the same name in the same community produces the same
 * label — which is harmless, because a second room by that name is refused by
 * the uniqueness rule long before its event is built.
 */
export function communityNonce(scope: Scope, label: string): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        `${DERIVATION_DOMAIN}/nonce\u0000${relaySeed()}\u0000${scope.scopeType}\u0000${scope.scopeId}\u0000${label}`,
      ),
    ),
  );
}

/**
 * The extension point `identity.requireSigningIdentity` calls.
 *
 * Returns a keypair **only** for an actor that is a community relay, and null
 * for every other `system` actor — which is what keeps identity.ts's refusal
 * intact rather than weakened. A cron, a scheduler, a backfill: all still
 * refused, and refused with the sentence that was already there.
 *
 * Note what is *not* checked here: whether the caller is allowed to write. It
 * is not this function's job, and it could not do it — there is no caller.
 * A relay publish is only reachable from server code that has already run the
 * tenancy fence for the scope it then hands to `relayActor`.
 */
export function relaySigningIdentity(
  actor: Actor,
): { pubkey: string; secretKey: string } | null {
  if (actor.type !== "system") return null;
  const scope = parseRelayPrincipalId(actor.id);
  if (!scope) return null;
  return relayKeypairFor(scope);
}

// ---------------------------------------------------------------------------
// Publishing as the relay
// ---------------------------------------------------------------------------

/**
 * Build the `publishCore` arguments for a relay-signed event.
 *
 * This module deliberately does **not** call `publishCore` itself. `log.ts` is
 * the only module allowed to put an event in the table and that is worth more
 * than the convenience of a one-line wrapper — a second writer is how tag
 * projection, replacement and the channel fence end up with two
 * implementations. So the relay decides *who signs and what may be signed*,
 * and the log stays the only thing that writes.
 *
 * The kind check is the "only signer permitted for relay-signed kinds" rule
 * read in the other direction: the relay may sign **nothing else**. Without
 * it, a bug elsewhere could post an ordinary message (kind 9) as the relay,
 * and a message that appears to come from the room itself is the most
 * authoritative-looking thing in the product.
 */
export function asRelay(
  scope: Scope,
  draft: { kind: number; tags: string[][]; content: string },
): PublishArgs {
  const spec = kindSpec(draft.kind);
  if (!spec?.relaySigned) {
    throw new ConvexError(
      `The relay may only sign relay-signed kinds; kind ${draft.kind} is not one`,
    );
  }
  return {
    actor: relayActor(scope),
    scope,
    kind: draft.kind,
    tags: draft.tags,
    content: draft.content,
  };
}
