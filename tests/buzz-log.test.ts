import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret, verifyEvent, eventId } from "../convex/buzz/_nostr";
import {
  KINDS,
  SEARCHABLE_KINDS,
  eventIsShared,
  storageClassForKind,
  validateEvent,
} from "../convex/buzz/_kinds";
import { publishCore, readEventsCore, type Scope } from "../convex/buzz/log";

const modules = import.meta.glob("../convex/**/*.*s");

// `anyApi` rather than the generated `api`, for one reason that is worth
// stating: `convex/_generated/api.d.ts` is a hand-rolled stub checked in so a
// fresh clone typechecks, and it predates `convex/buzz/*`. Only `npx convex dev`
// may rewrite it, and it is not run here. The function references below resolve
// identically at runtime — convex-test finds them through the module glob.
const log = anyApi.buzz.log;

// Two principals, two fixed keys. Deterministic on purpose: several of the
// assertions below are about *which* of two events wins a tie, and a tie is
// broken by comparing event ids — so a random key would make the interesting
// test pass or fail depending on the day.
const ALICE_SK = "01".repeat(32);
const BOB_SK = "02".repeat(32);
const ALICE_PK = publicKeyFromSecret(ALICE_SK);
const BOB_PK = publicKeyFromSecret(BOB_SK);

const alice = { type: "user" as const, id: "user_alice", name: "Alice" };
const bob = { type: "user" as const, id: "user_bob", name: "Bob" };

const aliceScope: Scope = { scopeType: "user", scopeId: "user_alice" };
const bobScope: Scope = { scopeType: "user", scopeId: "user_bob" };

const NOW = () => Math.floor(Date.now() / 1000);

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];

async function seedKeys(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: Ctx) => {
    await ctx.db.insert("users", { clerkId: alice.id, email: "a@x.test", name: "Alice" });
    await ctx.db.insert("users", { clerkId: bob.id, email: "b@x.test", name: "Bob" });
    await ctx.db.insert("buzzKeys", {
      principalType: "user",
      principalId: alice.id,
      pubkey: ALICE_PK,
      secretKey: ALICE_SK,
      createdAt: Date.now(),
    });
    await ctx.db.insert("buzzKeys", {
      principalType: "user",
      principalId: bob.id,
      pubkey: BOB_PK,
      secretKey: BOB_SK,
      createdAt: Date.now(),
    });
  });
}

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("the kind registry is closed and internally consistent", () => {
  it("derives storage class from the kind number alone", () => {
    // §16.4. `never` is the one exception and it is not about the number: those
    // kinds are executed or filed elsewhere, so if this ever disagrees for a
    // stored kind, one of the two answers is being used by the write path and
    // the other by the read path.
    for (const spec of KINDS.values()) {
      if (spec.storage === "never") continue;
      expect(spec.storage, `kind ${spec.kind}`).toBe(storageClassForKind(spec.kind));
    }
  });

  it("writes nothing in the 20000–29999 range", () => {
    // §16.22. `never` rather than `ephemeral` for 22242 and 27235, which happen
    // to fall in this range: they are auth credentials, so they are refused
    // before they are even signed rather than signed and fanned out.
    for (const spec of KINDS.values()) {
      if (spec.kind >= 20000 && spec.kind < 30000) {
        expect(["ephemeral", "never"], `kind ${spec.kind}`).toContain(spec.storage);
      }
    }
  });

  it("keeps every privacy-sensitive kind out of the search allowlist", () => {
    // §16.16: unsearchable at the storage layer. The allowlist is what makes
    // this true by construction, so nothing gated may appear in it.
    for (const spec of KINDS.values()) {
      if (spec.gate !== "open") {
        expect(SEARCHABLE_KINDS.has(spec.kind), `kind ${spec.kind}`).toBe(false);
      }
    }
  });

  it("refuses an unknown kind rather than storing it", () => {
    const verdict = validateEvent(
      { kind: 61234, created_at: NOW(), tags: [], content: "" },
      { now: NOW(), actorType: "user" },
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/unknown event kind/);
  });

  it("refuses an event whose timestamp is outside the drift window", () => {
    const verdict = validateEvent(
      { kind: 1, created_at: NOW() + 4000, tags: [], content: "hi" },
      { now: NOW(), actorType: "user" },
    );
    expect(!verdict.ok && verdict.reason).toMatch(/timestamp too far/);
  });

  it("refuses a channel-scoped kind with no h tag", () => {
    const verdict = validateEvent(
      { kind: 9, created_at: NOW(), tags: [], content: "hi" },
      { now: NOW(), actorType: "user" },
    );
    expect(!verdict.ok && verdict.reason).toMatch(/must include an h tag/);
  });
});

