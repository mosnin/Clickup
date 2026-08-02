import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { REF_KINDS, extractRefs, formatRef } from "../convex/_refs";
import {
  BADGE_CAP,
  badgeForOtherSide,
  badgeLabel,
  bindingSentence,
  describeTask,
  isChatNotification,
  modeForPath,
  parseBridgeBody,
  parseRoomKey,
  partitionCounts,
  roomHref,
  roomKey,
  taskIdsIn,
  taskRefToken,
  workHref,
  type TaskCard,
} from "../src/lib/buzz/bridge";

// C12 — the bridge.
//
// The claim under test: **the two dashboards pass data in real time and neither
// one holds a copy of the other's.** Everything below attacks that claim from
// the direction it would actually break.
//
//   - **The leak.** A reference is a label somebody typed into prose, so the
//     label is readable by everyone in the room. What must never leak is the
//     object's *current* state to a reader who cannot open it. Both sides have
//     their own authz and each is used for the objects it owns; a bridge-level
//     check would be a third answer, and the third answer is the one nobody
//     updates.
//   - **The fence, in both directions.** A person in two workspaces passes both
//     sides' checks individually, and joining an Acme room to a Beta project is
//     still a cross-tenant write. Membership in both is not permission to
//     connect them.
//   - **Double counting.** A Chat mention now writes into Work's `mentions`
//     table. If it also counted on the Chat side of the switcher badge, the two
//     numbers would add to more than the number of things that have happened,
//     which is the error people notice once and never forgive.
//   - **Unfinished, not broken.** A reference that cannot be resolved has to
//     read as something not yet connected, saying nothing about whether the
//     object exists.
//
// `anyApi` rather than the generated `api`, for the reason every buzz suite
// states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const bridge = anyApi.buzz.bridge;
const mentions = anyApi.mentions;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
/** In Acme, but in none of its private rooms and none of Beta. */
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

// ---------------------------------------------------------------------------
// One repair to the test double, borrowed verbatim from tests/buzz-search.test.ts
// ---------------------------------------------------------------------------

/**
 * convex-test 0.0.54 evaluates a search index by scanning every row in the
 * table and calling `.split()` on the search field without checking it is
 * there. In real Convex a row with no `searchText` is simply not in the index.
 *
 * The shim reorders the equality filters ahead of the text filter so the fake
 * short-circuits on rows the real index would never have held. `.every` is
 * order-independent as a predicate, so no row's verdict changes — only whether
 * the fake reaches an undefined field before deciding.
 *
 * Copied rather than imported because a test file exporting helpers to another
 * test file is how a fixture quietly becomes a dependency; it is fifteen lines
 * and its correctness is argued in full in the file it came from.
 */
type SyscallHost = {
  syscall: (op: string, jsonArgs: string) => string;
  asyncSyscall: (op: string, jsonArgs: string) => Promise<string>;
  jsSyscall: (op: string, args: Record<string, unknown>) => unknown;
};

let shimInstalled = false;

function equalityFiltersFirst(jsonArgs: string): string {
  let parsed: {
    query?: { source?: { type?: string; filters?: { type?: string }[] } };
  };
  try {
    parsed = JSON.parse(jsonArgs);
  } catch {
    return jsonArgs;
  }
  const source = parsed.query?.source;
  if (source?.type !== "Search" || !Array.isArray(source.filters)) return jsonArgs;
  source.filters = [
    ...source.filters.filter((filter) => filter.type !== "Search"),
    ...source.filters.filter((filter) => filter.type === "Search"),
  ];
  return JSON.stringify(parsed);
}

function repairSearchIndexFake(): void {
  if (shimInstalled) return;
  const holder = globalThis as unknown as { Convex?: SyscallHost };
  const base = holder.Convex;
  if (!base) return;
  shimInstalled = true;
  holder.Convex = {
    // Getters, because convex-test's own global resolves to the *currently
    // running* test's syscall through AsyncLocalStorage.
    get syscall() {
      const inner = base.syscall;
      return (op: string, jsonArgs: string) =>
        inner(op, op === "1.0/queryStream" ? equalityFiltersFirst(jsonArgs) : jsonArgs);
    },
    get asyncSyscall() {
      return base.asyncSyscall;
    },
    get jsSyscall() {
      return base.jsSyscall;
    },
  };
}

// ---------------------------------------------------------------------------
// The pure half — no database, so the grammar and the arithmetic are checkable
// without one
// ---------------------------------------------------------------------------

