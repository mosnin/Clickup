import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret, verifyEvent } from "../convex/buzz/_nostr";
import { publishCore } from "../convex/buzz/log";
import {
  RELAY_SEED_ENV,
  asRelay,
  communityNonce,
  parseRelayPrincipalId,
  relayActor,
  relayPrincipalId,
  relayPubkeyFor,
} from "../convex/buzz/relay";
import {
  CHANNEL_TEMPLATES,
  canonicalChannelName,
  channelNamesMatch,
  channelSlug,
  formatTtlDuration,
  parseTtlDuration,
  renderChannelCanvas,
} from "../convex/buzz/channels";

// `anyApi` rather than the generated `api`, for the reason buzz-log.test.ts
// states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it. The references
// resolve identically at runtime — convex-test finds them through the glob.
const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const log = anyApi.buzz.log;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
/** In the workspace, but never opens Chat — so never has a signing key. */
const DANA = { subject: "user_dana" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

// Fixed keys, like buzz-log.test.ts: several assertions are about *which*
// pubkey signed something, and a random key makes those pass or fail by the day.
const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  // A real deployment sets this with `npx convex env set`. Fixed here so the
  // derived relay pubkey is the same on every run and can be asserted against.
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, CAROL, DANA, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      const secretKey = KEYS[person.subject];
      // Dana deliberately has no key: a principal who has never opened Chat is
      // a case the add path has to answer, not one the fixture can wish away.
      if (!secretKey) continue;
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: publicKeyFromSecret(secretKey),
        secretKey,
        createdAt: Date.now(),
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
      [CAROL.subject, "member"],
      [DANA.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }

    const agentId = await ctx.db.insert("agents", {
      name: "Scout",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const agentSecret = "05".repeat(32);
    await ctx.db.insert("buzzKeys", {
      principalType: "agent",
      principalId: agentId,
      pubkey: publicKeyFromSecret(agentSecret),
      secretKey: agentSecret,
      createdAt: Date.now(),
    });

    return { workspaceId, agentId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  return { t, scope, ...ids };
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function events(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: Ctx) => await ctx.db.query("buzzEvents").collect());
}

async function createChannel(
  t: ReturnType<typeof convexTest>,
  scope: Scope,
  args: Record<string, unknown>,
): Promise<string> {
  const result = (await t
    .withIdentity(ALICE)
    .mutation(channels.create, { ...scope, ...args })) as { channelId: string };
  return result.channelId;
}

// ---------------------------------------------------------------------------
// The relay principal
// ---------------------------------------------------------------------------

describe("the relay principal", () => {
  it("belongs to a community, not to the deployment", () => {
    const workspace: Scope = { scopeType: "workspace", scopeId: "ws_1" };
    const other: Scope = { scopeType: "workspace", scopeId: "ws_2" };
    const personal: Scope = { scopeType: "user", scopeId: "user_alice" };

    // Deterministic — the same community always signs with the same key, which
    // is what makes it recognisable at all.
    expect(relayPubkeyFor(workspace)).toBe(relayPubkeyFor(workspace));
    // And distinct per community: one compromised relay is one community's
    // problem, and an exported event says whose relay signed it.
    expect(relayPubkeyFor(workspace)).not.toBe(relayPubkeyFor(other));
    expect(relayPubkeyFor(workspace)).not.toBe(relayPubkeyFor(personal));
    expect(relayPubkeyFor(workspace)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the seed, and refuses to exist without one", () => {
    const scope: Scope = { scopeType: "workspace", scopeId: "ws_1" };
    const withFirstSeed = relayPubkeyFor(scope);

    process.env[RELAY_SEED_ENV] = "a-completely-different-seed-value-0123456789";
    expect(relayPubkeyFor(scope)).not.toBe(withFirstSeed);

    // Fail closed. A fallback constant would hand every install the same relay
    // identity, which is exactly the forgeable, unattributable signer the
    // per-community design exists to avoid.
    delete process.env[RELAY_SEED_ENV];
    expect(() => relayPubkeyFor(scope)).toThrow(/BUZZ_RELAY_SEED/);
    // A placeholder is refused too, on length.
    process.env[RELAY_SEED_ENV] = "dev";
    expect(() => relayPubkeyFor(scope)).toThrow(/BUZZ_RELAY_SEED/);

    process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
    expect(relayPubkeyFor(scope)).toBe(withFirstSeed);
  });

  it("round-trips its principal id, and claims nothing else", () => {
    const scope: Scope = { scopeType: "workspace", scopeId: "ws_1" };
    expect(parseRelayPrincipalId(relayPrincipalId(scope))).toEqual(scope);
    expect(relayActor(scope).type).toBe("system");
    // A cron, a scheduler, an agent id: none of these are a relay, and the
    // refusal in identity.ts depends on that being answered "no".
    expect(parseRelayPrincipalId("user_alice")).toBeNull();
    expect(parseRelayPrincipalId("relay:")).toBeNull();
    expect(parseRelayPrincipalId("relay:group:x")).toBeNull();
    expect(parseRelayPrincipalId("relay:workspace:")).toBeNull();
  });

  it("may sign only the kinds a member is not allowed to write", () => {
    const scope: Scope = { scopeType: "workspace", scopeId: "ws_1" };
    // 40099 is relay-signed. A plain message is not — and the relay posting a
    // message would be the most authoritative-looking thing in the product.
    expect(asRelay(scope, { kind: 40099, tags: [["h", "c"]], content: "{}" }).actor.type).toBe(
      "system",
    );
    expect(() => asRelay(scope, { kind: 9, tags: [["h", "c"]], content: "hi" })).toThrow(
      /only sign relay-signed kinds/,
    );
    expect(() => asRelay(scope, { kind: 1, tags: [], content: "hi" })).toThrow(
      /only sign relay-signed kinds/,
    );
  });

  it("still refuses to sign for a system actor that is not a relay", async () => {
    // identity.ts's refusal is extended, not weakened: the deployment has no
    // identity, and a cron writing as "the server" is exactly what that rule
    // was written about.
    const { t, scope } = await seed();
    await expect(
      t.run(async (ctx: Ctx) =>
        publishCore(ctx, {
          actor: { type: "system", id: "cron", name: "cron" },
          scope,
          kind: 1,
          tags: [],
          content: "from nobody",
        }),
      ),
    ).rejects.toThrow(/no system identity/);
  });

  it("cannot be forged by a member", async () => {
    const { t, scope } = await seed();
    // Through the public surface, with a real session: the vocabulary lock.
    // A member's actor is `user`, and a relay-signed kind is refused before it
    // is signed, hashed, or stored.
    await expect(
      t.withIdentity(ALICE).mutation(log.publish, {
        ...scope,
        kind: 40099,
        tags: [["h", "some-channel"]],
        content: JSON.stringify({ type: "member_removed", actor: "x", target: "y" }),
      }),
    ).rejects.toThrow(/relay-signed only/);

    // And the notification kinds too — "you were removed from #ops" is only
    // worth anything if the person doing the removing could not have written it.
    await expect(
      t.withIdentity(ALICE).mutation(log.publish, {
        ...scope,
        kind: 44101,
        tags: [["p", pubkeyOf(BOB)]],
        content: "{}",
      }),
    ).rejects.toThrow(/relay-signed only/);

    expect(await events(t)).toHaveLength(0);
  });

  it("signs the system rows a room's own writes produce", async () => {
    const { t, scope } = await seed();
    await createChannel(t, scope, { name: "ops" });

    const rows = await events(t);
    const system = rows.filter((row) => row.kind === 40099);
    expect(system).toHaveLength(1);
    // Signed by *this community's* relay, and a real BIP-340 signature over the
    // real NIP-01 id — not a marker column claiming it is.
    expect(system[0].pubkey).toBe(relayPubkeyFor(scope));
    expect(system[0].pubkey).not.toBe(pubkeyOf(ALICE));
    expect(
      verifyEvent({
        id: system[0].eventId,
        pubkey: system[0].pubkey,
        created_at: system[0].createdAt,
        kind: system[0].kind,
        tags: system[0].tags,
        content: system[0].content,
        sig: system[0].sig,
      }),
    ).toBe(true);
    // The signer is the room; the actor is the person. That is why attribution
    // lives in the payload rather than in the signature.
    expect(JSON.parse(system[0].content)).toMatchObject({
      type: "channel_created",
      actor: pubkeyOf(ALICE),
    });
  });

  it("gives the creation event uniqueness without giving it the name", async () => {
    const { t, scope } = await seed();
    await createChannel(t, scope, { name: "acquisition", visibility: "private" });

    const rows = await events(t);
    const creation = rows.find((row) => row.kind === 9007);
    expect(creation).toBeDefined();
    // The room's id is this event's id, so it cannot carry an `h` tag and is
    // therefore readable community-wide. Nothing in it may say what the room is.
    const flat = JSON.stringify(creation?.tags);
    expect(flat).not.toContain("acquisition");
    expect(flat).not.toContain("private");
    expect(creation?.tags).toContainEqual(["nonce", communityNonce(scope, "acquisition")]);
    // The name lives in the channel-scoped 9002 instead, where only the room
    // can be read.
    const metadata = rows.find((row) => row.kind === 9002);
    expect(metadata?.channelId).toBe(creation?.eventId);
    expect(metadata?.tags).toContainEqual(["name", "acquisition"]);
  });
});

// ---------------------------------------------------------------------------
// Names, TTLs, templates — the pure rules
// ---------------------------------------------------------------------------

describe("channel names", () => {
  it("strips the display-only sigil and trailing space", () => {
    expect(canonicalChannelName("#design")).toBe("design");
    expect(canonicalChannelName("#  Release Notes  ")).toBe("Release Notes");
    expect(canonicalChannelName("   #  ops")).toBe("ops");
    // Leading whitespace inside the name is not preserved by Buzz's rule
    // either — only the *end* is trimmed.
    expect(canonicalChannelName("ops   ")).toBe("ops");
  });

  it("resolves to one slug whatever a person typed", () => {
    expect(channelSlug("#  Release Notes ")).toBe("release-notes");
    expect(channelSlug("Release/Notes")).toBe("release-notes");
    expect(channelSlug("release_notes")).toBe("release-notes");
    expect(channelSlug("---ops---")).toBe("ops");
    expect(channelSlug("###")).toBe("");
    expect(channelNamesMatch("Release Notes", "#release-notes")).toBe(true);
    expect(channelNamesMatch("ops", "operations")).toBe(false);
  });

  it("refuses a second room whose name resolves the same way", async () => {
    const { t, scope } = await seed();
    await createChannel(t, scope, { name: "Release Notes" });
    await expect(createChannel(t, scope, { name: "#release-notes" })).rejects.toThrow(
      /already exists/,
    );
    // A name that canonicalises to nothing is not a name.
    await expect(createChannel(t, scope, { name: "###" })).rejects.toThrow(/needs a name/);
  });

  it("keeps what a person typed beside what the system resolves", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "#  Release Notes " });
    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      name: string;
      displayName: string;
    };
    expect(room.name).toBe("release-notes");
    expect(room.displayName).toBe("Release Notes");
  });
});

