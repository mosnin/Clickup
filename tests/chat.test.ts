import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import {
  bodyPreview,
  bodyToText,
  extractRefs,
  formatRef,
} from "../convex/_refs";

// Chat is where humans and agents argue about the work, so the rules worth
// pinning are the ones that make a transcript trustworthy:
//
//  1. References are parsed from the body, never trusted from the caller —
//     otherwise a message's stored refs can disagree with its own text.
//  2. Unread is per-participant and never counts your own messages.
//  3. Agents are participants, not observers: they read, they post, and their
//     read cursor works the same way a person's does.
//  4. Access is the scope's access. A channel is not a new boundary.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };
const AGENT_KEY = "cua_chat_test_key_000000000000";

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const u of [ALICE, BOB, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject,
      });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [u, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: u,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const projectId = await ctx.db.insert("projects", {
      name: "Billing migration",
      spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Backlog",
      parentType: "project",
      parentId: projectId,
      position: 0,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(AGENT_KEY),
      keyPrefix: AGENT_KEY.slice(0, 12),
      createdAt: Date.now(),
    });
    return { workspaceId, spaceId, projectId, listId, agentId };
  });
  return { t, ...ids };
}

describe("reference tokens", () => {
  it("parses kind and id out of the token", () => {
    const body = `Blocked on #[Billing migration](project:p1) and #[Backlog](list:l1)`;
    expect(extractRefs(body)).toEqual([
      { kind: "project", id: "p1", label: "Billing migration" },
      { kind: "list", id: "l1", label: "Backlog" },
    ]);
  });

  it("ignores a made-up kind rather than storing it", () => {
    // The kind is a closed set; an unknown one is prose, not a reference.
    expect(extractRefs("#[Thing](banana:x1)")).toEqual([]);
  });

  it("deduplicates the same target mentioned twice", () => {
    const body = "#[A](project:p1) then #[A again](project:p1)";
    expect(extractRefs(body)).toHaveLength(1);
  });

  it("strips brackets from a label so it can't break out of the token", () => {
    const token = formatRef("project", "p1", "Billing [v2] (old)");
    expect(token).toBe("#[Billing v2 old](project:p1)");
    expect(extractRefs(token)).toEqual([
      { kind: "project", id: "p1", label: "Billing v2 old" },
    ]);
  });

  it("reads as prose once the tokens collapse", () => {
    const body =
      "@[Ada](u1) can you look at #[Billing](project:p1)? See [[Runbook]].";
    expect(bodyToText(body)).toBe(
      "@Ada can you look at Billing? See Runbook.",
    );
    expect(bodyPreview("x".repeat(200))).toHaveLength(121);
  });
});

describe("messages carry their references", () => {
  it("stores refs parsed from the body, not from the caller", async () => {
    const { t, workspaceId, projectId } = await seed();
    const alice = t.withIdentity(ALICE);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await alice.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: `Starting on #[Billing migration](project:${projectId})`,
    });

    const thread = await alice.query(api.chat.thread, { channelId });
    expect(thread!.messages[0].refs).toEqual([
      { kind: "project", id: projectId, label: "Billing migration" },
    ]);
  });

  it("resolves a reference to a working link", async () => {
    const { t, workspaceId, projectId, listId } = await seed();
    const alice = t.withIdentity(ALICE);
    const resolved = await alice.query(api.chat.resolveRefs, {
      refs: [
        { kind: "project", id: projectId, label: "Billing migration" },
        { kind: "list", id: listId, label: "Backlog" },
      ],
    });
    expect(resolved.map((r) => r.href)).toEqual([
      `/dashboard/p/${projectId}`,
      `/dashboard/l/${listId}`,
    ]);
    void workspaceId;
  });

  it("returns a null href for a reference that no longer resolves", async () => {
    const { t, projectId } = await seed();
    const alice = t.withIdentity(ALICE);
    await t.run(async (ctx) => await ctx.db.delete(projectId));
    const resolved = await alice.query(api.chat.resolveRefs, {
      refs: [{ kind: "project", id: projectId, label: "Gone" }],
    });
    // A dead chip, not a link to a 404.
    expect(resolved[0].href).toBeNull();
  });
});

