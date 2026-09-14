"use client";

// The Chat signing-key bootstrap.
//
// Every write in Chat publishes a signed event, and `requireSigningIdentity`
// (convex/buzz/identity.ts) refuses — loudly, by design — for a principal with
// no key. Its own comment names the bootstrap that is supposed to have run:
//
//   > Where the bootstrap runs: **every entry into Chat mints first.** For a
//   > person that is the Chat shell, which calls the `buzz.keys.mint` action
//   > once on mount, exactly the way `<EnsureUser />` bootstraps the user row.
//
// That component did not exist. Nothing in `src/` referenced `buzz.keys.mint`,
// so no human principal had ever been given a key, so *every* Chat write threw
// — creating a channel, sending a message, joining a room, reacting. The
// backend was right and complete; it was simply never called.
//
// Worth recording why the tests did not catch it, because the shape recurs:
// they insert `buzzKeys` rows directly in their setup and then assert the
// refusal fires for a principal without one. So they prove the backend behaves
// correctly *given* a key, and nothing at any level proved the application ever
// produces one. `tests/buzz-channels.test.ts` even models the keyless user as a
// fixture — "DANA: in the workspace, but never opens Chat — so never has a
// signing key" — which in production described every single user.
//
// Why a component and not a call inside some mutation: a mutation has no
// CSPRNG and cannot mint (see keys.ts). Minting is a Node action, so the client
// is the only thing that can start it, and the shell is the one place every
// entry into Chat passes through. Idempotency lives in the transaction
// (`identity.storeKey` re-checks inside the insert), so calling this on every
// load is safe and cheap after the first.

import { useCallback, useEffect, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";
import { myPubkeyRef } from "@/components/chat/presence/refs";

// Named by hand for the reason `presence/refs.ts` documents: the checked-in
// `convex/_generated/api.d.ts` stub predates `convex/buzz/*`, so
// `api.buzz.keys.mint` does not typecheck until the CLI regenerates it. The
// path resolves identically at runtime.
export const mintRef = makeFunctionReference<
  "action",
  { principal: { type: "user" } },
  { pubkey: string; created: boolean }
>("buzz/keys:mint");

/**
 * The same functions `mintRef` / `myPubkeyRef` name, reached through the
 * generated `api` path proxy so a UI test can seed `buzz.identity.myPubkey`
 * and assert `buzz.keys.mint`. Runtime resolution is identical.
 */
const buzzIdentity = (
  api as unknown as {
    buzz: {
      identity: {
        myPubkey: FunctionReference<
          "query",
          "public",
          Record<string, never>,
          { pubkey: string | null } | null
        >;
      };
      keys: {
        mint: FunctionReference<
          "action",
          "public",
          { principal: { type: "user" } },
          { pubkey: string; created: boolean }
        >;
      };
    };
  }
).buzz;

/**
 * Awaitable half of the bootstrap: mint if this principal has no key yet.
 *
 * The shell's `<EnsureChatIdentity />` is fire-and-forget, so a first-visit
 * create can race it and land on "has no signing identity". Create (and any
 * other write that must not dead-end on first open) calls this first. Mint
 * is idempotent — a key that already exists comes back and nothing is written.
 */
export function useEnsureChatIdentity(): () => Promise<string | null> {
  // `api.buzz.*` via the path proxy so a UI test can see `buzz.keys.mint`
  // and seed `buzz.identity.myPubkey`. `mintRef` / `myPubkeyRef` stay the
  // runtime names the shell bootstrap and its wiring test already pin.
  const identity = useQuery(buzzIdentity.identity.myPubkey, {});
  const mint = useAction(buzzIdentity.keys.mint);
  return useCallback(async () => {
    if (identity?.pubkey) return identity.pubkey;
    try {
      const minted = await mint({ principal: { type: "user" } });
      return minted?.pubkey ?? null;
    } catch {
      return identity?.pubkey ?? null;
    }
  }, [identity, mint]);
}

/** How many times to try before leaving it to the write path to complain. */
const MAX_ATTEMPTS = 3;

export function EnsureChatIdentity() {
  const identity = useQuery(myPubkeyRef, {});
  const mint = useAction(mintRef);
  // Not state: a re-render must not restart a mint that is already in flight,
  // and finishing one is already observable through `identity` updating.
  const attempts = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    // `undefined` is "the query has not answered yet", which is not the same
    // as "no key" — minting on it would fire a redundant action on every load.
    if (identity === undefined) return;
    if (identity?.pubkey) return;
    if (inFlight.current || attempts.current >= MAX_ATTEMPTS) return;

    inFlight.current = true;
    attempts.current += 1;
    void mint({ principal: { type: "user" } })
      .catch(() => {
        // Deliberately quiet. The next attempt is one re-render away, and if
        // all of them fail the write the reader actually tries will surface a
        // real error naming this bootstrap — which is more useful than a toast
        // about a key, a word most people using Chat have no reason to know.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [identity, mint]);

  return null;
}
