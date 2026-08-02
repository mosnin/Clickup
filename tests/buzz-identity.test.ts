import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import {
  describePubkey,
  principalForPubkey,
  pubkeyFor,
  requireSigningIdentity,
} from "../convex/buzz/identity";
import { eventId, signEvent, verifyEvent } from "../convex/buzz/_nostr";
import type { Actor } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");

// `convex/_generated/api.d.ts` is a hand-rolled stub that has not been
// regenerated since convex/buzz/ was added (`npx convex dev` is not available
// in this environment), so the typed `api`/`internal` objects have no `buzz`
// namespace yet. `anyApi` resolves the same function paths at runtime — this
// is only a typing escape hatch, and it disappears the moment the CLI runs.
const buzzKeysApi = anyApi.buzz.keys;

const OWNER = { subject: "user_owner", email: "owner@example.com" };
const MEMBER = { subject: "user_member", email: "member@example.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@example.com" };

const HEX64 = /^[0-9a-f]{64}$/;

/** A workspace with an owner, an ordinary member, and one workspace agent. */
async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, MEMBER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: MEMBER.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "atlas-01",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    return { workspaceId, agentId };
  });
}

/** Every buzzKeys row, newest last — the tests assert on the table directly. */
async function keyRows(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("buzzKeys").collect());
}

// ── Minting ────────────────────────────────────────────────────────────────
describe("buzz key minting", () => {
  it("mints one keypair for the caller and is idempotent thereafter", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    const first = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    expect(first.created).toBe(true);
    expect(first.pubkey).toMatch(HEX64);

    // The bootstrap runs on every entry into Chat, so calling it again must be
    // a no-op that returns the same identity — not a second key.
    const second = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    expect(second.created).toBe(false);
    expect(second.pubkey).toBe(first.pubkey);

    const rows = await keyRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].principalType).toBe("user");
    expect(rows[0].principalId).toBe(OWNER.subject);
    expect(rows[0].retiredAt).toBeUndefined();
  });

  it("stores a real keypair: the stored pubkey is the public half of the stored secret", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t
      .withIdentity(OWNER)
      .action(buzzKeysApi.mint, { principal: { type: "user" } });

    const [row] = await keyRows(t);
    expect(row.secretKey).toMatch(HEX64);
    // Sign something with the stored secret and check it verifies against the
    // stored pubkey — the only end-to-end proof that the row is usable at all.
    const signed = signEvent(
      { pubkey: row.pubkey, created_at: 1, kind: 1, tags: [], content: "hi" },
      row.secretKey,
    );
    expect(verifyEvent(signed)).toBe(true);
  });

  it("gives a user and an agent separate identities", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    const mine = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    const theirs = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "agent", agentId },
    });

    // An agent is a member with its own identity, not a flag on its owner's
    // (02-agents.md §10.3) — the whole point is that its events stay
    // distinguishable in the log forever without trusting a boolean column.
    expect(theirs.pubkey).not.toBe(mine.pubkey);
    expect(await keyRows(t)).toHaveLength(2);
  });

  it("refuses to mint for an agent the caller does not govern", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);

    // An ordinary workspace member can see the fleet but not manage it.
    await expect(
      t
        .withIdentity(MEMBER)
        .action(buzzKeysApi.mint, { principal: { type: "agent", agentId } }),
    ).rejects.toThrow(/owners and admins/i);

    // Somebody outside the workspace entirely.
    await expect(
      t
        .withIdentity(OUTSIDER)
        .action(buzzKeysApi.mint, { principal: { type: "agent", agentId } }),
    ).rejects.toThrow(/forbidden/i);

    // A refused mint writes nothing.
    expect(await keyRows(t)).toHaveLength(0);
  });

  it("refuses to mint for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await expect(
      t.action(buzzKeysApi.mint, { principal: { type: "user" } }),
    ).rejects.toThrow(/not authenticated/i);
    expect(await keyRows(t)).toHaveLength(0);
  });
});

// ── The secret never crosses a public boundary ─────────────────────────────
describe("buzz key secrecy", () => {
  it("never returns secretKey from a public function", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    const results: unknown[] = [
      await asOwner.action(buzzKeysApi.mint, { principal: { type: "user" } }),
      await asOwner.action(buzzKeysApi.mint, { principal: { type: "user" } }),
      await asOwner.action(buzzKeysApi.mint, {
        principal: { type: "agent", agentId },
      }),
      await asOwner.action(buzzKeysApi.rotate, { principal: { type: "user" } }),
      await asOwner.query(anyApi.buzz.identity.myPubkey, {}),
    ];

    const secrets = (await keyRows(t)).map((r) => r.secretKey);
    // Not vacuous: the secrets really are stored, and really are 64-hex.
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) expect(s).toMatch(HEX64);

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/secretKey/);
      for (const s of secrets) expect(serialized).not.toContain(s);
    }
  });

  it("myPubkey answers with the public half, or null before the bootstrap", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    expect(await asOwner.query(anyApi.buzz.identity.myPubkey, {})).toEqual({
      pubkey: null,
    });
    const minted = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    expect(await asOwner.query(anyApi.buzz.identity.myPubkey, {})).toEqual({
      pubkey: minted.pubkey,
    });
  });
});