// ---------------------------------------------------------------------------
// The `shared` tag (§4, §16.15)
// ---------------------------------------------------------------------------

describe("the shared tag fails closed", () => {
  it("is true for exactly [\"shared\",\"true\"] and nothing else", () => {
    expect(eventIsShared([["shared", "true"]])).toBe(true);
    // Every one of these is a plausible near-miss, and every one of them means
    // "not shared": the tag is the entire difference between a private persona
    // and a published one, so anything ambiguous has to resolve to private.
    expect(eventIsShared([["shared"]])).toBe(false);
    expect(eventIsShared([["shared", "TRUE"]])).toBe(false);
    expect(eventIsShared([["shared", "1"]])).toBe(false);
    expect(eventIsShared([["shared", "true", "extra"]])).toBe(false);
    expect(eventIsShared([["shared", "true"], ["shared", "true"]])).toBe(false);
    expect(eventIsShared([["d", "x"]])).toBe(false);
  });

  it("refuses a malformed shared tag on a shared-gated kind at ingest", () => {
    const verdict = validateEvent(
      { kind: 30175, created_at: NOW(), tags: [["d", "p"], ["shared", "1"]], content: "{}" },
      { now: NOW(), actorType: "user" },
    );
    expect(!verdict.ok && verdict.reason).toMatch(/shared tag must be/);
  });

  it("stores the flag as false for any shape but the exact one", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      // Kind 1 is not shared-gated, so a stray tag is accepted — and read as
      // not-shared, which is the fail-closed direction.
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 1,
        tags: [["shared", "yes"]],
        content: "note",
      });
      const row = await ctx.db.query("buzzEvents").first();
      expect(row?.shared).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Storage: ephemeral, dedupe, replacement
// ---------------------------------------------------------------------------

describe("what the log stores", () => {
  it("signs an ephemeral event and stores nothing", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      const outcome = await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 20001, // presence heartbeat
        tags: [["status", "online"]],
        content: "online",
      });
      expect(outcome.status).toBe("ephemeral");
      // Still a real, verifiable event — it is fanned out, just never written.
      expect(verifyEvent(outcome.event)).toBe(true);
      expect(await ctx.db.query("buzzEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("buzzEventTags").collect()).toHaveLength(0);
    });
  });

  it("treats a resubmitted event as a duplicate, not an error", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      const args = {
        actor: alice,
        scope: aliceScope,
        kind: 1,
        tags: [],
        content: "same",
      };
      const first = await publishCore(ctx, { ...args, createdAt: NOW() });
      const again = await publishCore(ctx, { ...args, createdAt: first.event.created_at });
      expect(first.status).toBe("inserted");
      expect(again.status).toBe("duplicate");
      expect(again.event.id).toBe(first.event.id);
      expect(await ctx.db.query("buzzEvents").collect()).toHaveLength(1);
    });
  });

  it("indexes only the allowlisted kinds for search", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 9,
        tags: [["h", "room"]],
        content: "findable",
      });
      // A reminder is author-only and encrypted to its author. It must not be
      // in the index at all — not filtered out of results afterwards, absent,
      // because an absent entry cannot leak through a hit count either.
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 30300,
        tags: [["d", "reminder-1"], ["not_before", "1800000000"]],
        content: "encrypted-blob",
      });
      const rows = await ctx.db.query("buzzEvents").collect();
      const message = rows.find((r) => r.kind === 9);
      const reminder = rows.find((r) => r.kind === 30300);
      expect(message?.searchText).toBe("findable");
      expect(reminder?.searchText).toBeUndefined();
    });
  });
});