describe("the room key", () => {
  it("round-trips a scope and a channel id", () => {
    const scope: Scope = { scopeType: "workspace", scopeId: "ws_1" };
    const parsed = parseRoomKey(roomKey(scope, "chan_1"));
    expect(parsed).toEqual({ scope, channelId: "chan_1" });
  });

  it("carries the scope, because a channel id is only unique inside one", () => {
    // The whole reason `mentions.parentId` is not a bare channel id: two
    // communities can hold the same id, and an inbox that guessed would deep
    // link one tenant's reader into another tenant's room.
    const a = roomKey({ scopeType: "workspace", scopeId: "ws_a" }, "same");
    const b = roomKey({ scopeType: "workspace", scopeId: "ws_b" }, "same");
    expect(a).not.toEqual(b);
  });

  it("is total: anything that is not a room key is null, never a throw", () => {
    for (const bad of ["", "nonsense", "a|b", "a|b|c|d", "team|ws|chan", "|ws|c"]) {
      expect(parseRoomKey(bad)).toBeNull();
    }
  });
});

describe("the reference grammar, one literal wider", () => {
  it("added `room` and nothing else", () => {
    expect([...REF_KINDS]).toEqual([
      "project",
      "list",
      "task",
      "page",
      "sprint",
      "goal",
      "room",
    ]);
  });

  it("parses a room reference through the app's one extractor", () => {
    const body = `see ${formatRef("room", "chan_9", "design")}`;
    expect(extractRefs(body)).toEqual([
      { kind: "room", id: "chan_9", label: "design" },
    ]);
  });

  it("splits mentions and references out of one body, in order", () => {
    const body = `@[Ada](user_a) look at ${formatRef("task", "t1", "Payroll")} today`;
    expect(parseBridgeBody(body)).toEqual([
      { kind: "mention", name: "Ada", actorId: "user_a" },
      { kind: "text", text: " look at " },
      { kind: "ref", refKind: "task", id: "t1", label: "Payroll" },
      { kind: "text", text: " today" },
    ]);
  });

  it("never opens a reference inside a mention's name", () => {
    // A display name with brackets in it must not be able to forge a token.
    const body = "@[#[x](task:evil)](user_a) hi";
    const parts = parseBridgeBody(body);
    expect(parts.some((p) => p.kind === "ref")).toBe(false);
  });

  it("collects task ids for one subscription, deduplicated and capped", () => {
    const bodies = [
      `${formatRef("task", "t1", "A")} ${formatRef("task", "t2", "B")}`,
      `${formatRef("task", "t1", "A again")} ${formatRef("page", "p1", "P")}`,
    ];
    expect(taskIdsIn(bodies)).toEqual(["t1", "t2"]);
    expect(taskIdsIn([`${formatRef("task", "t1", "A")}`.repeat(1)], 0)).toEqual([]);
  });

  it("writes a token the extractor reads back", () => {
    const token = taskRefToken("t7", "Ship (v2) [beta]");
    expect(extractRefs(token)).toEqual([
      { kind: "task", id: "t7", label: "Ship v2 beta" },
    ]);
  });
});

describe("hrefs", () => {
  it("needs a list to address a task, and says so rather than guessing", () => {
    expect(workHref("task", "t1")).toBeNull();
    expect(workHref("task", "t1", { listId: "l1" })).toBe("/dashboard/l/l1/t/t1");
  });

  it("routes a room reference into Chat", () => {
    expect(workHref("room", "chan_1")).toBe(roomHref("chan_1"));
  });
});

describe("the switcher badge", () => {
  it("shows nothing for nothing", () => {
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(-3)).toBe("");
    expect(badgeLabel(Number.NaN)).toBe("");
  });

  it("caps rather than growing the control", () => {
    expect(badgeLabel(BADGE_CAP)).toBe("99");
    expect(badgeLabel(BADGE_CAP + 1)).toBe("99+");
  });

  it("partitions every queue to exactly one side", () => {
    const counts = partitionCounts({
      workMentions: 2,
      workUpdates: 1,
      workApprovals: 3,
      chatRoomMentions: 4,
      chatUpdates: 5,
    });
    expect(counts).toEqual({ work: 6, chat: 9 });
    // Disjoint: every input appears in exactly one total, so the two can never
    // add to more than what happened.
    expect(counts.work + counts.chat).toBe(2 + 1 + 3 + 4 + 5);
  });

  it("badges the side you are not standing in", () => {
    const counts = { work: 3, chat: 7 };
    expect(badgeForOtherSide(counts, "chat")).toBe(3);
    expect(badgeForOtherSide(counts, "work")).toBe(7);
    expect(modeForPath("/chat")).toBe("chat");
    expect(modeForPath("/chat/c/abc")).toBe("chat");
    expect(modeForPath("/dashboard")).toBe("work");
    // Not a prefix match on "/chat" alone: a Work route that merely starts with
    // those letters is still Work.
    expect(modeForPath("/dashboard/chat")).toBe("work");
  });

  it("routes a Chat notification to the Chat side by the prefix it already writes", () => {
    expect(isChatNotification("chat.needs_action")).toBe(true);
    expect(isChatNotification("task.assigned")).toBe(false);
    // An unprefixed row counts as Work, which is the safe direction: a Work
    // badge one too high sends somebody to their inbox, a Chat badge one too
    // high sends them to a room with nothing in it.
    expect(isChatNotification("")).toBe(false);
  });
});