describe("ephemeral TTLs", () => {
  it("requires a unit, refuses repeats, and refuses leftovers", () => {
    expect(parseTtlDuration("7d")).toBe(7 * 86400);
    expect(parseTtlDuration("1d12h")).toBe(86400 + 12 * 3600);
    expect(parseTtlDuration(" 1D  12H ")).toBe(86400 + 12 * 3600);
    // A bare number could mean seconds or minutes, and guessing is how somebody
    // gets a room that vanishes in half a minute.
    expect(parseTtlDuration("30")).toBeNull();
    expect(parseTtlDuration("1h1h")).toBeNull();
    expect(parseTtlDuration("1d12x")).toBeNull();
    expect(parseTtlDuration("0d")).toBeNull();
    expect(parseTtlDuration("")).toBeNull();
  });

  it("formats back to something the same parser accepts", () => {
    for (const text of ["30m", "12h", "7d", "1d12h", "1d1h1m1s"]) {
      const seconds = parseTtlDuration(text);
      expect(seconds).not.toBeNull();
      expect(formatTtlDuration(seconds as number)).toBe(text);
    }
    expect(formatTtlDuration(0)).toBe("");
    expect(formatTtlDuration(-5)).toBe("");
  });
});

describe("channel templates", () => {
  it("substitutes the two variables a canvas may use", () => {
    const template = CHANNEL_TEMPLATES.find((entry) => entry.id === "incident");
    expect(template).toBeDefined();
    const canvas = renderChannelCanvas(template!, "payments-outage");
    expect(canvas).toContain("# payments-outage");
    expect(canvas).not.toContain("{channel.name}");
  });

  it("furnishes a room, and the canvas lands in the room's own log", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "Outage", templateId: "incident" });

    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      visibility: string;
      description: string;
      templateId: string | null;
    };
    // The template supplies defaults — including a private room for an incident.
    expect(room.visibility).toBe("private");
    expect(room.description).toContain("incident");
    expect(room.templateId).toBe("incident");

    const canvas = (await events(t)).find((row) => row.kind === 40100);
    expect(canvas?.channelId).toBe(channelId);
    expect(canvas?.content).toContain("# Outage");
  });

  it("lets an explicit choice beat the template's default", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, {
      name: "Outage",
      templateId: "incident",
      visibility: "open",
    });
    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      visibility: string;
    };
    expect(room.visibility).toBe("public");
  });

  it("refuses a template it does not have", async () => {
    const { t, scope } = await seed();
    await expect(createChannel(t, scope, { name: "x", templateId: "nope" })).rejects.toThrow(
      /Unknown channel template/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tenancy and visibility
// ---------------------------------------------------------------------------

describe("the tenancy fence", () => {
  it("refuses every read and every write from outside the community", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    const outsider = t.withIdentity(OUTSIDER);

    await expect(outsider.query(channels.list, scope)).rejects.toThrow(/Forbidden/);
    await expect(outsider.query(channels.get, { ...scope, channelId })).rejects.toThrow(
      /Forbidden/,
    );
    await expect(outsider.query(channels.members, { ...scope, channelId })).rejects.toThrow(
      /Forbidden/,
    );
    await expect(outsider.mutation(channels.join, { ...scope, channelId })).rejects.toThrow(
      /Forbidden/,
    );
    await expect(
      outsider.mutation(channels.create, { ...scope, name: "theirs" }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      outsider.mutation(channels.setTopic, { ...scope, channelId, topic: "mine now" }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      outsider.mutation(channels.update, { ...scope, channelId, name: "theirs" }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      outsider.mutation(channels.setArchived, { ...scope, channelId, archived: true }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("keeps one person's personal community out of another's reach", async () => {
    const { t } = await seed();
    const personal: Scope = { scopeType: "user", scopeId: ALICE.subject };
    const channelId = await createChannel(t, personal, { name: "notes" });

    // Bob is a colleague in the same workspace. A personal space is still not
    // his, and it is the same rule `requireScopeAccess` already enforced for
    // pages and docs — not a second answer invented here.
    await expect(t.withIdentity(BOB).query(channels.list, personal)).rejects.toThrow(/Forbidden/);
    await expect(
      t.withIdentity(BOB).query(channels.get, { ...personal, channelId }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("shows a private room only to its members, and says nothing to anyone else", async () => {
    const { t, scope } = await seed();
    const secret = await createChannel(t, scope, { name: "acquisition", visibility: "private" });
    const open = await createChannel(t, scope, { name: "ops" });

    const bobsRail = (await t.withIdentity(BOB).query(channels.list, scope)) as { name: string }[];
    expect(bobsRail.map((row) => row.name)).toEqual(["ops"]);

    // "Not found" rather than "forbidden": whether a room called #acquisition
    // exists is itself what a private room is keeping.
    await expect(t.withIdentity(BOB).query(channels.get, { ...scope, channelId: secret })).rejects.toThrow(
      /not found/i,
    );
    await expect(
      t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId: secret }),
    ).rejects.toThrow(/not found/i);
    // The open one is joinable by any member of the community.
    await expect(
      t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId: open }),
    ).resolves.toMatchObject({ joined: true });
  });

  it("hides an archived room from everyone who was not in it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(ALICE).mutation(channels.setArchived, { ...scope, channelId, archived: true });

    const bobsRail = (await t.withIdentity(BOB).query(channels.list, scope)) as {
      archivedAt?: number;
    }[];
    expect(bobsRail).toHaveLength(1);
    expect(bobsRail[0].archivedAt).toBeGreaterThan(0);

    // Carol is in the community and was never in the room.
    expect(await t.withIdentity(CAROL).query(channels.list, scope)).toEqual([]);
    await expect(
      t.withIdentity(CAROL).query(channels.get, { ...scope, channelId }),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// DMs
// ---------------------------------------------------------------------------

describe("direct messages are immutable", () => {
  it("opens once and reopens the same conversation", async () => {
    const { t, scope } = await seed();
    const first = (await t
      .withIdentity(ALICE)
      .mutation(channels.openDm, { ...scope, actorIds: [BOB.subject] })) as {
      channelId: string;
      created: boolean;
    };
    expect(first.created).toBe(true);

    // Idempotent by participant set — and from either side, because the set is
    // sorted rather than ordered by who asked.
    const again = (await t
      .withIdentity(BOB)
      .mutation(channels.openDm, { ...scope, actorIds: [ALICE.subject] })) as {
      channelId: string;
      created: boolean;
    };
    expect(again.channelId).toBe(first.channelId);
    expect(again.created).toBe(false);
  });

  it("cannot be renamed, re-topic'd, or added to — server-side", async () => {
    const { t, scope } = await seed();
    const { channelId } = (await t
      .withIdentity(ALICE)
      .mutation(channels.openDm, { ...scope, actorIds: [BOB.subject] })) as { channelId: string };

    for (const attempt of [
      t.withIdentity(ALICE).mutation(channels.update, { ...scope, channelId, name: "us two" }),
      t.withIdentity(ALICE).mutation(channels.setTopic, { ...scope, channelId, topic: "hi" }),
      t.withIdentity(ALICE).mutation(channels.setPurpose, { ...scope, channelId, purpose: "hi" }),
      t.withIdentity(ALICE).mutation(channels.setArchived, { ...scope, channelId, archived: true }),
      t.withIdentity(ALICE).mutation(channels.join, { ...scope, channelId }),
      t.withIdentity(ALICE).mutation(channels.addMembers, {
        ...scope,
        channelId,
        members: [{ actorId: CAROL.subject, actorType: "user" }],
      }),
      t.withIdentity(ALICE).mutation(channels.removeMember, {
        ...scope,
        channelId,
        actorId: BOB.subject,
      }),
      t.withIdentity(ALICE).mutation(channels.setRole, {
        ...scope,
        channelId,
        actorId: BOB.subject,
        role: "admin",
      }),
    ]) {
      await expect(attempt).rejects.toThrow(/direct message cannot/i);
    }

    const members = (await t
      .withIdentity(ALICE)
      .query(channels.members, { ...scope, channelId })) as unknown[];
    expect(members).toHaveLength(2);
  });

  it("is hidden rather than left, and hiding it is per-viewer", async () => {
    const { t, scope } = await seed();
    const { channelId } = (await t
      .withIdentity(ALICE)
      .mutation(channels.openDm, { ...scope, actorIds: [BOB.subject] })) as { channelId: string };

    await expect(
      t.withIdentity(ALICE).mutation(channels.leave, { ...scope, channelId }),
    ).resolves.toMatchObject({ left: false, hidden: true });

    expect(await t.withIdentity(ALICE).query(channels.list, scope)).toEqual([]);
    // Bob sees no change at all: closing a conversation is not ending one.
    expect((await t.withIdentity(BOB).query(channels.list, scope)) as unknown[]).toHaveLength(1);

    // Re-opening brings it back rather than making a second one.
    const reopened = (await t
      .withIdentity(ALICE)
      .mutation(channels.openDm, { ...scope, actorIds: [BOB.subject] })) as {
      channelId: string;
      created: boolean;
    };
    expect(reopened).toEqual({ channelId, created: false });
    expect((await t.withIdentity(ALICE).query(channels.list, scope)) as unknown[]).toHaveLength(1);
  });

  it("is a group DM once there are more than two people in it", async () => {
    const { t, scope } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(channels.openDm, { ...scope, actorIds: [BOB.subject, CAROL.subject] });
    const rail = (await t.withIdentity(ALICE).query(channels.list, scope)) as {
      kind: string;
      name: string;
    }[];
    expect(rail).toHaveLength(1);
    expect(rail[0].kind).toBe("group_dm");
    // No name: a DM is titled by who is in it, so a stored name would go wrong
    // the moment somebody is renamed.
    expect(rail[0].name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("joining and leaving", () => {
  it("records a join in the log and in the projection, once", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    // A second click means what the first one did.
    await expect(
      t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId }),
    ).resolves.toMatchObject({ joined: false });

    const room = (await t.withIdentity(BOB).query(channels.get, { ...scope, channelId })) as {
      memberCount: number;
      joined: boolean;
    };
    expect(room.memberCount).toBe(2);
    expect(room.joined).toBe(true);

    const rows = await events(t);
    expect(rows.filter((row) => row.kind === 9021)).toHaveLength(1);
    // The relay's two echoes: the row in the room, and the notification
    // addressed to the person it is about.
    const notification = rows.find((row) => row.kind === 44100);
    expect(notification?.pubkey).toBe(relayPubkeyFor(scope));
    expect(notification?.tags).toContainEqual(["p", pubkeyOf(BOB)]);
    // Community-global on purpose: an agent subscribes to "rooms I am put into"
    // without already knowing the room ids, which it cannot.
    expect(notification?.channelId).toBeUndefined();
    expect(
      rows.filter(
        (row) => row.kind === 40099 && JSON.parse(row.content).type === "member_joined",
      ),
    ).toHaveLength(1);
  });

  it("soft-removes on leave, and reverses it on a re-join", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(BOB).mutation(channels.leave, { ...scope, channelId });

    const memberships = await t.run(
      async (ctx: Ctx) => await ctx.db.query("buzzMemberships").collect(),
    );
    const bobs = memberships.filter((row) => row.actorId === BOB.subject);
    // One row, marked removed — not a deleted row and not a second one. "Was in
    // this room until March" stays answerable, and a re-join is one history.
    expect(bobs).toHaveLength(1);
    expect(bobs[0].removedAt).toBeGreaterThan(0);

    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      memberCount: number;
    };
    expect(room.memberCount).toBe(1);
    expect((await events(t)).filter((row) => row.kind === 9022)).toHaveLength(1);
    expect((await events(t)).filter((row) => row.kind === 44101)).toHaveLength(1);
  });

  it("refuses to let the last owner orphan a room somebody is still in", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(ALICE).mutation(channels.leave, { ...scope, channelId }),
    ).rejects.toThrow(/owner/i);

    // Alone in the room, there is nobody to orphan.
    await t.withIdentity(BOB).mutation(channels.leave, { ...scope, channelId });
    await expect(
      t.withIdentity(ALICE).mutation(channels.leave, { ...scope, channelId }),
    ).resolves.toMatchObject({ left: true });
  });
});

describe("adding and removing people", () => {
  it("adds a person and an agent through the same path", async () => {
    const { t, scope, agentId } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops", visibility: "private" });

    const result = (await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [
        { actorId: BOB.subject, actorType: "user" },
        { actorId: agentId, actorType: "agent" },
      ],
    })) as { added: string[]; errors: unknown[] };
    expect(result.added).toHaveLength(2);
    expect(result.errors).toEqual([]);

    const members = (await t
      .withIdentity(ALICE)
      .query(channels.members, { ...scope, channelId })) as {
      name: string;
      actorType: string;
      role: string;
      isSelf: boolean;
    }[];
    // Yourself first, then by role, then by name (§1.6). An agent is a member
    // in the same list, which is the whole reason it needed no second concept.
    expect(members.map((m) => m.name)).toEqual(["user_alice", "Scout", "user_bob"]);
    expect(members[0].isSelf).toBe(true);
    expect(members.find((m) => m.name === "Scout")?.actorType).toBe("agent");
  });

  it("adds who it can and says who it could not", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });

    const result = (await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [
        { actorId: BOB.subject, actorType: "user" },
        // Dana has never opened Chat, so she has no key — and a membership is
        // recorded in the log as a `p` tag, which has nowhere to point.
        { actorId: DANA.subject, actorType: "user" },
      ],
    })) as { added: string[]; errors: { actorId: string; error: string }[] };

    expect(result.added).toEqual([BOB.subject]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].actorId).toBe(DANA.subject);
    expect(result.errors[0].error).toMatch(/has not opened Chat/);
  });

  it("keeps a private room's membership to the people who govern it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops", visibility: "private" });
    await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: BOB.subject, actorType: "user" }],
    });

    // Bob is in the room but is not an owner or admin. A private room whose
    // membership any member could extend is not private.
    await expect(
      t.withIdentity(BOB).mutation(channels.addMembers, {
        ...scope,
        channelId,
        members: [{ actorId: CAROL.subject, actorType: "user" }],
      }),
    ).rejects.toThrow(/owners and admins/);

    // An open room is the other half of the same rule: anyone in it may add.
    const open = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId: open });
    await expect(
      t.withIdentity(BOB).mutation(channels.addMembers, {
        ...scope,
        channelId: open,
        members: [{ actorId: CAROL.subject, actorType: "user" }],
      }),
    ).resolves.toMatchObject({ added: [CAROL.subject] });
  });

  it("lets you remove yourself, and lets only a governor remove anybody else", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(BOB).mutation(channels.removeMember, {
        ...scope,
        channelId,
        actorId: CAROL.subject,
      }),
    ).rejects.toThrow(/owners and admins/);

    await expect(
      t.withIdentity(BOB).mutation(channels.removeMember, {
        ...scope,
        channelId,
        actorId: BOB.subject,
      }),
    ).resolves.toMatchObject({ removed: true });

    await expect(
      t.withIdentity(ALICE).mutation(channels.removeMember, {
        ...scope,
        channelId,
        actorId: CAROL.subject,
      }),
    ).resolves.toMatchObject({ removed: true });

    const rows = await events(t);
    expect(rows.filter((row) => row.kind === 9001)).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 44101)).toHaveLength(2);
  });
});

