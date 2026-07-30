import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { DEFAULT_APPEARANCE, resolveLayered } from "../src/lib/appearance";

// Space themes and per-space personal overrides.
//
// Three writers decide what the app looks like, and each one is bounded:
//
//  1. A space's look is SHARED — a governor sets it and everyone in the space
//     sees it. A plain member cannot.
//  2. A person's override of a space is THEIRS — nobody else's view moves.
//  3. Neither of them may touch how someone reads. A personal key stored in a
//     space theme, by any route, must not reach the resolved appearance. That
//     is asserted here end-to-end and not only in the pure resolver, because
//     the whole point is that no write path can smuggle one through.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, BOB, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [who, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: who,
        workspaceId: id,
        role,
        joinedAt: Date.now(),
      });
    }
    return id;
  });

  // Alice creates the space, so she governs it and Bob does not.
  const spaceId = await t
    .withIdentity(ALICE)
    .mutation(api.spaces.create, {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
    });

  return { t, workspaceId, spaceId };
}

describe("a space's own look", () => {
  it("is set by a governor and seen by every member", async () => {
    const { t, spaceId } = await seed();
    await t.withIdentity(ALICE).mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: { accentMode: "hue", accentHue: 200, radiusScale: 1.6 },
    });

    const asBob = await t
      .withIdentity(BOB)
      .query(api.appearance.spaceContext, { kind: "space", id: spaceId });
    expect(asBob!.theme).toEqual({
      accentMode: "hue",
      accentHue: 200,
      radiusScale: 1.6,
    });

    // And it actually changes what Bob's app renders with.
    const { appearance, sources } = resolveLayered({ space: asBob!.theme });
    expect(appearance.accentHue).toBe(200);
    expect(sources.accentHue).toBe("space");
  });

  it("refuses a member who doesn't govern the space", async () => {
    const { t, spaceId } = await seed();
    await expect(
      t.withIdentity(BOB).mutation(api.appearance.setSpaceTheme, {
        spaceId,
        theme: { radiusScale: 0 },
      }),
    ).rejects.toThrow(/space creator or workspace owner/);

    // The refusal is a refusal — nothing was written.
    const ctx = await t
      .withIdentity(ALICE)
      .query(api.appearance.spaceContext, { kind: "space", id: spaceId });
    expect(ctx!.theme).toBeNull();
  });

  it("tells each viewer whether they may change it", async () => {
    const { t, spaceId } = await seed();
    const forAlice = await t
      .withIdentity(ALICE)
      .query(api.appearance.spaceContext, { kind: "space", id: spaceId });
    const forBob = await t
      .withIdentity(BOB)
      .query(api.appearance.spaceContext, { kind: "space", id: spaceId });
    // The control has to be absent for Bob, not present and then refused.
    expect(forAlice!.mayTheme).toBe(true);
    expect(forBob!.mayTheme).toBe(false);
  });

  it("cannot change how anyone reads, whatever it stores", async () => {
    const { t, spaceId } = await seed();
    // The hostile theme: shrink the type, force motion back on, move the nav.
    await t.withIdentity(ALICE).mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: {
        fontScale: 0.85,
        motionScale: 1.5,
        sidebarPosition: "right",
        density: "compact",
        surface: "raised",
      },
    });
    const ctx = await t
      .withIdentity(BOB)
      .query(api.appearance.spaceContext, { kind: "space", id: spaceId });

    const { appearance } = resolveLayered({
      personal: { fontScale: 1.2, motionScale: 0 },
      space: ctx!.theme,
    });
    expect(appearance.fontScale).toBe(1.2);
    expect(appearance.motionScale).toBe(0);
    expect(appearance.sidebarPosition).toBe(DEFAULT_APPEARANCE.sidebarPosition);
    expect(appearance.density).toBe(DEFAULT_APPEARANCE.density);
    // The place key it was entitled to set still lands.
    expect(appearance.surface).toBe("raised");
  });

  it("clears when set to nothing", async () => {
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: { radiusScale: 0 },
    });
    const cleared = await alice.mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: {},
    });
    expect(cleared.cleared).toBe(true);
    const ctx = await alice.query(api.appearance.spaceContext, {
      kind: "space",
      id: spaceId,
    });
    expect(ctx!.theme).toBeNull();
  });
});