describe("the live task line", () => {
  const base: TaskCard = {
    taskId: "t1",
    listId: "l1",
    listName: "Launch",
    title: "Payroll rewrite",
    statusName: "In progress",
    statusColor: "#abc",
    statusCategory: "in_progress",
    assigneeNames: [],
    blocked: false,
  };
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("says the state, who has it, and when it is due", () => {
    expect(
      describeTask(
        { ...base, assigneeNames: ["Ada"], dueDate: 1_000 },
        0,
        fmt,
      ),
    ).toBe("In progress · Ada · due 1970-01-01");
  });

  it("calls an open task past its date overdue, and a finished one never", () => {
    expect(describeTask({ ...base, dueDate: 1_000 }, 2_000, fmt)).toContain(
      "overdue",
    );
    expect(
      describeTask(
        { ...base, statusCategory: "complete", dueDate: 1_000 },
        2_000,
        fmt,
      ),
    ).toContain("due");
  });

  it("counts assignees rather than listing a crowd", () => {
    expect(
      describeTask({ ...base, assigneeNames: ["Ada", "Bo", "Cy"] }, 0, fmt),
    ).toBe("In progress · 3 assignees");
  });
});

describe("the binding sentence", () => {
  it("distinguishes 'not bound' from 'bound to something you cannot see'", () => {
    expect(bindingSentence(null, false)).toBe("Not bound to a project");
    expect(bindingSentence(null, true)).toBe(
      "Bound to a project you cannot see",
    );
    expect(
      bindingSentence(
        { projectId: "p1", projectName: "Launch", spaceName: "HQ", boundAt: 0 },
        true,
      ),
    ).toBe("Bound to Launch");
  });
});

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

async function seed() {
  const t = convexTest(schema, modules);
  repairSearchIndexFake();
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
        pubkey: publicKeyFromSecret(KEYS[person.subject]),
        secretKey: KEYS[person.subject],
        createdAt: Date.now(),
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    // A second tenant, with its own project and its own room, so "the fence"
    // is a claim about two real communities rather than about a string that
    // resolves to nothing. Alice belongs to both — which is exactly the case
    // that passes every local check and must still be refused.
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Beta",
      slug: "beta",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
      [CAROL.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });

    const space = async (wsId: typeof workspaceId, name: string) =>
      await ctx.db.insert("spaces", {
        name,
        parentType: "workspace",
        parentId: wsId,
        position: 0,
        createdAt: Date.now(),
      });
    const acmeSpace = await space(workspaceId, "HQ");
    const betaSpace = await space(otherWorkspaceId, "HQ");

    const project = async (spaceId: typeof acmeSpace, name: string) =>
      await ctx.db.insert("projects", {
        name,
        spaceId,
        position: 0,
        createdAt: Date.now(),
      });
    const acmeProject = await project(acmeSpace, "Launch");
    const betaProject = await project(betaSpace, "Beta launch");

    const listIn = async (projectId: typeof acmeProject, name: string) => {
      const listId = await ctx.db.insert("lists", {
        name,
        parentType: "project",
        parentId: projectId,
        position: 0,
        createdAt: Date.now(),
      });
      const statusId = await ctx.db.insert("listStatuses", {
        listId,
        name: "To Do",
        color: "#d4d4d8",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      return { listId, statusId };
    };
    const acmeList = await listIn(acmeProject, "Launch tasks");
    const betaList = await listIn(betaProject, "Beta tasks");

    const acmeTask = await ctx.db.insert("tasks", {
      listId: acmeList.listId,
      title: "Payroll rewrite",
      statusId: acmeList.statusId,
      assigneeClerkIds: [ALICE.subject],
      position: 0,
      createdAt: Date.now(),
      createdByClerkId: ALICE.subject,
    });
    // The one a reader in Acme must never learn anything live about.
    const betaTask = await ctx.db.insert("tasks", {
      listId: betaList.listId,
      title: "Beta secret plan",
      statusId: betaList.statusId,
      assigneeClerkIds: [],
      position: 0,
      createdAt: Date.now(),
      createdByClerkId: ALICE.subject,
    });

    return {
      workspaceId,
      otherWorkspaceId,
      acmeProject,
      betaProject,
      acmeList: acmeList.listId,
      betaList: betaList.listId,
      acmeTask,
      betaTask,
    };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const otherScope: Scope = {
    scopeType: "workspace",
    scopeId: ids.otherWorkspaceId,
  };
  return { t, scope, otherScope, ids };
}

async function createChannel(
  t: Harness,
  scope: Scope,
  name: string,
  as = ALICE,
  visibility: "open" | "private" = "open",
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, name, visibility })) as {
    channelId: string;
  };
  return result.channelId;
}

