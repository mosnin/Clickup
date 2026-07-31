import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

// Panel proposals: an agent may author a panel, never place one.
//
// The step past rearranging. A layout proposal reshuffles the panels you have;
// this one adds a question your screen was not asking. Same consent shape, and
// it has to hold for the same reason — an interface that changes itself is an
// interface nobody can learn.
//
// What these pin down:
//
//  1. **Proposing creates no panel and touches no layout.** Structurally, not
//     by convention.
//  2. **Accepting mints the panel for the ACCEPTOR.** Panels are per-person,
//     like layouts, so consent is per-person: one teammate accepting does not
//     put a panel on another teammate's screen.
//  3. **Credit survives.** The panel says who wrote it, which is the whole
//     difference between a tool you chose and one that appeared.
//  4. **Access is checked both ways, and again at accept** — an agent's reach
//     can be narrowed between writing a proposal and someone reading it.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };

const PANEL = {
  title: "Blocked on you",
  query: {
    from: "tasks",
    filter: { assignee: "me", blocked: true },
    dimension: "none",
  },
  shape: "list",
  fields: ["status", "due"],
};

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

  async function mintAgent(name: string, key: string, role: "member" | "readonly") {
    return await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId: workspaceId,
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        status: "active",
        role,
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
  }

  const key = "cua_test_panel_proposal";
  const agentId = await mintAgent("Ada", key, "member");
  const screenKey = `project:${projectId}`;
  return { t, workspaceId, spaceId, projectId, screenKey, agentId, key, mintAgent };
}

describe("proposing", () => {
  it("stores a suggestion and creates no panel", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposePanel, {
      apiKey: key,
      projectId,
      definition: PANEL,
      reason: "Nothing on this screen shows what is blocked on you.",
    });

    const seen = await t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toHaveLength(1);
    expect(seen[0].agentName).toBe("Ada");
    expect(seen[0].reason).toContain("blocked");

    // The structural property: proposing wrote no panel and no layout.
    const [panels, layouts] = await t.run(async (ctx) => [
      await ctx.db.query("uiComponents").collect(),
      await ctx.db.query("screenLayouts").collect(),
    ]);
    expect(panels).toEqual([]);
    expect(layouts).toEqual([]);
  });

  it("refuses a proposal without a reason", async () => {
    // A proposal without a reason is an instruction.
    const { t, projectId, key } = await seed();
    await expect(
      t.mutation(api.agentApi.proposePanel, {
        apiKey: key,
        projectId,
        definition: PANEL,
        reason: "   ",
      }),
    ).rejects.toThrow(/reason/);
  });

  it("refuses a proposal with no definition", async () => {
    const { t, projectId, key } = await seed();
    await expect(
      t.mutation(api.agentApi.proposePanel, {
        apiKey: key,
        projectId,
        definition: "a donut of overdue tasks",
        reason: "worth having",
      }),
    ).rejects.toThrow(/definition/);
  });

  it("replaces this agent's previous pending suggestion", async () => {
    // Every pending proposal is a banner on somebody's screen. "Here are four
    // panels I thought of" is noise; "here is the one you're missing" is not.
    const { t, projectId, screenKey, key } = await seed();
    for (const reason of ["first idea", "better idea"]) {
      await t.mutation(api.agentApi.proposePanel, {
        apiKey: key,
        projectId,
        definition: PANEL,
        reason,
      });
    }
    const seen = await t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("better idea");
  });

  it("leaves another agent's suggestion alone", async () => {
    const { t, projectId, screenKey, key, mintAgent } = await seed();
    const otherKey = "cua_test_panel_other";
    await mintAgent("Grace", otherKey, "member");
    await t.mutation(api.agentApi.proposePanel, {
      apiKey: key,
      projectId,
      definition: PANEL,
      reason: "from Ada",
    });
    await t.mutation(api.agentApi.proposePanel, {
      apiKey: otherKey,
      projectId,
      definition: PANEL,
      reason: "from Grace",
    });
    const seen = await t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toHaveLength(2);
  });

  it("refuses a readonly agent", async () => {
    const { t, projectId, mintAgent } = await seed();
    const roKey = "cua_test_panel_readonly";
    await mintAgent("Watcher", roKey, "readonly");
    await expect(
      t.mutation(api.agentApi.proposePanel, {
        apiKey: roKey,
        projectId,
        definition: PANEL,
        reason: "worth having",
      }),
    ).rejects.toThrow();
  });

  it("refuses a list-restricted agent", async () => {
    // Adding to how a whole project is read is structure-level. An agent
    // fenced to two lists has no business reshaping the screen above them.
    const { t, projectId, workspaceId } = await seed();
    const fencedKey = "cua_test_panel_fenced";
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
        allowedListIds: [],
      });
      await ctx.db.insert("agentKeys", {
        agentId: id,
        keyHash: sha256Hex(fencedKey),
        keyPrefix: fencedKey.slice(0, 12),
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentApi.proposePanel, {
        apiKey: fencedKey,
        projectId,
        definition: PANEL,
        reason: "worth having",
      }),
    ).rejects.toThrow(/restricted/);
  });

  it("refuses an unknown key", async () => {
    const { t, projectId } = await seed();
    await expect(
      t.mutation(api.agentApi.proposePanel, {
        apiKey: "cua_not_a_key",
        projectId,
        definition: PANEL,
        reason: "worth having",
      }),
    ).rejects.toThrow();
  });
});