// ── Resolution: pubkey ⇄ principal ─────────────────────────────────────────
describe("buzz identity resolution", () => {
  it("round-trips a principal to its pubkey and back, for both kinds", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    const user = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    const agent = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "agent", agentId },
    });

    await t.run(async (ctx) => {
      expect(await pubkeyFor(ctx, "user", OWNER.subject)).toBe(user.pubkey);
      expect(await pubkeyFor(ctx, "agent", agentId)).toBe(agent.pubkey);

      expect(await principalForPubkey(ctx, user.pubkey)).toEqual({
        type: "user",
        id: OWNER.subject,
      });
      expect(await principalForPubkey(ctx, agent.pubkey)).toEqual({
        type: "agent",
        id: agentId,
      });
    });
  });

  it("answers null rather than throwing for an unknown principal or pubkey", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t.run(async (ctx) => {
      expect(await pubkeyFor(ctx, "user", "user_nobody")).toBeNull();
      expect(await principalForPubkey(ctx, "0".repeat(64))).toBeNull();
      expect(await describePubkey(ctx, "0".repeat(64))).toBeNull();
    });
  });

  it("names a pubkey for display, for a person and for an agent", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);
    await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", OWNER.subject))
        .unique()
        .then((u) => ctx.db.patch(u!._id, { name: "Ada" })),
    );

    const user = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });
    const agent = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "agent", agentId },
    });

    await t.run(async (ctx) => {
      expect(await describePubkey(ctx, user.pubkey)).toEqual({
        type: "user",
        id: OWNER.subject,
        name: "Ada",
        isAgent: false,
      });
      expect(await describePubkey(ctx, agent.pubkey)).toEqual({
        type: "agent",
        id: agentId,
        name: "atlas-01",
        isAgent: true,
      });
    });
  });
});

// ── Signing identity ───────────────────────────────────────────────────────
describe("requireSigningIdentity", () => {
  const userActor: Actor = { type: "user", id: OWNER.subject, name: "Ada" };

  it("hands the live keypair to a signing transaction", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const minted = await t
      .withIdentity(OWNER)
      .action(buzzKeysApi.mint, { principal: { type: "user" } });

    await t.run(async (ctx) => {
      const signer = await requireSigningIdentity(ctx, userActor);
      expect(signer.pubkey).toBe(minted.pubkey);
      // It really is the signing key: an event signed with it verifies.
      const event = signEvent(
        {
          pubkey: signer.pubkey,
          created_at: 100,
          kind: 9,
          tags: [],
          content: "hello",
        },
        signer.secretKey,
      );
      expect(event.id).toBe(eventId(event));
      expect(verifyEvent(event)).toBe(true);
    });
  });

  it("refuses a keyless principal: it neither mints nor signs unsigned", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);

    await t.run(async (ctx) => {
      await expect(
        requireSigningIdentity(ctx, userActor),
      ).rejects.toThrow(/no Chat signing key/i);
    });

    // The refusal is the whole point — a mutation has no CSPRNG, so the only
    // alternatives to failing are a forgeable key or an unsigned event. Both
    // would be silent; nothing was written.
    expect(await keyRows(t)).toHaveLength(0);
  });

  it("refuses a system actor rather than inventing a server identity", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t.run(async (ctx) => {
      await expect(
        requireSigningIdentity(ctx, {
          type: "system",
          id: "cron",
          name: "system",
        }),
      ).rejects.toThrow(/no system identity/i);
    });
  });
});

// ── Rotation ───────────────────────────────────────────────────────────────
describe("buzz key rotation", () => {
  it("retires the old key, installs exactly one new live key, and keeps history verifiable", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const asOwner = t.withIdentity(OWNER);

    const old = await asOwner.action(buzzKeysApi.mint, {
      principal: { type: "user" },
    });

    // An event written before the rotation, signed with the old key.
    const oldSecret = (await keyRows(t))[0].secretKey;
    const historic = signEvent(
      {
        pubkey: old.pubkey,
        created_at: 1,
        kind: 9,
        tags: [],
        content: "written before the rotation",
      },
      oldSecret,
    );

    const rotated = await asOwner.action(buzzKeysApi.rotate, {
      principal: { type: "user" },
    });
    expect(rotated.retiredPubkey).toBe(old.pubkey);
    expect(rotated.pubkey).not.toBe(old.pubkey);

    const rows = await keyRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.retiredAt === undefined)).toHaveLength(1);
    expect(rows.find((r) => r.pubkey === old.pubkey)?.retiredAt).toBeGreaterThan(
      0,
    );

    // The signature never needed the table, so history keeps verifying …
    expect(verifyEvent(historic)).toBe(true);
    await t.run(async (ctx) => {
      // … and the retired row is what keeps it *attributable*: the old pubkey
      // still names its author, while "who is this principal now" moves on.
      expect(await principalForPubkey(ctx, old.pubkey)).toEqual({
        type: "user",
        id: OWNER.subject,
      });
      expect(await pubkeyFor(ctx, "user", OWNER.subject)).toBe(rotated.pubkey);
      const signer = await requireSigningIdentity(ctx, {
        type: "user",
        id: OWNER.subject,
        name: "Ada",
      });
      expect(signer.pubkey).toBe(rotated.pubkey);
    });
  });

  it("refuses to rotate an agent key for someone who does not govern the agent", async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await seedWorkspace(t);
    await t
      .withIdentity(OWNER)
      .action(buzzKeysApi.mint, { principal: { type: "agent", agentId } });

    await expect(
      t
        .withIdentity(MEMBER)
        .action(buzzKeysApi.rotate, { principal: { type: "agent", agentId } }),
    ).rejects.toThrow(/owners and admins/i);

    expect(await keyRows(t)).toHaveLength(1);
  });
});
