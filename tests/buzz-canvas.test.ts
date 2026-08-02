import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { sha256Hex } from "../convex/_agentAuth";
import { publicKeyFromSecret, verifyEvent } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { CANVAS_HISTORY_MAX } from "../convex/buzz/canvas";

// C7b — the channel canvas.
//
// What these tests are about, in the order a bug here would cost:
//
//   **Round-trip.** A canvas is one markdown document, and the Pages editor's
//   rule applies unchanged: a block that cannot round-trip is a block that
//   deletes data. The log stores content bytes and hashes them into the event
//   id, so the assertion is strict equality on the whole document — every
//   construct the editor can produce goes in and has to come back identical.
//
//   **Last-write-wins, but not silent.** We keep Buzz's clobbering (§3.4)
//   because the log is append-only and no version is destroyed. What the write
//   path owes in exchange is a truthful account of what it landed on: which
//   version it replaced, and whether the writer had seen it.
//
//   **Newest is unambiguous.** `created_at` is seconds and two saves in one
//   second are ordinary; on a tie the log compares event ids, which is a hash.
//   Without the monotonic bump the canvas would show whichever version happened
//   to hash lower — a coin flip, once per busy second.
//
//   **Tenancy and governance.** An agent may write a canvas it can reach and
//   not one it cannot, and neither may anybody else.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const canvas = anyApi.buzz.canvas;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
/** In the workspace, joins nothing — the "can read, cannot write" case. */
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const USER_KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

const SCOUT_SECRET = "05".repeat(32);
const READER_SECRET = "06".repeat(32);
const STRANGER_SECRET = "07".repeat(32);

const SCOUT_KEY = "cua_test_scout";
const READER_KEY = "cua_test_reader";
const STRANGER_KEY = "cua_test_stranger";

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Head = {
  content: string | null;
  eventId: string | null;
  updatedAt: number | null;
  author: { pubkey: string; name: string; isAgent: boolean } | null;
  canEdit: boolean;
};
type Write = {
  status: "written" | "unchanged";
  eventId: string;
  replaced: { eventId: string; updatedAt: number; author: { name: string } | null } | null;
  unseen: boolean;
};

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, CAROL, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: publicKeyFromSecret(USER_KEYS[person.subject]),
        secretKey: USER_KEYS[person.subject],
        createdAt: Date.now(),
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    // A second community. Its only job is to be somewhere an Acme agent must
    // not be able to reach.
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Umbrella",
      slug: "umbrella",
      ownerClerkId: OUTSIDER.subject,
      createdAt: Date.now(),
    });
    for (const [subject, workspace, role] of [
      [ALICE.subject, workspaceId, "owner"],
      [BOB.subject, workspaceId, "member"],
      [CAROL.subject, workspaceId, "member"],
      [OUTSIDER.subject, otherWorkspaceId, "owner"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId: workspace,
        role,
        joinedAt: Date.now(),
      });
    }

    async function agent(
      name: string,
      parentId: string,
      apiKey: string,
      secretKey: string,
      extra: Record<string, unknown> = {},
    ) {
      const agentId = await ctx.db.insert("agents", {
        name,
        parentType: "workspace",
        parentId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        ...extra,
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 12),
        createdAt: Date.now(),
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "agent",
        principalId: agentId,
        pubkey: publicKeyFromSecret(secretKey),
        secretKey,
        createdAt: Date.now(),
      });
      return agentId;
    }

    const scoutId = await agent("Scout", workspaceId, SCOUT_KEY, SCOUT_SECRET);
    const readerId = await agent("Reader", workspaceId, READER_KEY, READER_SECRET, {
      role: "readonly",
    });
    const strangerId = await agent(
      "Stranger",
      otherWorkspaceId,
      STRANGER_KEY,
      STRANGER_SECRET,
    );

    return { workspaceId, otherWorkspaceId, scoutId, readerId, strangerId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  return { t, scope, ...ids };
}

type T = ReturnType<typeof convexTest>;

async function createChannel(
  t: T,
  scope: Scope,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = (await t
    .withIdentity(ALICE)
    .mutation(channels.create, { ...scope, name: "ops", ...args })) as {
    channelId: string;
  };
  return result.channelId;
}