describe("replacement (§6, §16.5)", () => {
  const persona = (content: string, createdAt: number) => ({
    actor: alice,
    scope: aliceScope,
    kind: 30175,
    tags: [["d", "assistant"]],
    content,
    createdAt,
  });

  it("lets a newer created_at replace, and keeps the old row superseded", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      const base = NOW();
      const first = await publishCore(ctx, persona("v1", base));
      const second = await publishCore(ctx, persona("v2", base + 1));
      expect(first.status).toBe("inserted");
      expect(second.status).toBe("inserted");

      const rows = await ctx.db.query("buzzEvents").collect();
      // Both rows are kept: the log is append-only, and "what did this say
      // before" is the question an audit trail exists to answer.
      expect(rows).toHaveLength(2);
      const old = rows.find((r) => r.eventId === first.event.id);
      const live = rows.find((r) => r.eventId === second.event.id);
      expect(old?.supersededAt).toBeTypeOf("number");
      expect(live?.supersededAt).toBeUndefined();

      // And only the live one is readable.
      const read = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [30175], authors: [ALICE_PK] }],
        readerPubkey: ALICE_PK,
      });
      expect(read.map((e) => e.content)).toEqual(["v2"]);
    });
  });

  it("refuses an older created_at without inserting anything", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      const base = NOW();
      await publishCore(ctx, persona("v2", base));
      const stale = await publishCore(ctx, persona("v1", base - 60));
      // Not inserted *and* not fanned out — on this substrate those are the
      // same act, which is why the domination test has to run before the write.
      expect(stale.status).toBe("dominated");
      const rows = await ctx.db.query("buzzEvents").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("v2");
      // The loser left no trace in the tag index either.
      const tags = await ctx.db.query("buzzEventTags").collect();
      expect(tags.every((row) => row.eventId === rows[0].eventId)).toBe(true);
    });
  });

  it("breaks a same-second tie on the lowest event id, in both arrival orders", async () => {
    // Timestamps are seconds and an author writing twice in one second is
    // ordinary, so this is not a corner case. Two replicas handed the same pair
    // in different orders must keep the *same* winner or they diverge forever.
    // Pinned to server time, because `createdAt` still has to sit inside the
    // ±15 minute drift window — a tie is an ordinary event, not a stale one.
    const at = NOW();
    const idFor = (content: string) =>
      eventId({ pubkey: ALICE_PK, created_at: at, kind: 30175, tags: [["d", "assistant"]], content });
    const lower = idFor("A") < idFor("B") ? "A" : "B";
    const higher = lower === "A" ? "B" : "A";

    for (const [first, second] of [
      [lower, higher],
      [higher, lower],
    ]) {
      const t = harness();
      await seedKeys(t);
      await t.run(async (ctx: Ctx) => {
        const one = await publishCore(ctx, persona(first, at));
        const two = await publishCore(ctx, persona(second, at));
        expect(one.status).toBe("inserted");
        // A second write is refused only when it *loses* the tie; when it wins
        // it replaces the row already there. The invariant is not "the first
        // one wins" — it is that both orders end at the same head.
        expect(two.status).toBe(second === lower ? "inserted" : "dominated");
        const live = (await ctx.db.query("buzzEvents").collect()).filter(
          (r) => r.supersededAt === undefined,
        );
        expect(live).toHaveLength(1);
        expect(live[0].content).toBe(lower);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("the read path", () => {
  it("matches nothing for kinds: [] and everything for an absent kinds", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 9,
        tags: [["h", "room-1"]],
        content: "hello",
      });
      const room = [{ name: "h", values: ["room-1"] }];

      // An explicit empty list is a caller who narrowed to nothing — not a
      // caller who forgot to narrow.
      const none = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [], tags: room }],
        readerPubkey: ALICE_PK,
      });
      expect(none).toHaveLength(0);

      const all = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ tags: room }],
        readerPubkey: ALICE_PK,
      });
      expect(all).toHaveLength(1);

      // An empty filter *list* is the third case, and it matches nothing.
      const empty = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [],
        readerPubkey: ALICE_PK,
      });
      expect(empty).toHaveLength(0);
    });
  });

  it("never lets a channel-scoped event reach a global read", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 9,
        tags: [["h", "room-1"]],
        content: "in the room",
      });
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 1,
        tags: [],
        content: "community wide",
      });

      // The security boundary of §16.9: a global read is not "a read with a
      // wider filter", it is a different index, and a room's traffic is not in
      // it however well it matches.
      const global = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [1, 9] }],
        readerPubkey: ALICE_PK,
      });
      expect(global.map((e) => e.content)).toEqual(["community wide"]);

      const inRoom = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [1, 9], tags: [{ name: "h", values: ["room-1"] }] }],
        readerPubkey: ALICE_PK,
      });
      expect(inRoom.map((e) => e.content)).toEqual(["in the room"]);
    });
  });

  it("falls back to the stored channel only for an event with no h tag", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      const message = await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 9,
        tags: [["h", "room-1"]],
        content: "hello",
      });
      // A reaction carries no `h`: its room is derived from its target, which
      // is exactly the case the §5.3 fallback exists for. Without it,
      // {kinds:[7], #h:[…]} would return nothing and every room would look
      // like nobody reacts.
      await publishCore(ctx, {
        actor: bob,
        scope: aliceScope,
        kind: 7,
        tags: [["e", message.event.id]],
        content: "🎉",
      });

      const reactions = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [7], tags: [{ name: "h", values: ["room-1"] }] }],
        readerPubkey: ALICE_PK,
      });
      expect(reactions.map((e) => e.content)).toEqual(["🎉"]);

      // And a reaction to an unknown event is refused rather than stored
      // globally, where it would be readable community-wide.
      await expect(
        publishCore(ctx, {
          actor: bob,
          scope: aliceScope,
          kind: 7,
          tags: [["e", "f".repeat(64)]],
          content: "👻",
        }),
      ).rejects.toThrow(/target event not found/);
    });
  });

  it("applies the per-event gates on every read", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 30175,
        tags: [["d", "private-persona"]],
        content: "mine",
      });
      await publishCore(ctx, {
        actor: alice,
        scope: aliceScope,
        kind: 30175,
        tags: [["d", "public-persona"], ["shared", "true"]],
        content: "ours",
      });

      const asAuthor = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [30175] }],
        readerPubkey: ALICE_PK,
      });
      expect(asAuthor.map((e) => e.content).sort()).toEqual(["mine", "ours"]);

      // Same query, different reader. The shared gate is per event, so the
      // shared one still arrives — the alternative (refusing the whole read)
      // would make a shared persona unreachable.
      const asOther = await readEventsCore(ctx, {
        scope: aliceScope,
        filters: [{ kinds: [30175] }],
        readerPubkey: BOB_PK,
      });
      expect(asOther.map((e) => e.content)).toEqual(["ours"]);
    });
  });

  it("refuses a global read that could match a p-gated kind without naming the reader", async () => {
    const t = harness();
    await seedKeys(t);
    await t.run(async (ctx: Ctx) => {
      await expect(
        readEventsCore(ctx, {
          scope: aliceScope,
          filters: [{ kinds: [1059] }],
          readerPubkey: ALICE_PK,
        }),
      ).rejects.toThrow(/#p/);
      // Naming yourself is the whole requirement, and it is enough.
      await expect(
        readEventsCore(ctx, {
          scope: aliceScope,
          filters: [{ kinds: [1059], tags: [{ name: "p", values: [ALICE_PK] }] }],
          readerPubkey: ALICE_PK,
        }),
      ).resolves.toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tenancy (§15, §16.20)
// ---------------------------------------------------------------------------

describe("the tenancy fence", () => {
  it("makes an event unreachable from a scope its author could not reach", async () => {
    const t = harness();
    await seedKeys(t);

    const workspaceId = await t.run(async (ctx: Ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Acme",
        slug: "acme",
        ownerClerkId: alice.id,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        workspaceId: id,
        userClerkId: alice.id,
        role: "owner",
        joinedAt: Date.now(),
      });
      return id;
    });
    const workspaceScope: Scope = { scopeType: "workspace", scopeId: workspaceId };

    await t.run(async (ctx: Ctx) => {
      await publishCore(ctx, {
        actor: alice,
        scope: workspaceScope,
        kind: 1,
        tags: [],
        content: "internal",
      });
    });

    // Alice, a member, reads it.
    const mine = await t
      .withIdentity({ subject: alice.id })
      .query(log.read, { ...workspaceScope, filters: [{ kinds: [1] }] });
    expect(mine.map((e: { content: string }) => e.content)).toEqual(["internal"]);

    // Bob is not a member. The refusal comes from `requireScopeAccess` — the
    // same function the rest of the app uses, so there is one answer to "may
    // this person see this" rather than two that drift.
    await expect(
      t
        .withIdentity({ subject: bob.id })
        .query(log.read, { ...workspaceScope, filters: [{ kinds: [1] }] }),
    ).rejects.toThrow(/Forbidden/);

    // And the event is not visible from Bob's own scope either: scope is a
    // column on the row, not a filter applied to a shared pool.
    const fromBob = await t
      .withIdentity({ subject: bob.id })
      .query(log.read, { ...bobScope, filters: [{ kinds: [1] }] });
    expect(fromBob).toEqual([]);
  });

  it("refuses an unknown kind through the public mutation", async () => {
    const t = harness();
    await seedKeys(t);
    await expect(
      t.withIdentity({ subject: alice.id }).mutation(log.publish, {
        ...aliceScope,
        kind: 61234,
        tags: [],
        content: "nope",
      }),
    ).rejects.toThrow(/unknown event kind/);
  });

  it("publishes and reads back through the Clerk-authenticated surface", async () => {
    const t = harness();
    await seedKeys(t);
    const asAlice = t.withIdentity({ subject: alice.id });
    const outcome = await asAlice.mutation(log.publish, {
      ...aliceScope,
      kind: 1,
      tags: [["t", "hello"]],
      content: "first post",
    });
    expect(outcome.status).toBe("inserted");

    const byTag = await asAlice.query(log.read, {
      ...aliceScope,
      filters: [{ kinds: [1], tags: [{ name: "t", values: ["hello"] }] }],
    });
    expect(byTag.map((e: { id: string }) => e.id)).toEqual([outcome.eventId]);

    const one = await asAlice.query(log.readOne, {
      ...aliceScope,
      eventId: outcome.eventId,
    });
    expect(one?.content).toBe("first post");
    // What comes back is a real Nostr event, not our shape of one.
    expect(verifyEvent(one)).toBe(true);
  });
});