describe("reading", () => {
  it("shows the suggestion to everyone in the workspace", async () => {
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposePanel, {
      apiKey: key,
      projectId,
      definition: PANEL,
      reason: "worth having",
    });
    const seen = await t
      .withIdentity(BOB)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toHaveLength(1);
  });

  it("shows nothing to an outsider", async () => {
    // A proposal carries an agent's reasoning and a definition describing this
    // workspace's work — all of it internal.
    const { t, projectId, screenKey, key } = await seed();
    await t.mutation(api.agentApi.proposePanel, {
      apiKey: key,
      projectId,
      definition: PANEL,
      reason: "worth having",
    });
    const seen = await t
      .withIdentity(OUTSIDER)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toEqual([]);
  });

  it("shows nothing for a screen key that is not a project", async () => {
    const { t } = await seed();
    const seen = await t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey: "project:nonsense" });
    expect(seen).toEqual([]);
  });
});

describe("accepting", () => {
  async function propose() {
    const state = await seed();
    await state.t.mutation(api.agentApi.proposePanel, {
      apiKey: state.key,
      projectId: state.projectId,
      definition: PANEL,
      reason: "Nothing shows what is blocked on you.",
    });
    const [seen] = await state.t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey: state.screenKey });
    return { ...state, proposalId: seen.proposalId };
  }

  it("mints the panel for whoever accepted, credited to the agent", async () => {
    const { t, proposalId, workspaceId } = await propose();
    const result = await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.resolveProposal, { proposalId, accept: true });
    expect(result.componentId).toBeTruthy();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("uiComponents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerClerkId).toBe(ALICE.subject);
    expect(rows[0].scopeType).toBe("workspace");
    expect(rows[0].scopeId).toBe(workspaceId);
    // Credit is the difference between a tool you chose and one that appeared.
    expect(rows[0].authoredByName).toBe("Ada");
  });

  it("does not put it on anyone else's screen", async () => {
    // Panels are per-person, so consent is too.
    const { t, proposalId, projectId } = await propose();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.resolveProposal, { proposalId, accept: true });

    const bobsPanels = await t
      .withIdentity(BOB)
      .query(api.uiComponents.listForScope, {
        scopeType: "workspace",
        scopeId: (await t.run(async (ctx) => {
          const project = await ctx.db.get(projectId);
          const space = await ctx.db.get(project!.spaceId);
          return space!.parentId;
        })) as string,
      });
    expect(bobsPanels).toEqual([]);

    // And no layout was written for anybody — the client places it, because
    // the server cannot tell "never arranged" from "arranged and empty".
    const layouts = await t.run(async (ctx) =>
      ctx.db.query("screenLayouts").collect(),
    );
    expect(layouts).toEqual([]);
  });

  it("creates nothing when dismissed", async () => {
    const { t, proposalId } = await propose();
    const result = await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.resolveProposal, { proposalId, accept: false });
    expect(result.componentId).toBeNull();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("uiComponents").collect(),
    );
    expect(rows).toEqual([]);
  });

  it("can only be resolved once", async () => {
    const { t, proposalId } = await propose();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.resolveProposal, { proposalId, accept: false });
    await expect(
      t
        .withIdentity(BOB)
        .mutation(api.uiComponents.resolveProposal, { proposalId, accept: true }),
    ).rejects.toThrow(/already/);
  });

  it("stops showing once it is resolved", async () => {
    const { t, proposalId, screenKey } = await propose();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.resolveProposal, { proposalId, accept: true });
    const seen = await t
      .withIdentity(ALICE)
      .query(api.uiComponents.proposalsFor, { screenKey });
    expect(seen).toEqual([]);
  });

  it("refuses an outsider", async () => {
    const { t, proposalId } = await propose();
    await expect(
      t
        .withIdentity(OUTSIDER)
        .mutation(api.uiComponents.resolveProposal, {
          proposalId,
          accept: true,
        }),
    ).rejects.toThrow();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("uiComponents").collect(),
    );
    expect(rows).toEqual([]);
  });

  it("refuses a signed-out caller", async () => {
    const { t, proposalId } = await propose();
    await expect(
      t.mutation(api.uiComponents.resolveProposal, { proposalId, accept: true }),
    ).rejects.toThrow();
  });
});