async function canvasEvents(t: T, channelId: string) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("buzzEvents").collect();
    return rows.filter((r) => r.kind === 40100 && r.channelId === channelId);
  });
}

// ---------------------------------------------------------------------------
// The document survives the round trip
// ---------------------------------------------------------------------------

describe("markdown round-trip", () => {
  it("hands back exactly the bytes it was given", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);

    // Every construct the Pages editor can produce, in one document. The
    // editor's own tests prove Tiptap serializes each of these back to itself;
    // this proves the transport does not touch them on the way through — the
    // half that would silently delete a table or an image and leave the editor
    // looking innocent.
    const document = [
      "# Incident 2029-04-02",
      "",
      "## Impact",
      "",
      "Checkout was **down** for `11 minutes`.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "> [!NOTE]",
      "> A callout, which is a GitHub alert blockquote.",
      "",
      "| region | errors |",
      "| --- | --- |",
      "| eu | 41 |",
      "",
      "- [ ] page the on-call",
      "- [x] write it up",
      "",
      "@[Ada Lovelace](user_alice) owns the follow-up, see [[Billing migration]].",
      "",
      "![diagram](https://example.test/d.png)",
      "",
      "<details><summary>Timeline</summary>",
      "",
      "09:04 first alert",
      "",
      "</details>",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
    ].join("\n");

    await t.withIdentity(ALICE).mutation(canvas.write, {
      ...scope,
      channelId,
      content: document,
    });

    const head = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toBe(document);

    // And the stored event is the same bytes, signed — the id is a hash over
    // the content, so a transport that "helpfully" normalized whitespace would
    // produce an event whose signature no longer verifies.
    const stored = await canvasEvents(t, channelId);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe(document);
    expect(
      verifyEvent({
        id: stored[0].eventId,
        pubkey: stored[0].pubkey,
        created_at: stored[0].createdAt,
        kind: stored[0].kind,
        tags: stored[0].tags,
        content: stored[0].content,
        sig: stored[0].sig,
      }),
    ).toBe(true);
  });

  it("keeps an empty canvas distinguishable from no canvas", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);

    // §3.2: the object is never null and every field is explicitly null, so a
    // caller can tell "nobody has written one" from "somebody wrote an empty
    // one" — an absent key would deserialize as `undefined`, which is a third
    // state nothing has a branch for.
    const empty = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(empty.content).toBeNull();
    expect(empty.eventId).toBeNull();
    expect(empty.updatedAt).toBeNull();
    expect(empty.author).toBeNull();

    await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "" });
    const blank = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(blank.content).toBe("");
    expect(blank.eventId).not.toBeNull();
    expect(blank.author?.name).toBe(ALICE.subject);
  });

  it("carries a template's canvas through channel creation", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, {
      name: "sev1",
      templateId: "incident",
    });
    const head = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toContain("# sev1");
    expect(head.content).toContain("## Timeline");
  });
});

// ---------------------------------------------------------------------------
// Last write wins — visibly
// ---------------------------------------------------------------------------