async function join(
  t: Harness,
  scope: Scope,
  channelId: string,
  as: { subject: string },
): Promise<void> {
  await t.withIdentity(as).mutation(channels.join, { ...scope, channelId });
}

async function post(
  t: Harness,
  scope: Scope,
  channelId: string,
  body: string,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(messages.post, { ...scope, channelId, body })) as {
    eventId: string;
  };
  return result.eventId;
}

type ResolvedRef = {
  kind: string;
  id: string;
  label: string;
  href: string | null;
  title: string | null;
  found: boolean;
};

async function resolve(
  t: Harness,
  scope: Scope,
  refs: { kind: string; id: string; label: string }[],
  as: { subject: string } | null = ALICE,
): Promise<ResolvedRef[]> {
  const runner = as ? t.withIdentity(as) : t;
  return (await runner.query(bridge.resolveRefs, {
    ...scope,
    refs,
  })) as ResolvedRef[];
}

// ---------------------------------------------------------------------------
// The leak: a reference the reader may not follow
// ---------------------------------------------------------------------------

describe("references resolve to nothing rather than leaking", () => {
  it("gives a reader the live title only for what they can already open", async () => {
    const { t, scope, ids } = await seed();
    const mine = await resolve(t, scope, [
      { kind: "task", id: ids.acmeTask, label: "the payroll thing" },
    ]);
    expect(mine[0].found).toBe(true);
    expect(mine[0].title).toBe("Payroll rewrite");
    expect(mine[0].href).toBe(`/dashboard/l/${ids.acmeList}/t/${ids.acmeTask}`);
  });

  it("hands a cross-tenant task back with no title and no link", async () => {
    const { t, scope, ids } = await seed();
    // Carol is in Acme and not in Beta. The label is prose she can already read
    // in the message; the task's *current* title is the thing that must not
    // arrive.
    const refs = await resolve(
      t,
      scope,
      [{ kind: "task", id: ids.betaTask, label: "that other thing" }],
      CAROL,
    );
    expect(refs[0].found).toBe(false);
    expect(refs[0].title).toBeNull();
    expect(refs[0].href).toBeNull();
    // Belt to the braces: nothing anywhere in the answer says the words.
    expect(JSON.stringify(refs)).not.toContain("Beta secret plan");
  });

  it("keeps a private room's existence out of the answer", async () => {
    const { t, scope } = await seed();
    const secret = await createChannel(t, scope, "acquisition", ALICE, "private");
    const asCarol = await resolve(
      t,
      scope,
      [{ kind: "room", id: secret, label: "that room" }],
      CAROL,
    );
    expect(asCarol[0].found).toBe(false);
    expect(asCarol[0].title).toBeNull();

    const asAlice = await resolve(t, scope, [
      { kind: "room", id: secret, label: "that room" },
    ]);
    expect(asAlice[0].found).toBe(true);
    expect(asAlice[0].href).toBe(roomHref(secret));
  });

  it("refuses everything for a caller outside the community", async () => {
    const { t, scope, ids } = await seed();
    const refs = await resolve(
      t,
      scope,
      [{ kind: "task", id: ids.acmeTask, label: "x" }],
      OUTSIDER,
    );
    expect(refs[0].found).toBe(false);
  });

  it("renders an unparseable or dangling reference as unfinished, not broken", async () => {
    const { t, scope } = await seed();
    const refs = await resolve(t, scope, [
      { kind: "task", id: "not-an-id", label: "a thought" },
      { kind: "nonsense", id: "x", label: "another" },
    ]);
    for (const ref of refs) {
      expect(ref.found).toBe(false);
      expect(ref.href).toBeNull();
      // The author's words survive: the chip has something to draw.
      expect(ref.label.length).toBeGreaterThan(0);
    }
  });
});

describe("live task cards", () => {
  it("omits a task the reader cannot open, rather than returning it empty", async () => {
    const { t, scope, ids } = await seed();
    void scope;
    const cards = (await t.withIdentity(CAROL).query(bridge.taskCards, {
      taskIds: [ids.acmeTask, ids.betaTask],
    })) as { taskId: string; title: string }[];
    expect(cards.map((c) => c.taskId)).toEqual([ids.acmeTask]);
    expect(JSON.stringify(cards)).not.toContain("Beta secret plan");
  });

  it("reads the task's state now, not the state it had when it was named", async () => {
    const { t, scope, ids } = await seed();
    void scope;
    const before = (await t
      .withIdentity(ALICE)
      .query(bridge.taskCards, { taskIds: [ids.acmeTask] })) as {
      title: string;
    }[];
    expect(before[0].title).toBe("Payroll rewrite");

    await t.run(async (ctx: Ctx) => {
      await ctx.db.patch(ids.acmeTask, { title: "Payroll rewrite (v2)" });
    });

    const after = (await t
      .withIdentity(ALICE)
      .query(bridge.taskCards, { taskIds: [ids.acmeTask] })) as {
      title: string;
    }[];
    // The point of the whole phase in one assertion: nothing was written when
    // the task was renamed, and the room says the new name anyway.
    expect(after[0].title).toBe("Payroll rewrite (v2)");
  });
});