// ── X1: circulation ─────────────────────────────────────────────────────
//
// A panel is per-person, which is right — a dashboard is a place you stand.
// But it means a good one dies with its author and ten people build ten of
// the same thing. Sharing OFFERS: it reaches everyone's tray and nobody's
// screen, so a panel spreads without ever being a change to someone else's
// dashboard.

describe("sharing a panel", () => {
  async function withPanel() {
    const state = await seed();
    const componentId = await state.t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.create, {
        scopeType: "workspace",
        scopeId: state.workspaceId,
        definition: PANEL,
      });
    return { ...state, componentId };
  }

  it("is invisible to teammates until it is shared", async () => {
    const { t, workspaceId } = await withPanel();
    const bobs = await t.withIdentity(BOB).query(api.uiComponents.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(bobs).toEqual([]);
  });

  it("reaches a teammate's tray once shared", async () => {
    const { t, workspaceId, componentId } = await withPanel();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: true });

    const bobs = await t.withIdentity(BOB).query(api.uiComponents.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(bobs).toHaveLength(1);
    expect(bobs[0].mine).toBe(false);
    expect(bobs[0].shared).toBe(true);
  });

  it("never lands on a teammate's screen", async () => {
    // The whole distinction. Spreading a panel and changing somebody's
    // dashboard have to stay separate acts.
    const { t, componentId } = await withPanel();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: true });
    const layouts = await t.run(async (ctx) =>
      ctx.db.query("screenLayouts").collect(),
    );
    expect(layouts).toEqual([]);
  });

  it("does not copy — the author keeps improving it for everyone", async () => {
    const { t, workspaceId, componentId } = await withPanel();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: true });
    await t.withIdentity(ALICE).mutation(api.uiComponents.update, {
      componentId,
      definition: { ...PANEL, title: "Blocked, now better" },
    });

    const bobs = await t.withIdentity(BOB).query(api.uiComponents.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(
      (bobs[0].definition as { title: string }).title,
    ).toBe("Blocked, now better");
  });

  it("can be withdrawn", async () => {
    const { t, workspaceId, componentId } = await withPanel();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: true });
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: false });
    const bobs = await t.withIdentity(BOB).query(api.uiComponents.listForScope, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(bobs).toEqual([]);
  });

  it("is the owner's call, not a teammate's", async () => {
    const { t, componentId } = await withPanel();
    await expect(
      t
        .withIdentity(BOB)
        .mutation(api.uiComponents.setShared, { componentId, shared: true }),
    ).rejects.toThrow(/not found/i);
  });

  it("still shows an outsider nothing", async () => {
    const { t, workspaceId, componentId } = await withPanel();
    await t
      .withIdentity(ALICE)
      .mutation(api.uiComponents.setShared, { componentId, shared: true });
    const theirs = await t
      .withIdentity(OUTSIDER)
      .query(api.uiComponents.listForScope, {
        scopeType: "workspace",
        scopeId: workspaceId,
      });
    expect(theirs).toEqual([]);
  });
});
