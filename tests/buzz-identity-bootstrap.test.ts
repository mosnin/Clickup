import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";

// The bootstrap that makes Chat writable at all.
//
// Every Chat write publishes a signed event, so it needs a signing key, and a
// mutation cannot mint one (no CSPRNG — see convex/buzz/keys.ts). Minting is a
// Node action that only the client can start, which means the guarantee "a
// reader in Chat has a key" is not enforceable inside Convex: it is a wiring
// obligation on the shell. This file holds both halves of it.
//
// It exists because that wiring was missing outright. `buzz.keys.mint` was
// referenced nowhere in `src/`, so no human principal was ever given a key and
// every Chat write threw "has no Chat signing key yet" — channels, messages,
// joins, reactions. The rest of the buzz suite did not catch it because those
// tests insert `buzzKeys` rows in their own setup: they prove the backend
// behaves correctly *given* a key, which is a different claim from the app
// producing one.

const modules = import.meta.glob("../convex/**/*.*s");
const keys = anyApi.buzz.keys;
const channels = anyApi.buzz.channels;
const identity = anyApi.buzz.identity;

const ALICE = { subject: "user_alice" };

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

/**
 * A workspace with a member who has **no** `buzzKeys` row — deliberately unlike
 * every other buzz test's fixture, because that is the state every real user is
 * in the first time they open Chat.
 */
async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: "alice@example.test",
      name: "Alice",
    });
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: id,
      role: "owner",
      joinedAt: Date.now(),
    });
    return id;
  });
  return { t, scope: { scopeType: "workspace" as const, scopeId: workspaceId } };
}

describe("the Chat signing-key bootstrap", () => {
  it("is what stands between a fresh reader and every write in Chat", async () => {
    const { t, scope } = await seed();
    const alice = t.withIdentity(ALICE);

    // Precondition, stated rather than assumed: this is the state the app was
    // shipping in for every user.
    expect(await alice.query(identity.myPubkey, {})).toEqual({ pubkey: null });

    // Note the sentence a real user was getting, which is its own small proof
    // that this was never their doing: "has not opened Chat yet" — said to
    // somebody who is standing in Chat, having opened it, trying to use it.
    await expect(
      alice.mutation(channels.create, { ...scope, name: "design" }),
    ).rejects.toThrow(/has not opened Chat yet|no Chat signing key/i);
  });

  it("mints once, and that is enough to create a channel", async () => {
    const { t, scope } = await seed();
    const alice = t.withIdentity(ALICE);

    const minted = await alice.action(keys.mint, { principal: { type: "user" } });
    expect(minted.created).toBe(true);
    expect(minted.pubkey).toMatch(/^[0-9a-f]{64}$/);

    // The write that was failing in production. No fixture key was inserted:
    // the only thing that changed is the call the shell now makes on mount.
    const channelId = await alice.mutation(channels.create, { ...scope, name: "design" });
    expect(channelId).toBeTruthy();
  });

  it("is idempotent, because the shell calls it on every load", async () => {
    const { t } = await seed();
    const alice = t.withIdentity(ALICE);

    const first = await alice.action(keys.mint, { principal: { type: "user" } });
    const second = await alice.action(keys.mint, { principal: { type: "user" } });

    expect(second.created).toBe(false);
    // The same identity, not a second one. Two live keys for one principal
    // would mean half this person's events were signed by a key the other half
    // of the product does not recognise.
    expect(second.pubkey).toBe(first.pubkey);
    const rows = await t.run((ctx) => ctx.db.query("buzzKeys").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("the shell's obligation", () => {
  // Convex cannot enforce this: minting is a client-started action, so "a
  // reader in Chat has a key" is only true if the shell asks for one. That
  // makes the wiring itself the thing to guard — the bug was never a wrong
  // line of code, it was an absent one, and only a test that reads the shell
  // can see an absence.
  it("mounts the bootstrap in the Chat shell", () => {
    const shell = readFileSync(
      new URL("../src/components/chat/shell/chat-shell.tsx", import.meta.url),
      "utf8",
    );
    expect(shell).toMatch(/<EnsureChatIdentity\s*\/>/);
    expect(shell).toMatch(/from "\.\/ensure-chat-identity"/);
  });

  it("mints through the action, since a mutation has no CSPRNG", () => {
    const bootstrap = readFileSync(
      new URL("../src/components/chat/shell/ensure-chat-identity.tsx", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain("buzz/keys:mint");
    // Minting on a query that has not answered yet would fire a redundant
    // action on every single load.
    expect(bootstrap).toContain("identity === undefined");
  });
});
