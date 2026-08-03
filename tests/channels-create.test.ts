import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

// `/dashboard/chat` creating a channel, end to end against the real schema.
//
// Written because the failure was reported twice and could not be diagnosed
// from the symptom. The toast says a generic "server error", and that is not a
// bug in the toast: `src/lib/errors.ts` documents that Convex redacts plain
// `Error` messages to "Server Error" on the wire in production, and only
// `ConvexError.data` survives. So an UNEXPECTED throw and a missing deployed
// function are indistinguishable from the outside, and both read as
// "convex error".
//
// This pins the half that can be tested: given a clean database and a signed-in
// member, `channels.create` succeeds for both scopes. If this file is green and
// the app still fails, the fault is NOT in this code path — it is the
// deployment, the data, or the OTHER chat product (`/chat`, backed by
// `convex/buzz/channels.ts`, a completely separate table).
//
// Note for whoever picks this up: those two Chat surfaces are a known
// unresolved decision, not an accident — `docs/buzz-parity/00-decisions.md`
// D11 accepted the duplication as transitional and the retirement never ran.
// Half the confusion about "which channel did my message go to" is that.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };

describe("dashboard chat: creating a channel", () => {
  it("succeeds in the personal scope", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: ALICE.subject,
        email: "alice@example.test",
        name: "Alice",
      });
    });

    const id = await t
      .withIdentity(ALICE)
      .mutation(anyApi.channels.create, {
        scopeType: "user",
        scopeId: ALICE.subject,
        name: "design",
      });
    expect(id).toBeTruthy();
  });

  it("succeeds in a workspace the caller belongs to", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: ALICE.subject,
        email: "alice@example.test",
        name: "Alice",
      });
      const w = await ctx.db.insert("workspaces", {
        name: "Acme",
        slug: "acme",
        ownerClerkId: ALICE.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        userClerkId: ALICE.subject,
        workspaceId: w,
        role: "owner",
        joinedAt: Date.now(),
      });
      return w;
    });

    const id = await t
      .withIdentity(ALICE)
      .mutation(anyApi.channels.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "general",
      });
    expect(id).toBeTruthy();
  });

  it("is idempotent — the same name joins rather than duplicates", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: ALICE.subject,
        email: "alice@example.test",
        name: "Alice",
      });
    });
    const alice = t.withIdentity(ALICE);
    const args = {
      scopeType: "user" as const,
      scopeId: ALICE.subject,
      name: "design",
    };
    const first = await alice.mutation(anyApi.channels.create, args);
    const second = await alice.mutation(anyApi.channels.create, args);
    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("channels").collect());
    expect(rows).toHaveLength(1);
  });

  it("refuses a workspace the caller is not in, and says so readably", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: ALICE.subject,
        email: "alice@example.test",
        name: "Alice",
      });
      return ctx.db.insert("workspaces", {
        name: "Acme",
        slug: "acme",
        ownerClerkId: "somebody_else",
        createdAt: Date.now(),
      });
    });

    // A ConvexError, so the reason reaches the toast instead of being redacted
    // to "Server Error" — which is the difference between a refusal a person
    // can act on and the report that started this file.
    await expect(
      t.withIdentity(ALICE).mutation(anyApi.channels.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "general",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