describe("roles are governance", () => {
  it("is refused for an ordinary member and allowed for an owner", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(BOB).mutation(channels.setRole, {
        ...scope,
        channelId,
        actorId: CAROL.subject,
        role: "admin",
      }),
    ).rejects.toThrow(/owners and admins/);

    await t.withIdentity(ALICE).mutation(channels.setRole, {
      ...scope,
      channelId,
      actorId: BOB.subject,
      role: "admin",
    });

    const members = (await t
      .withIdentity(ALICE)
      .query(channels.members, { ...scope, channelId })) as { name: string; role: string }[];
    expect(members.find((m) => m.name === "user_bob")?.role).toBe("admin");

    // The change is in the log as a put-user carrying the new role: "add" and
    // "change role" are one event rather than two that can disagree.
    const rows = await events(t);
    const roleEvent = rows.filter(
      (row) => row.kind === 9000 && row.tags.some((tag: string[]) => tag[0] === "role" && tag[1] === "admin"),
    );
    expect(roleEvent).toHaveLength(1);
    expect(roleEvent[0].tags).toContainEqual(["p", pubkeyOf(BOB)]);
    expect(
      rows.filter((row) => row.kind === 40099 && JSON.parse(row.content).type === "role_changed"),
    ).toHaveLength(1);
  });

  it("will not demote the last owner into an orphaned room", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await expect(
      t.withIdentity(ALICE).mutation(channels.setRole, {
        ...scope,
        channelId,
        actorId: ALICE.subject,
        role: "member",
      }),
    ).rejects.toThrow(/owner/i);
  });

  it("lets only an owner make another owner", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(ALICE).mutation(channels.setRole, {
      ...scope,
      channelId,
      actorId: BOB.subject,
      role: "admin",
    });

    // Bob is an admin of the room and an ordinary member of the workspace.
    // Ownership is the role that can remove the person granting it.
    await expect(
      t.withIdentity(BOB).mutation(channels.setRole, {
        ...scope,
        channelId,
        actorId: CAROL.subject,
        role: "owner",
      }),
    ).rejects.toThrow(/only an owner/i);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("editing a room", () => {
  it("renames it, refuses a name already taken, and records one event", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await createChannel(t, scope, { name: "general" });

    await expect(
      t.withIdentity(ALICE).mutation(channels.update, { ...scope, channelId, name: "General" }),
    ).rejects.toThrow(/already exists/);

    await t.withIdentity(ALICE).mutation(channels.update, {
      ...scope,
      channelId,
      name: "Operations",
      description: "How we run things",
      ttlSeconds: 7 * 86400,
    });

    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      name: string;
      displayName: string;
      description: string;
      ttlSeconds?: number;
    };
    expect(room.name).toBe("operations");
    expect(room.displayName).toBe("Operations");
    expect(room.ttlSeconds).toBe(7 * 86400);

    // One 9002 for one Save — four events for one act would put four rows in
    // the room's timeline.
    const rows = await events(t);
    const edits = rows.filter(
      (row) => row.kind === 9002 && row.tags.some((tag: string[]) => tag[0] === "name" && tag[1] === "Operations"),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].tags).toContainEqual(["about", "How we run things"]);
    expect(edits[0].tags).toContainEqual(["ttl", String(7 * 86400)]);
  });

  it("clears a TTL with an empty value rather than an absent tag", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops", ttlSeconds: 3600 });
    await t
      .withIdentity(ALICE)
      .mutation(channels.update, { ...scope, channelId, ttlSeconds: null });

    const room = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      ttlSeconds?: number;
    };
    expect(room.ttlSeconds).toBeUndefined();
    // Absent would have meant "unchanged"; the two must not look alike.
    const cleared = (await events(t)).find((row) =>
      row.tags.some((tag: string[]) => tag[0] === "ttl" && tag[1] === ""),
    );
    expect(cleared).toBeDefined();
  });

  it("lets any member set the topic but only a governor rename it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(BOB).mutation(channels.setTopic, { ...scope, channelId, topic: "shipping" }),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      t.withIdentity(BOB).mutation(channels.update, { ...scope, channelId, name: "theirs" }),
    ).rejects.toThrow(/owners and admins/);

    const room = (await t.withIdentity(BOB).query(channels.get, { ...scope, channelId })) as {
      topic: string | null;
      purpose: string | null;
    };
    expect(room.topic).toBe("shipping");
    // Topic and purpose are distinct fields, so a room between things can say
    // so without erasing what it is for.
    await t
      .withIdentity(BOB)
      .mutation(channels.setPurpose, { ...scope, channelId, purpose: "keep the lights on" });
    const after = (await t.withIdentity(BOB).query(channels.get, { ...scope, channelId })) as {
      topic: string | null;
      purpose: string | null;
    };
    expect(after).toMatchObject({ topic: "shipping", purpose: "keep the lights on" });

    // Setting the same topic again writes nothing at all.
    await expect(
      t.withIdentity(BOB).mutation(channels.setTopic, { ...scope, channelId, topic: "shipping" }),
    ).resolves.toMatchObject({ changed: false });
  });

  it("archives and unarchives, and only a governor may", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });

    await expect(
      t.withIdentity(BOB).mutation(channels.setArchived, { ...scope, channelId, archived: true }),
    ).rejects.toThrow(/owners and admins/);

    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });
    const archived = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      archivedAt?: number;
    };
    expect(archived.archivedAt).toBeGreaterThan(0);

    // Joining a room nobody is using produces a membership that means nothing.
    await expect(
      t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId }),
    ).rejects.toThrow(/not found|archived/i);

    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: false });
    const restored = (await t.withIdentity(ALICE).query(channels.get, { ...scope, channelId })) as {
      archivedAt?: number;
    };
    expect(restored.archivedAt).toBeUndefined();

    const kinds = (await events(t))
      .filter((row) => row.kind === 40099)
      .map((row) => JSON.parse(row.content).type);
    expect(kinds).toContain("archived");
    expect(kinds).toContain("unarchived");
  });
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("a channel row is a projection of the log", () => {
  it("leaves a signed, verifiable event behind every write", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "ops" });
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(BOB).mutation(channels.setTopic, { ...scope, channelId, topic: "shipping" });
    await t.withIdentity(ALICE).mutation(channels.update, { ...scope, channelId, name: "Operations" });
    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });
    await t.withIdentity(BOB).mutation(channels.leave, { ...scope, channelId });

    const rows = await events(t);
    // Every act has its event: create, initial metadata, owner, join, topic,
    // rename, archive, leave.
    const kinds = new Set(rows.map((row) => row.kind));
    for (const kind of [9007, 9002, 9000, 9021, 9022, 40099, 44100, 44101]) {
      expect(kinds.has(kind), `kind ${kind}`).toBe(true);
    }

    // And every one of them is a real signature over a real NIP-01 id. An
    // unsigned row in this table would make the log's whole guarantee "signed,
    // except the ones that aren't".
    for (const row of rows) {
      expect(
        verifyEvent({
          id: row.eventId,
          pubkey: row.pubkey,
          created_at: row.createdAt,
          kind: row.kind,
          tags: row.tags,
          content: row.content,
          sig: row.sig,
        }),
        `event ${row.eventId} (kind ${row.kind})`,
      ).toBe(true);
    }

    // Channel-scoped events are bound to the room; the community-wide ones are
    // exactly the two that have to be findable without knowing a room id.
    for (const row of rows) {
      if ([40099, 9000, 9002, 9021, 9022].includes(row.kind)) {
        expect(row.channelId, `kind ${row.kind}`).toBe(channelId);
      }
      if ([44100, 44101, 9007].includes(row.kind)) {
        expect(row.channelId, `kind ${row.kind}`).toBeUndefined();
      }
    }
  });

  it("returns the rail contract, with read state left honestly at zero", async () => {
    const { t, scope } = await seed();
    await createChannel(t, scope, { name: "zeta" });
    await createChannel(t, scope, { name: "alpha" });
    await t.withIdentity(ALICE).mutation(channels.openDm, { ...scope, actorIds: [BOB.subject] });

    const rail = (await t.withIdentity(ALICE).query(channels.list, scope)) as {
      name: string;
      kind: string;
      visibility: string;
      unread: number;
      mentions: number;
      muted: boolean;
      joined: boolean;
      memberCount: number;
      lastActivityAt?: number;
    }[];

    // Buzz's `sortChannels`: streams, then forums, then DMs; then by name.
    expect(rail.map((row) => row.kind)).toEqual(["channel", "channel", "dm"]);
    expect(rail.map((row) => row.name)).toEqual(["alpha", "zeta", ""]);
    expect(rail[0]).toMatchObject({
      visibility: "public",
      joined: true,
      memberCount: 1,
      // C5 owns read state. Zero is the honest answer until then: the
      // alternatives were a number nobody computed, or a scan of every
      // channel's history on every rail read.
      unread: 0,
      mentions: 0,
      muted: false,
    });
    expect(rail[0].lastActivityAt).toBeGreaterThan(0);
  });
});