describe("last-write-wins", () => {
  it("shows the newest version, and orders two saves in the same second", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);

    // Three writes with no wait between them, so they share a wall-clock
    // second. Without the monotonic bump these tie on `created_at` and the log
    // breaks the tie by comparing event ids — a hash, so the answer would be
    // whichever of the three happened to hash lowest.
    for (const body of ["one", "two", "three"]) {
      await t
        .withIdentity(ALICE)
        .mutation(canvas.write, { ...scope, channelId, content: body });
    }

    const head = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toBe("three");

    const stored = await canvasEvents(t, channelId);
    expect(stored).toHaveLength(3);
    const times = stored.map((r) => r.createdAt).sort((a, b) => a - b);
    expect(new Set(times).size).toBe(3);
  });

  it("names the version it replaced, and says whether the writer had seen it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: BOB.subject, actorType: "user" }],
    });

    const first = (await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "alice" })) as Write;
    // Nothing was there, so nothing was replaced and nothing was unseen.
    expect(first.replaced).toBeNull();
    expect(first.unseen).toBe(false);

    // Bob edits from the version he read. A clean save.
    const informed = (await t.withIdentity(BOB).mutation(canvas.write, {
      ...scope,
      channelId,
      content: "bob",
      basedOn: first.eventId,
    })) as Write;
    expect(informed.unseen).toBe(false);
    expect(informed.replaced?.eventId).toBe(first.eventId);
    expect(informed.replaced?.author?.name).toBe(ALICE.subject);

    // Alice still holds the version she wrote, and saves over Bob's. The write
    // lands — that is last-write-wins — and it says so, which is the whole of
    // "a lost edit must be visible rather than silent".
    const clobbering = (await t.withIdentity(ALICE).mutation(canvas.write, {
      ...scope,
      channelId,
      content: "alice again",
      basedOn: first.eventId,
    })) as Write;
    expect(clobbering.status).toBe("written");
    expect(clobbering.unseen).toBe(true);
    expect(clobbering.replaced?.eventId).toBe(informed.eventId);
    expect(clobbering.replaced?.author?.name).toBe(BOB.subject);

    // And Bob's version is not gone — it is an event, and it is restorable.
    const versions = (await t
      .withIdentity(BOB)
      .query(canvas.history, { ...scope, channelId })) as {
      eventId: string;
      preview: string;
    }[];
    expect(versions.map((v) => v.preview)).toEqual(["alice again", "bob", "alice"]);

    const recovered = (await t.withIdentity(BOB).query(canvas.readVersion, {
      ...scope,
      channelId,
      eventId: informed.eventId,
    })) as { content: string } | null;
    expect(recovered?.content).toBe("bob");

    // Restoring is an ordinary write of the old content — no second verb, and
    // therefore itself undoable by restoring again.
    await t.withIdentity(BOB).mutation(canvas.write, {
      ...scope,
      channelId,
      content: recovered!.content,
      basedOn: clobbering.eventId,
    });
    const head = (await t.withIdentity(BOB).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toBe("bob");
    expect((await canvasEvents(t, channelId))).toHaveLength(4);
  });

  it("does not log a version for a save that changed nothing", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "same" });
    const again = (await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "same" })) as Write;

    expect(again.status).toBe("unchanged");
    // One event, not two: a history full of versions that say nothing buries
    // the edits that matter, and the log is the only history a canvas has.
    expect(await canvasEvents(t, channelId)).toHaveLength(1);
  });

  it("caps history rather than handing back the whole document N times", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    for (let i = 0; i < 5; i += 1) {
      await t
        .withIdentity(ALICE)
        .mutation(canvas.write, { ...scope, channelId, content: `v${i}` });
    }
    const asked = (await t
      .withIdentity(ALICE)
      .query(canvas.history, { ...scope, channelId, limit: 2 })) as unknown[];
    expect(asked).toHaveLength(2);

    // A caller asking for more than the ceiling gets the ceiling, not an error
    // and not the whole log.
    const capped = (await t.withIdentity(ALICE).query(canvas.history, {
      ...scope,
      channelId,
      limit: CANVAS_HISTORY_MAX + 500,
    })) as unknown[];
    expect(capped.length).toBeLessThanOrEqual(CANVAS_HISTORY_MAX);
  });
});

// ---------------------------------------------------------------------------
// Who may touch it
// ---------------------------------------------------------------------------