describe("a person's own divergence", () => {
  it("moves their view of the space and nobody else's", async () => {
    const { t, spaceId } = await seed();
    await t.withIdentity(ALICE).mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: { surface: "raised" },
    });
    await t.withIdentity(BOB).mutation(api.appearance.save, {
      spaceId,
      patch: { surface: "flat" },
    });

    const bobPrefs = await t
      .withIdentity(BOB)
      .query(api.appearance.forCurrentUser, {});
    const alicePrefs = await t
      .withIdentity(ALICE)
      .query(api.appearance.forCurrentUser, {});

    expect(bobPrefs!.spaceOverrides[spaceId]).toEqual({ surface: "flat" });
    expect(alicePrefs!.spaceOverrides).toEqual({});

    // Bob's own override beats the space; Alice still sees the space's look.
    expect(
      resolveLayered({
        space: { surface: "raised" },
        personalSpace: bobPrefs!.spaceOverrides[spaceId],
      }).appearance.surface,
    ).toBe("flat");
    expect(
      resolveLayered({ space: { surface: "raised" } }).appearance.surface,
    ).toBe("raised");
  });

  it("needs only read access to the space, not governance", async () => {
    // Bob can't re-theme the space for everyone, but "make it look like this
    // for me" is a preference and has to work for any member.
    const { t, spaceId } = await seed();
    await expect(
      t
        .withIdentity(BOB)
        .mutation(api.appearance.save, { spaceId, patch: { radiusScale: 0 } }),
    ).resolves.not.toThrow();
  });

  it("refuses someone who can't see the space at all", async () => {
    const { t, spaceId } = await seed();
    await expect(
      t
        .withIdentity(OUTSIDER)
        .mutation(api.appearance.save, { spaceId, patch: { radiusScale: 0 } }),
    ).rejects.toThrow();
  });

  it("stops being an override when emptied", async () => {
    const { t, spaceId } = await seed();
    const bob = t.withIdentity(BOB);
    await bob.mutation(api.appearance.save, {
      spaceId,
      patch: { surface: "flat" },
    });
    await bob.mutation(api.appearance.save, { spaceId, patch: {} });
    const prefs = await bob.query(api.appearance.forCurrentUser, {});
    // Not "an override that happens to be empty" — no override at all, so
    // "have you customised this space?" answers no.
    expect(spaceId in prefs!.spaceOverrides).toBe(false);
  });
});

describe("resetting", () => {
  it("puts one space back to inherited and leaves the rest alone", async () => {
    const { t, workspaceId, spaceId } = await seed();
    const other = await t.withIdentity(ALICE).mutation(api.spaces.create, {
      name: "Marketing",
      parentType: "workspace",
      parentId: workspaceId,
    });
    const bob = t.withIdentity(BOB);
    await bob.mutation(api.appearance.save, { patch: { fontScale: 1.1 } });
    await bob.mutation(api.appearance.save, {
      spaceId,
      patch: { surface: "flat" },
    });
    await bob.mutation(api.appearance.save, {
      spaceId: other,
      patch: { radiusScale: 0 },
    });

    await bob.mutation(api.appearance.reset, { spaceId });

    const prefs = await bob.query(api.appearance.forCurrentUser, {});
    expect(spaceId in prefs!.spaceOverrides).toBe(false);
    expect(prefs!.spaceOverrides[other]).toEqual({ radiusScale: 0 });
    expect(prefs!.personal).toEqual({ fontScale: 1.1 });
  });

  it("keeps the spaces someone has tuned when they reset their preferences", async () => {
    // "Reset my preferences" is not "forget every space I have tuned".
    const { t, spaceId } = await seed();
    const bob = t.withIdentity(BOB);
    await bob.mutation(api.appearance.save, { patch: { fontScale: 1.1 } });
    await bob.mutation(api.appearance.save, {
      spaceId,
      patch: { surface: "flat" },
    });

    await bob.mutation(api.appearance.reset, {});

    const prefs = await bob.query(api.appearance.forCurrentUser, {});
    expect(prefs!.personal).toEqual({});
    expect(prefs!.spaceOverrides[spaceId]).toEqual({ surface: "flat" });
  });
});

describe("which room am I in", () => {
  it("resolves the space from a list and from a task, not only from the space", async () => {
    // Walking into a space's list should look like being in that space, so the
    // question has to be answerable from anywhere in the hierarchy.
    const { t, spaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.appearance.setSpaceTheme, {
      spaceId,
      theme: { accentMode: "hue", accentHue: 90 },
    });
    const listId = await alice.mutation(api.lists.create, {
      parentType: "space",
      parentId: spaceId,
      name: "Backlog",
    });
    const taskId = await alice.mutation(api.tasks.create, {
      listId,
      title: "Something",
    });

    for (const [kind, id] of [
      ["list", listId],
      ["task", taskId],
    ] as const) {
      const ctx = await alice.query(api.appearance.spaceContext, { kind, id });
      expect(ctx?.spaceId).toBe(spaceId);
      expect(ctx?.theme).toEqual({ accentMode: "hue", accentHue: 90 });
    }
  });

  it("says nothing at all about a space you can't see", async () => {
    // The name is the leak worth caring about here: an unthemed render is a
    // fine outcome, a space title appearing in someone else's chrome is not.
    const { t, spaceId } = await seed();
    expect(
      await t
        .withIdentity(OUTSIDER)
        .query(api.appearance.spaceContext, { kind: "space", id: spaceId }),
    ).toBeNull();
  });

  it("returns null for an id that isn't one, rather than throwing", async () => {
    const { t } = await seed();
    const alice = t.withIdentity(ALICE);
    expect(
      await alice.query(api.appearance.spaceContext, {
        kind: "space",
        id: "not-an-id",
      }),
    ).toBeNull();
    expect(
      await alice.query(api.appearance.spaceContext, {
        kind: "list",
        id: "also-not-an-id",
      }),
    ).toBeNull();
  });

  it("themes a personal space for its owner", async () => {
    const { t } = await seed();
    const alice = t.withIdentity(ALICE);
    const personal = await alice.mutation(api.spaces.create, {
      name: "Mine",
      parentType: "user",
      parentId: ALICE.subject,
    });
    await alice.mutation(api.appearance.setSpaceTheme, {
      spaceId: personal as Id<"spaces">,
      theme: { radiusScale: 1.6 },
    });
    const ctx = await alice.query(api.appearance.spaceContext, {
      kind: "space",
      id: personal,
    });
    expect(ctx!.mayTheme).toBe(true);
    expect(ctx!.theme).toEqual({ radiusScale: 1.6 });
  });
});
