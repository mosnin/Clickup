import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";

// Focused create-channel coverage for the launch blocker.
//
// `tests/buzz-channels.test.ts` already walks names, templates, tenancy.
// This file is the four cases the create form can actually hit on a first
// visit: it works, a clash says so, a first-time user can mint then create,
// and a leftover `public` is accepted (stored as `open`) while a garbage
// visibility is refused.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const keys = anyApi.buzz.keys;
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

async function seed(opts: { withKey?: boolean } = {}) {
  const withKey = opts.withKey ?? true;
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
  const alice = t.withIdentity(ALICE);
  if (withKey) {
    await alice.action(keys.mint, { principal: { type: "user" } });
  }
  return { t, alice, scope: { scopeType: "workspace" as const, scopeId: workspaceId } };
}

describe("buzz/channels:create", () => {
  it("creates an open stream and returns the canonical name", async () => {
    const { alice, scope } = await seed();
    const created = (await alice.mutation(channels.create, {
      ...scope,
      name: "Release Notes",
      visibility: "open",
      channelType: "stream",
    })) as { channelId: string; name: string };
    expect(created.name).toBe("release-notes");
    expect(created.channelId).toMatch(/^[0-9a-f]{64}$/);

    const room = (await alice.query(channels.get, {
      ...scope,
      channelId: created.channelId,
    })) as { visibility: string; name: string };
    expect(room.visibility).toBe("public");
    expect(room.name).toBe("release-notes");
  });

  it("refuses a name clash with a sentence that names the room", async () => {
    const { alice, scope } = await seed();
    await alice.mutation(channels.create, { ...scope, name: "ops" });
    await expect(alice.mutation(channels.create, { ...scope, name: "#OPS" })).rejects.toThrow(
      /#ops already exists/,
    );
  });

  it("works for a first-time user once they mint — create does not require a prior key fixture", async () => {
    const { alice, scope } = await seed({ withKey: false });
    expect(await alice.query(identity.myPubkey, {})).toEqual({ pubkey: null });

    await expect(alice.mutation(channels.create, { ...scope, name: "design" })).rejects.toThrow(
      /signing identity|signing key/i,
    );

    const minted = await alice.action(keys.mint, { principal: { type: "user" } });
    expect(minted.created).toBe(true);

    const created = (await alice.mutation(channels.create, {
      ...scope,
      name: "design",
    })) as { channelId: string };
    expect(created.channelId).toBeTruthy();
  });

  it("accepts the leftover visibility public and stores it as open", async () => {
    const { alice, scope } = await seed();
    const created = (await alice.mutation(channels.create, {
      ...scope,
      name: "general",
      visibility: "public",
    })) as { channelId: string };
    const room = (await alice.query(channels.get, {
      ...scope,
      channelId: created.channelId,
    })) as { visibility: string };
    expect(room.visibility).toBe("public");
  });

  it("accepts leftover kind: channel as a stream", async () => {
    const { alice, scope } = await seed();
    const created = (await alice.mutation(channels.create, {
      ...scope,
      name: "ops",
      kind: "channel",
    })) as { channelId: string };
    const room = (await alice.query(channels.get, {
      ...scope,
      channelId: created.channelId,
    })) as { kind: string };
    expect(room.kind).toBe("channel");
  });

  it("refuses a garbage visibility before anything is written", async () => {
    const { t, alice, scope } = await seed();
    await expect(
      alice.mutation(channels.create, {
        ...scope,
        name: "nope",
        // The validator's job: a word that is not open/private/public never
        // reaches the handler, so it cannot be stored.
        visibility: "secret",
      }),
    ).rejects.toThrow(/ArgumentValidation|does not match validator|Validator/i);
    const rows = await t.run((ctx) => ctx.db.query("buzzChannels").collect());
    expect(rows).toHaveLength(0);
  });
});