describe("access", () => {
  it("fences the community", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);

    await expect(
      t.withIdentity(OUTSIDER).query(canvas.read, { ...scope, channelId }),
    ).rejects.toThrow();
    await expect(
      t
        .withIdentity(OUTSIDER)
        .mutation(canvas.write, { ...scope, channelId, content: "mine now" }),
    ).rejects.toThrow();
  });

  it("lets the community read an open room and only members write it", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "charter" });

    // Carol is in the workspace but not in the room. An open room is readable
    // by the community — the same sentence the room header shows.
    const head = (await t.withIdentity(CAROL).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toBe("charter");
    expect(head.canEdit).toBe(false);

    await expect(
      t
        .withIdentity(CAROL)
        .mutation(canvas.write, { ...scope, channelId, content: "hijack" }),
    ).rejects.toThrow(/members of this room/);
  });

  it("does not admit a private room exists", async () => {
    const { t, scope } = await seed();
    const secret = await createChannel(t, scope, {
      name: "acquisition",
      visibility: "private",
    });
    // "Not found", not "forbidden": whether `#acquisition` exists is itself the
    // thing the room is keeping.
    await expect(
      t.withIdentity(CAROL).query(canvas.read, { ...scope, channelId: secret }),
    ).rejects.toThrow(/not found/i);
  });

  it("makes an archived room's canvas read-only", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    await t
      .withIdentity(ALICE)
      .mutation(canvas.write, { ...scope, channelId, content: "final" });
    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });

    const head = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.content).toBe("final");
    expect(head.canEdit).toBe(false);
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(canvas.write, { ...scope, channelId, content: "reopened" }),
    ).rejects.toThrow(/archived/);
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe("agents", () => {
  it("writes a canvas it can reach, signed with its own key", async () => {
    const { t, scope, scoutId } = await seed();
    const channelId = await createChannel(t, scope);
    await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: scoutId, actorType: "agent" }],
    });

    const written = (await t.mutation(canvas.agentWrite, {
      apiKey: SCOUT_KEY,
      channelId,
      content: "# Runbook\n\nRestart the worker.\n",
    })) as Write;
    expect(written.status).toBe("written");

    const stored = await canvasEvents(t, channelId);
    expect(stored).toHaveLength(1);
    // Identity, not a flag: the event is signed by the agent's own key, so who
    // wrote the canvas is answerable from the log forever.
    expect(stored[0].pubkey).toBe(publicKeyFromSecret(SCOUT_SECRET));

    const seen = (await t.query(canvas.agentRead, {
      apiKey: SCOUT_KEY,
      channelId,
    })) as Head;
    expect(seen.content).toBe("# Runbook\n\nRestart the worker.\n");
    expect(seen.author?.isAgent).toBe(true);

    // And a person sees the agent's canvas as the agent's.
    const head = (await t.withIdentity(ALICE).query(canvas.read, {
      ...scope,
      channelId,
    })) as Head;
    expect(head.author?.name).toBe("Scout");
    expect(head.author?.isAgent).toBe(true);
  });

  it("cannot reach a room it is not in, or a community it is not in", async () => {
    const { t, scope, otherWorkspaceId } = await seed();
    const open = await createChannel(t, scope);
    const secret = await createChannel(t, scope, {
      name: "board",
      visibility: "private",
    });

    // An open room in its own community is readable; writing needs membership,
    // which is the same bar a person faces.
    const head = (await t.query(canvas.agentRead, {
      apiKey: SCOUT_KEY,
      channelId: open,
    })) as Head;
    expect(head.canEdit).toBe(false);
    await expect(
      t.mutation(canvas.agentWrite, {
        apiKey: SCOUT_KEY,
        channelId: open,
        content: "x",
      }),
    ).rejects.toThrow(/members of this room/);

    // A private room it was never added to is not refused, it is absent.
    await expect(
      t.query(canvas.agentRead, { apiKey: SCOUT_KEY, channelId: secret }),
    ).rejects.toThrow(/not found/i);

    // An agent in another workspace cannot reach an Acme room by id. There is
    // no scope argument to get wrong — the community comes from the key.
    await expect(
      t.query(canvas.agentRead, { apiKey: STRANGER_KEY, channelId: open }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t.mutation(canvas.agentWrite, {
        apiKey: STRANGER_KEY,
        channelId: open,
        content: "hello from umbrella",
      }),
    ).rejects.toThrow(/not found/i);
    expect(otherWorkspaceId).toBeTruthy();
  });

  it("refuses a readonly agent before it costs it anything", async () => {
    const { t, scope, readerId } = await seed();
    const channelId = await createChannel(t, scope);
    await t.withIdentity(ALICE).mutation(channels.addMembers, {
      ...scope,
      channelId,
      members: [{ actorId: readerId, actorType: "agent" }],
    });

    // Reads are fine — a readonly agent can call every read tool.
    const head = (await t.query(canvas.agentRead, {
      apiKey: READER_KEY,
      channelId,
    })) as Head;
    expect(head.content).toBeNull();

    await expect(
      t.mutation(canvas.agentWrite, {
        apiKey: READER_KEY,
        channelId,
        content: "no",
      }),
    ).rejects.toThrow();
    expect(await canvasEvents(t, channelId)).toHaveLength(0);
  });

  it("refuses an invalid key without saying anything about the room", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope);
    await expect(
      t.query(canvas.agentRead, { apiKey: "cua_not_a_key", channelId }),
    ).rejects.toThrow(/Invalid API key/);
  });
});