describe("the channel rail", () => {
  it("counts what someone else said and not what you said", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const bob = t.withIdentity(BOB);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });

    await alice.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: "mine",
    });
    // Posting marks the author read, so their own message never lights up
    // their own badge.
    expect(
      (await alice.query(api.chat.channels, {
        scopeType: "workspace",
        scopeId: workspaceId,
      }))[0].unread,
    ).toBe(0);

    await bob.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: "theirs",
    });
    await bob.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: "and more",
    });

    const forAlice = await alice.query(api.chat.channels, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(forAlice[0].unread).toBe(2);
    // Bob wrote the last two, so he has nothing unread.
    const forBob = await bob.query(api.chat.channels, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(forBob[0].unread).toBe(0);
  });

  it("clears once you have read it", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const bob = t.withIdentity(BOB);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await bob.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: "hello",
    });
    await alice.mutation(api.chat.markRead, { channelId });
    const rail = await alice.query(api.chat.channels, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(rail[0].unread).toBe(0);
  });

  it("shows the last message without reading every message", async () => {
    const { t, workspaceId, projectId } = await seed();
    const alice = t.withIdentity(ALICE);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await alice.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: `look at #[Billing migration](project:${projectId})`,
    });
    const rail = await alice.query(api.chat.channels, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    // The preview is prose: the token collapsed to its label.
    expect(rail[0].lastMessagePreview).toBe("look at Billing migration");
    expect(rail[0].lastMessageByName).toBe(ALICE.subject);
  });

  it("gives a non-member nothing", async () => {
    const { t, workspaceId } = await seed();
    await t.withIdentity(ALICE).mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    const rail = await t
      .withIdentity(OUTSIDER)
      .query(api.chat.channels, {
        scopeType: "workspace",
        scopeId: workspaceId,
      });
    expect(rail).toEqual([]);
  });

  it("refuses to hand a non-member the transcript", async () => {
    const { t, workspaceId } = await seed();
    const channelId = await t
      .withIdentity(ALICE)
      .mutation(api.channels.create, {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "planning",
      });
    expect(
      await t.withIdentity(OUTSIDER).query(api.chat.thread, { channelId }),
    ).toBeNull();
  });
});

describe("agents in the room", () => {
  it("sees unread, reads the transcript with refs, and clears its cursor", async () => {
    const { t, workspaceId, projectId } = await seed();
    const alice = t.withIdentity(ALICE);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await alice.mutation(api.messages.create, {
      parentType: "channel",
      parentId: channelId,
      body: `Scout, take #[Billing migration](project:${projectId})`,
    });

    let channels = await t.query(api.agentApi.listChannels, {
      apiKey: AGENT_KEY,
    });
    expect(channels[0].unread).toBe(1);

    const transcript = await t.query(api.agentApi.readChannel, {
      apiKey: AGENT_KEY,
      channelId,
    });
    // Structured, so the agent doesn't have to re-parse the sentence.
    expect(transcript.messages[0].refs).toEqual([
      { kind: "project", id: projectId, label: "Billing migration" },
    ]);
    expect(transcript.messages[0].authorIsAgent).toBe(false);

    await t.mutation(api.agentApi.markChannelRead, {
      apiKey: AGENT_KEY,
      channelId,
    });
    channels = await t.query(api.agentApi.listChannels, { apiKey: AGENT_KEY });
    expect(channels[0].unread).toBe(0);
  });

  it("posts as itself and reads back as an agent", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await t.mutation(api.agentApi.addComment, {
      apiKey: AGENT_KEY,
      parentType: "channel",
      parentId: channelId,
      body: "On it.",
    });
    const thread = await alice.query(api.chat.thread, { channelId });
    expect(thread!.messages[0]).toMatchObject({
      body: "On it.",
      authorName: "Scout",
      authorIsAgent: true,
    });
    // And the human now has one unread, because an agent talking is news.
    const rail = await alice.query(api.chat.channels, {
      scopeType: "workspace",
      scopeId: workspaceId,
    });
    expect(rail[0].unread).toBe(1);
  });

  it("refuses a channel outside its scope", async () => {
    const { t } = await seed();
    const other = await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: OUTSIDER.subject,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("channels", {
        scopeType: "workspace",
        scopeId: workspaceId,
        name: "secret",
        createdByActorId: OUTSIDER.subject,
        createdAt: Date.now(),
      });
    });
    await expect(
      t.query(api.agentApi.readChannel, {
        apiKey: AGENT_KEY,
        channelId: other,
      }),
    ).rejects.toThrow(/not found in your scope/);
  });

  it("offers the same reference targets a person's # menu offers", async () => {
    const { t, projectId, listId } = await seed();
    const forAgent = await t.query(api.agentApi.referenceTargets, {
      apiKey: AGENT_KEY,
    });
    expect(forAgent).toEqual(
      expect.arrayContaining([
        { kind: "project", id: projectId, label: "Billing migration", context: "HQ" },
        { kind: "list", id: listId, label: "Backlog", context: "Billing migration" },
      ]),
    );
  });
});

describe("topics", () => {
  it("can be set and cleared by either kind of participant", async () => {
    const { t, workspaceId } = await seed();
    const alice = t.withIdentity(ALICE);
    const channelId = await alice.mutation(api.channels.create, {
      scopeType: "workspace",
      scopeId: workspaceId,
      name: "planning",
    });
    await alice.mutation(api.chat.setTopic, {
      channelId,
      topic: "Where the migration gets decided",
    });
    expect(
      (await alice.query(api.chat.thread, { channelId }))!.channel.topic,
    ).toBe("Where the migration gets decided");

    await t.mutation(api.agentApi.setChannelTopic, {
      apiKey: AGENT_KEY,
      channelId,
      topic: "",
    });
    expect(
      (await alice.query(api.chat.thread, { channelId }))!.channel.topic,
    ).toBeUndefined();
  });
});