// ---------------------------------------------------------------------------
// The fence, in both directions
// ---------------------------------------------------------------------------

describe("binding a room to a project", () => {
  it("refuses a project in another community, even for somebody in both", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(bridge.bindProject, {
          ...scope,
          channelId: room,
          projectId: ids.betaProject,
        }),
    ).rejects.toThrow(/different community/i);
  });

  it("refuses a member who cannot govern the community", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await join(t, scope, room, CAROL);
    await expect(
      t.withIdentity(CAROL).mutation(bridge.bindProject, {
        ...scope,
        channelId: room,
        projectId: ids.acmeProject,
      }),
    ).rejects.toThrow(/owner or admin/i);
  });

  it("binds, and records it in Work's activity log rather than the Chat log", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await t.withIdentity(ALICE).mutation(bridge.bindProject, {
      ...scope,
      channelId: room,
      projectId: ids.acmeProject,
    });

    const binding = (await t
      .withIdentity(ALICE)
      .query(bridge.roomBinding, { ...scope, channelId: room })) as {
      bound: boolean;
      projectName: string | null;
    };
    expect(binding.bound).toBe(true);
    expect(binding.projectName).toBe("Launch");

    const events = await t.run(async (ctx: Ctx) =>
      ctx.db.query("events").collect(),
    );
    expect(events.some((e) => e.type === "chat.room_bound")).toBe(true);
    // And only one binding row, however many times it is rebound.
    await t.withIdentity(ALICE).mutation(bridge.bindProject, {
      ...scope,
      channelId: room,
      projectId: ids.acmeProject,
    });
    const rows = await t.run(async (ctx: Ctx) =>
      ctx.db.query("buzzRoomBindings").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("says a room is bound without naming a project the reader cannot see", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await t.withIdentity(ALICE).mutation(bridge.bindProject, {
      ...scope,
      channelId: room,
      projectId: ids.acmeProject,
    });
    // Carol can reach the room. Take the project's space out from under her by
    // moving it to the other community — the binding row still says "bound",
    // and the name has to stop arriving.
    await t.run(async (ctx: Ctx) => {
      const project = await ctx.db.get(ids.acmeProject);
      const space = await ctx.db.get(project!.spaceId);
      await ctx.db.patch(space!._id, { parentId: ids.otherWorkspaceId });
    });
    await join(t, scope, room, CAROL);
    const binding = (await t
      .withIdentity(CAROL)
      .query(bridge.roomBinding, { ...scope, channelId: room })) as {
      bound: boolean;
      projectName: string | null;
    };
    expect(binding.bound).toBe(true);
    expect(binding.projectName).toBeNull();
  });

  it("shows the bound project's Work events in the room, and nobody else's", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await t.withIdentity(ALICE).mutation(bridge.bindProject, {
      ...scope,
      channelId: room,
      projectId: ids.acmeProject,
    });
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("events", {
        scopeType: "workspace",
        scopeId: ids.workspaceId,
        type: "task.created",
        actorType: "user",
        actorId: ALICE.subject,
        actorName: "Alice",
        entityType: "task",
        entityId: ids.acmeTask,
        entityTitle: "Payroll rewrite",
        listId: ids.acmeList,
        createdAt: Date.now(),
      });
      // Same community, different project: it must not appear.
      const otherList = await ctx.db.insert("lists", {
        name: "Elsewhere",
        parentType: "space",
        parentId: (await ctx.db.get(ids.acmeProject))!.spaceId,
        position: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("events", {
        scopeType: "workspace",
        scopeId: ids.workspaceId,
        type: "task.created",
        actorType: "user",
        actorId: ALICE.subject,
        actorName: "Alice",
        entityType: "task",
        entityId: "elsewhere",
        entityTitle: "Unrelated",
        listId: otherList,
        createdAt: Date.now(),
      });
    });

    const feed = (await t
      .withIdentity(ALICE)
      .query(bridge.roomWorkFeed, { ...scope, channelId: room })) as {
      entityTitle?: string;
    }[];
    const titles = feed.map((row) => row.entityTitle);
    expect(titles).toContain("Payroll rewrite");
    expect(titles).not.toContain("Unrelated");
  });

  it("keeps the Work feed empty for a reader who cannot see the project", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await join(t, scope, room, CAROL);
    await t.withIdentity(ALICE).mutation(bridge.bindProject, {
      ...scope,
      channelId: room,
      projectId: ids.acmeProject,
    });
    await t.run(async (ctx: Ctx) => {
      const project = await ctx.db.get(ids.acmeProject);
      const space = await ctx.db.get(project!.spaceId);
      await ctx.db.patch(space!._id, { parentId: ids.otherWorkspaceId });
      await ctx.db.insert("events", {
        scopeType: "workspace",
        scopeId: ids.workspaceId,
        type: "task.created",
        actorType: "user",
        actorId: ALICE.subject,
        actorName: "Alice",
        entityType: "task",
        entityId: ids.acmeTask,
        entityTitle: "Payroll rewrite",
        listId: ids.acmeList,
        createdAt: Date.now(),
      });
    });
    const feed = (await t
      .withIdentity(CAROL)
      .query(bridge.roomWorkFeed, { ...scope, channelId: room })) as unknown[];
    expect(feed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A message becomes a task
// ---------------------------------------------------------------------------

describe("a message becomes a task", () => {
  it("creates it through Work's core and links back in the log", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    const eventId = await post(t, scope, room, "somebody should redo payroll");

    const result = (await t
      .withIdentity(ALICE)
      .mutation(bridge.createTaskFromMessage, {
        ...scope,
        channelId: room,
        eventId,
        listId: ids.acmeList,
      })) as { taskId: string; listId: string };

    const task = await t.run(async (ctx: Ctx) => {
      const id = ctx.db.normalizeId("tasks", result.taskId);
      return id ? await ctx.db.get(id) : null;
    });
    expect(task!.title).toBe("somebody should redo payroll");
    // Through the core, so Work's own activity log has it — the same row a task
    // typed into a list produces.
    const events = await t.run(async (ctx: Ctx) =>
      ctx.db.query("events").collect(),
    );
    expect(events.some((e) => e.type === "task.created")).toBe(true);

    // The link back is a message in the room, not a column on either side.
    const posted = await t.run(async (ctx: Ctx) =>
      ctx.db.query("buzzEvents").collect(),
    );
    const link = posted.find((row: { content: string }) =>
      row.content.includes(`task:${result.taskId}`),
    );
    expect(link).toBeTruthy();
    expect(extractRefs(link!.content)[0]).toMatchObject({
      kind: "task",
      id: result.taskId,
    });
  });

  it("refuses a list in another community", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    const eventId = await post(t, scope, room, "do the thing");
    await expect(
      t.withIdentity(ALICE).mutation(bridge.createTaskFromMessage, {
        ...scope,
        channelId: room,
        eventId,
        listId: ids.betaList,
      }),
    ).rejects.toThrow(/different community/i);
  });

  it("refuses a message that is not in the room it claims", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    const other = await createChannel(t, scope, "random");
    const eventId = await post(t, scope, other, "elsewhere");
    await expect(
      t.withIdentity(ALICE).mutation(bridge.createTaskFromMessage, {
        ...scope,
        channelId: room,
        eventId,
        listId: ids.acmeList,
      }),
    ).rejects.toThrow(/not in this room/i);
  });

  it("refuses somebody who is not in the room", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "acquisition", ALICE, "private");
    const eventId = await post(t, scope, room, "quiet please");
    await expect(
      t.withIdentity(CAROL).mutation(bridge.createTaskFromMessage, {
        ...scope,
        channelId: room,
        eventId,
        listId: ids.acmeList,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// One inbox
// ---------------------------------------------------------------------------

describe("the unified inbox", () => {
  it("files a Chat mention in Work's queue, once, with a working deep link", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, "design");
    await join(t, scope, room, BOB);
    await post(t, scope, room, "@[user_bob](user_bob) can you look?");

    const rows = await t.run(async (ctx: Ctx) =>
      ctx.db.query("mentions").collect(),
    );
    const mine = rows.filter(
      (row: { mentionedClerkId: string }) =>
        row.mentionedClerkId === BOB.subject,
    );
    // Exactly one. The double-count this phase exists to avoid is one row here
    // and a second in `notifications` — the Inbox adds both queues.
    expect(mine).toHaveLength(1);
    expect(mine[0].parentType).toBe("room");
    expect(parseRoomKey(mine[0].parentId)).toEqual({
      scope,
      channelId: room,
    });

    const notifications = await t.run(async (ctx: Ctx) =>
      ctx.db.query("notifications").collect(),
    );
    expect(
      notifications.filter(
        (row: { userClerkId: string; type: string }) =>
          row.userClerkId === BOB.subject && row.type.startsWith("chat."),
      ),
    ).toHaveLength(0);

    const feed = (await t
      .withIdentity(BOB)
      .query(mentions.feedForCurrent, {})) as {
      parentType: string;
      href: string | null;
      contextLabel: string;
      body: string;
    }[];
    const row = feed.find((entry) => entry.parentType === "room");
    expect(row?.href).toBe(roomHref(room));
    expect(row?.contextLabel).toBe("#design");
    expect(row?.body).toContain("can you look");
  });

  it("counts the same mention exactly once, on the Chat side", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, "design");
    await join(t, scope, room, BOB);
    await post(t, scope, room, "@[user_bob](user_bob) can you look?");

    const counts = (await t
      .withIdentity(BOB)
      .query(bridge.switcherCounts, {})) as {
      work: number;
      chat: number;
      workMentions: number;
      chatRoomMentions: number;
    };
    // The row is in Work's `mentions` table and it still belongs to Chat: it
    // stops needing you when you open the room, which is a Chat gesture.
    expect(counts.workMentions).toBe(0);
    expect(counts.chatRoomMentions).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.work).toBe(0);
  });

  it("counts a Work mention on the Work side and nowhere else", async () => {
    const { t, scope } = await seed();
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("mentions", {
        mentionedClerkId: BOB.subject,
        parentType: "task",
        parentId: "whatever",
        createdAt: Date.now(),
      });
    });
    void scope;
    const counts = (await t
      .withIdentity(BOB)
      .query(bridge.switcherCounts, {})) as {
      work: number;
      chat: number;
    };
    expect(counts.work).toBe(1);
    expect(counts.chat).toBe(0);
  });

  it("counts an approval waiting on you, which is the case the badge exists for", async () => {
    const { t, ids } = await seed();
    await t.run(async (ctx: Ctx) => {
      await ctx.db.patch(ids.acmeTask, { requiresApproval: true });
    });
    const counts = (await t
      .withIdentity(BOB)
      .query(bridge.switcherCounts, {})) as {
      work: number;
      workApprovals: number;
    };
    expect(counts.workApprovals).toBe(1);
    expect(counts.work).toBe(1);

    // And not for somebody who cannot reach the task at all.
    const outsider = (await t
      .withIdentity(OUTSIDER)
      .query(bridge.switcherCounts, {})) as { workApprovals: number };
    expect(outsider.workApprovals).toBe(0);
  });

  it("stops counting once the mention is read", async () => {
    const { t, scope } = await seed();
    const room = await createChannel(t, scope, "design");
    await join(t, scope, room, BOB);
    await post(t, scope, room, "@[user_bob](user_bob) hello");
    await t.withIdentity(BOB).mutation(mentions.markAllRead, {});
    const rows = await t.run(async (ctx: Ctx) =>
      ctx.db.query("mentions").collect(),
    );
    expect(rows.every((row: { readAt?: number }) => row.readAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One activity log
// ---------------------------------------------------------------------------

describe("one activity log", () => {
  it("records a room message that names a Work object, and only that", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");

    await post(t, scope, room, "morning everyone");
    let events = await t.run(async (ctx: Ctx) =>
      ctx.db.query("events").collect(),
    );
    // Small talk does not belong in Work's feed: an event per chat message
    // would bury the feed under a conversation Chat is already better at
    // holding.
    expect(events.filter((e) => e.type === "chat.reference")).toHaveLength(0);

    await post(
      t,
      scope,
      room,
      `looking at ${formatRef("task", ids.acmeTask, "Payroll")}`,
    );
    events = await t.run(async (ctx: Ctx) => ctx.db.query("events").collect());
    const crossed = events.filter((e) => e.type === "chat.reference");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].entityId).toBe(ids.acmeTask);
    expect(crossed[0].scopeId).toBe(ids.workspaceId);
  });
});

// ---------------------------------------------------------------------------
// One search
// ---------------------------------------------------------------------------

describe("one search", () => {
  it("spans messages, tasks and pages inside one community", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    await post(t, scope, room, "the payroll migration is nearly done");
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("pages", {
        scopeType: "workspace",
        scopeId: ids.workspaceId,
        title: "Payroll notes",
        markdown: "",
        position: 0,
        createdByActorId: ALICE.subject,
        createdByName: "Alice",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const hits = (await t
      .withIdentity(ALICE)
      .query(bridge.search, { ...scope, text: "payroll" })) as {
      kind: string;
      label: string;
    }[];
    const kinds = new Set(hits.map((hit) => hit.kind));
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("page")).toBe(true);
  });

  it("answers with rooms, which the hit union declared and nothing emitted", async () => {
    // The palette's own type carried `kind: "room"` while the handler never
    // produced one, so ⌘K could find what was said in `#design` but not
    // `#design`. A declared kind nothing fills is a type that lies.
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, "design-review");

    const hits = (await t
      .withIdentity(ALICE)
      .query(bridge.search, { ...scope, text: "design" })) as {
      kind: string;
      label: string;
      context: string;
      href: string;
    }[];
    const room = hits.find((hit) => hit.kind === "room");
    expect(room?.label).toBe("#design-review");
    expect(room?.context).toBe("Channel");
    // The href the room's own route takes, not a guess: a palette row that
    // lands nowhere is worse than one fewer row.
    expect(room?.href).toBe(`/chat/c/${channelId}`);
  });

  it("never names a private room the reader is not in", async () => {
    // The rule `requireChannelAccess` enforces, restated where it is easiest to
    // lose: whether `#layoffs` exists is itself the information, and a palette
    // is the surface that would announce it most confidently.
    const { t, scope } = await seed();
    await createChannel(t, scope, "layoffs", ALICE, "private");

    const asBob = (await t
      .withIdentity(BOB)
      .query(bridge.search, { ...scope, text: "layoffs" })) as { kind: string }[];
    expect(asBob.some((hit) => hit.kind === "room")).toBe(false);

    // …and Alice, who made it, does see it — otherwise the assertion above
    // would pass for a build that emits no rooms at all.
    const asAlice = (await t
      .withIdentity(ALICE)
      .query(bridge.search, { ...scope, text: "layoffs" })) as {
      kind: string;
      label: string;
    }[];
    expect(asAlice.find((hit) => hit.kind === "room")?.label).toBe("#layoffs");
  });

  it("answers nothing for a caller outside the community", async () => {
    const { t, scope } = await seed();
    const hits = (await t
      .withIdentity(OUTSIDER)
      .query(bridge.search, { ...scope, text: "payroll" })) as unknown[];
    expect(hits).toHaveLength(0);
  });

  it("does not reach across the tenancy fence", async () => {
    const { t, otherScope } = await seed();
    // Carol is not in Beta. Asking Beta's scope answers nothing, rather than
    // answering with Beta's rows because she happens to be signed in.
    const hits = (await t
      .withIdentity(CAROL)
      .query(bridge.search, { ...otherScope, text: "beta" })) as unknown[];
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// One fleet
// ---------------------------------------------------------------------------

describe("one fleet", () => {
  it("shows an agent's Work task and its rooms in one answer", async () => {
    const { t, scope, ids } = await seed();
    const room = await createChannel(t, scope, "launch");
    const agentId = await t.run(async (ctx: Ctx) => {
      const id = await ctx.db.insert("agents", {
        name: "Scout",
        parentType: "workspace",
        parentId: ids.workspaceId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        currentTaskId: ids.acmeTask,
      });
      await ctx.db.insert("buzzTurns", {
        scopeType: "workspace",
        scopeId: ids.workspaceId,
        channelId: room,
        agentId: id,
        turnId: "turn_1",
        agentPubkey: publicKeyFromSecret(KEYS[ALICE.subject]),
        state: "streaming",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastEventId: "e1",
      });
      return id;
    });

    const fleet = (await t
      .withIdentity(ALICE)
      .query(bridge.fleet, { ...scope, channelId: room })) as {
      agentId: string;
      workTaskTitle: string | null;
      rooms: { channelId: string }[];
    }[];
    const scout = fleet.find((member) => member.agentId === agentId);
    expect(scout?.workTaskTitle).toBe("Payroll rewrite");
    expect(scout?.rooms.map((r) => r.channelId)).toEqual([room]);

    // And the other direction, which is the surface the Work-side agent page
    // mounts.
    const rooms = (await t
      .withIdentity(ALICE)
      .query(bridge.agentRooms, { agentId })) as { channelId: string }[];
    expect(rooms.map((r) => r.channelId)).toEqual([room]);
  });

  it("does not name a task the reader cannot open", async () => {
    const { t, scope, ids } = await seed();
    const agentId = await t.run(async (ctx: Ctx) =>
      ctx.db.insert("agents", {
        name: "Scout",
        parentType: "workspace",
        parentId: ids.workspaceId,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
        // Working a task that lives in the *other* community.
        currentTaskId: ids.betaTask,
      }),
    );
    const fleet = (await t.withIdentity(CAROL).query(bridge.fleet, scope)) as {
      agentId: string;
      workTaskTitle: string | null;
      workTaskId: string | null;
    }[];
    const scout = fleet.find((member) => member.agentId === agentId);
    expect(scout?.workTaskTitle).toBeNull();
    expect(scout?.workTaskId).toBeNull();
  });

  it("answers nothing to a caller outside the community", async () => {
    const { t, scope } = await seed();
    const fleet = (await t
      .withIdentity(OUTSIDER)
      .query(bridge.fleet, scope)) as unknown[];
    expect(fleet).toHaveLength(0);
  });
});
