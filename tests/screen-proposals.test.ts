import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";

// Layout proposals: an agent may author a screen, never apply one.
//
// The properties that make this safe to ship:
//
//  1. **Proposing writes no layout.** The naive "adaptive UI" silently
//     rearranges your screen; this one cannot, structurally.
//  2. **Accepting applies to the acceptor only.** Layouts are per-person, so
//     consent is per-person too — one teammate accepting does not rearrange
//     another teammate's screen.
//  3. **Access-checked both ways.** A fenced agent can't propose, an outsider
//     can't read the reasoning or resolve.

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
  const alice = t.withIdentity(ALICE);
  const spaceId = await alice.mutation(api.spaces.create, {
    name: "HQ",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const projectId = await alice.mutation(api.projects.create, {
    spaceId,
    name: "Launch",
  });
  const key = "cua_test_key_proposals";
  const agentId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("agents", {
      name: "Ada",
      parentType: "workspace",
      parentId: workspaceId,
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
      status: "active",
      role: "member",
      dailyActionLimit: 2000,
    });
    await ctx.db.insert("agentKeys", {
      agentId: id,
      keyHash: sha256Hex(key),
      keyPrefix: key.slice(0, 12),
      createdAt: Date.now(),
    });
    return id;
  });
  const screenKey = `project:${projectId}`;
  return { t, workspaceId, spaceId, projectId, screenKey, agentId, key };
}

const LAYOUT = {
  widgets: [
    { id: "progress", span: 1 as const },
    { id: "lists", span: 2 as const },
  ],
};

describe("proposing", () => {
  it("stores a suggestion and touches nobody's layout", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "Eight tasks are blocked; blockers should be first.",
    });

    const seen = await t
      .withIdentity(ALICE)
      .query(api.screens.proposalsFor, { screenKey });
    expect(seen).toHaveLength(1);
    expect(seen[0].agentName).toBe("Ada");
    expect(seen[0].reason).toContain("blocked");

    // The structural property: proposing wrote no screenLayouts row.
    const layouts = await t.run(async (ctx) =>
      ctx.db.query("screenLayouts").collect(),
    );
    expect(layouts).toEqual([]);
  });

  it("refuses a proposal without a reason", async () => {
    const { t, projectId, key } = await seed();
    await expect(
      t.mutation(api.agentApi.proposeScreen, {
        apiKey: key,
        projectId,
        layout: LAYOUT,
        reason: "   ",
      }),
    ).rejects.toThrow(/reason/);
  });

  it("replaces the agent's previous pending suggestion", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "first idea",
    });
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "better idea",
    });
    const seen = await t
      .withIdentity(ALICE)
      .query(api.screens.proposalsFor, { screenKey });
    // One current best suggestion, not a queue of stale ones.
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("better idea");
  });

  it("refuses a layout with a duplicated panel", async () => {
    const { t, projectId, key } = await seed();
    await expect(
      t.mutation(api.agentApi.proposeScreen, {
        apiKey: key,
        projectId,
        layout: {
          widgets: [
            { id: "lists", span: 2 as const },
            { id: "lists", span: 3 as const },
          ],
        },
        reason: "broken on purpose",
      }),
    ).rejects.toThrow(/twice/);
  });
});

describe("resolving", () => {
  it("accepting arranges the screen for the acceptor only", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "why not",
    });
    const [p] = await t
      .withIdentity(ALICE)
      .query(api.screens.proposalsFor, { screenKey });
    await t
      .withIdentity(ALICE)
      .mutation(api.screens.resolveProposal, {
        proposalId: p.proposalId,
        accept: true,
      });

    const forAlice = await t
      .withIdentity(ALICE)
      .query(api.screens.layoutFor, { screenKey });
    // Stamped with the row-unit version on acceptance: an agent authors in
    // current units but doesn't stamp, and an unstamped blob would be
    // rescaled by the client's legacy-unit migration on the next read.
    expect(forAlice?.layout).toEqual({ ...LAYOUT, v: 2 });
    // Consent is per-person: Bob's screen did not move.
    const forBob = await t
      .withIdentity(BOB)
      .query(api.screens.layoutFor, { screenKey });
    expect(forBob).toBeNull();
    // And the suggestion is spent.
    expect(
      await t
        .withIdentity(BOB)
        .query(api.screens.proposalsFor, { screenKey }),
    ).toEqual([]);
  });

  it("dismissing spends the suggestion without touching any layout", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "why not",
    });
    const [p] = await t
      .withIdentity(BOB)
      .query(api.screens.proposalsFor, { screenKey });
    await t
      .withIdentity(BOB)
      .mutation(api.screens.resolveProposal, {
        proposalId: p.proposalId,
        accept: false,
      });
    expect(
      await t.withIdentity(ALICE).query(api.screens.proposalsFor, { screenKey }),
    ).toEqual([]);
    const layouts = await t.run(async (ctx) =>
      ctx.db.query("screenLayouts").collect(),
    );
    expect(layouts).toEqual([]);
  });

  it("a resolved proposal can't be resolved again", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "why not",
    });
    const [p] = await t
      .withIdentity(ALICE)
      .query(api.screens.proposalsFor, { screenKey });
    await t.withIdentity(ALICE).mutation(api.screens.resolveProposal, {
      proposalId: p.proposalId,
      accept: false,
    });
    // Bob accepting a dismissed suggestion would resurrect it as his layout.
    await expect(
      t.withIdentity(BOB).mutation(api.screens.resolveProposal, {
        proposalId: p.proposalId,
        accept: true,
      }),
    ).rejects.toThrow(/already been handled/);
  });
});

describe("access", () => {
  it("keeps an outsider away from the reasoning and the resolution", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposeScreen, {
      apiKey: key,
      projectId,
      layout: LAYOUT,
      reason: "internal reasoning about the roadmap",
    });
    expect(
      await t
        .withIdentity(OUTSIDER)
        .query(api.screens.proposalsFor, { screenKey }),
    ).toEqual([]);
    const [p] = await t
      .withIdentity(ALICE)
      .query(api.screens.proposalsFor, { screenKey });
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.screens.resolveProposal, {
        proposalId: p.proposalId,
        accept: true,
      }),
    ).rejects.toThrow();
  });

  it("refuses an agent fenced out of the project's lists", async () => {
    const { t, workspaceId, spaceId, projectId } = await seed();
    // An agent restricted to a list in ANOTHER space has no business shaping
    // how this project is read.
    const otherSpace = await t.withIdentity(ALICE).mutation(api.spaces.create, {
      name: "Elsewhere",
      parentType: "workspace",
      parentId: workspaceId,
    });
    void spaceId;
    const otherList = await t.withIdentity(ALICE).mutation(api.lists.create, {
      parentType: "space",
      parentId: otherSpace,
      name: "Far away",
    });
    const fencedKey = "cua_test_key_fenced";
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Fenced",
        parentType: "workspace",
        parentId: workspaceId,
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        status: "active",
        role: "member",
        dailyActionLimit: 2000,
        allowedListIds: [otherList as Id<"lists">],
      });
      await ctx.db.insert("agentKeys", {
        agentId: id,
        keyHash: sha256Hex(fencedKey),
        keyPrefix: fencedKey.slice(0, 12),
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentApi.proposeScreen, {
        apiKey: fencedKey,
        projectId,
        layout: LAYOUT,
        reason: "should not land",
      }),
    ).rejects.toThrow();
  });
});
