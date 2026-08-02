import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { sha256Hex } from "../convex/_agentAuth";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { KINDS } from "../convex/buzz/_kinds";
import {
  ACTIVITY_LIMIT,
  KIND_GIT_ISSUE,
  KIND_GIT_PATCH,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_OPEN,
  KIND_PROJECT,
  PROJECT_GLOBAL_KINDS,
  ROOM_FORGE_KINDS,
  asCommitOid,
  buildBranchRoom,
  classifyForgeEvent,
  isStatusOutcome,
  isStatusSubject,
  mergeReadiness,
  normalizeBranchName,
  parseRepoAddress,
  projectActivity,
  projectFromEvent,
  projectHref,
  projectSlug,
  refsFromRepoState,
  repoAddress,
  shortCommit,
  statusKindFor,
  statusSubjectOf,
  summarizeProject,
  type ForgeEvent,
} from "../src/lib/buzz/project";
import {
  TIMELINE_CONTENT_KINDS,
  projectTimeline,
  type TimelineEvent,
} from "../src/lib/buzz/timeline";

// C9 — branch-as-room.
//
// The claim: **a patch, a check result, a review and the merge are events in the
// same log, in the same room, as the argument about them.** Everything below is
// an attempt to break that claim from the direction it would actually break.
//
//   - **Tenancy.** A repository announced in one community must not be visible
//     from another, and a branch room's events must be reachable only through
//     the room's own membership rule. The second one is the reason `_kinds.ts`
//     scopes the forge band `optional` rather than `global`, so there is a test
//     here that a patch is genuinely channel-scoped in the log and not merely
//     hidden by a query.
//   - **Disjointness.** A patch renders in the room's forge panel and *never* in
//     its chat transcript, and not because either side filters: the two content
//     sets have an empty intersection, asserted here against the real sets and
//     then again end to end through the real projector.
//   - **Attribution.** A merge decision is the most consequential row this
//     product writes. It has to be signed by the person who made it, refused for
//     a non-member, and refused for a member with no authority over the branch or
//     the repository.
//   - **One write path.** A person approving and a CI runner reporting reach the
//     same core with different actors, so the membership rule, the ban, the
//     self-review refusal and the merge authority check exist once.
//
// `anyApi` rather than the generated `api`, for the reason the other buzz suites
// state: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const projects = anyApi.buzz.projects;
const log = anyApi.buzz.log;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const CAROL = { subject: "user_carol" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

const RUNNER_KEY = "cua_runner_0000000000";
const RUNNER_SECRET = "05".repeat(32);

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;
type Event = ForgeEvent & { id: string; sig: string };

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_MERGE = "c".repeat(40);

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
// The vocabulary
// ---------------------------------------------------------------------------

describe("the forge vocabulary", () => {
  it("matches the kind registry, number and name", () => {
    const expected: [number, string][] = [
      [KIND_GIT_PATCH, "KIND_GIT_PATCH"],
      [KIND_GIT_PULL_REQUEST, "KIND_GIT_PULL_REQUEST"],
      [KIND_GIT_PR_UPDATE, "KIND_GIT_PR_UPDATE"],
      [KIND_GIT_ISSUE, "KIND_GIT_ISSUE"],
      [KIND_GIT_STATUS_OPEN, "KIND_GIT_STATUS_OPEN"],
      [KIND_GIT_STATUS_MERGED, "KIND_GIT_STATUS_MERGED"],
      [KIND_GIT_STATUS_CLOSED, "KIND_GIT_STATUS_CLOSED"],
      [KIND_GIT_STATUS_DRAFT, "KIND_GIT_STATUS_DRAFT"],
      [KIND_GIT_REPO_ANNOUNCEMENT, "KIND_GIT_REPO_ANNOUNCEMENT"],
      [KIND_GIT_REPO_STATE, "KIND_GIT_REPO_STATE"],
      [KIND_PROJECT, "KIND_PROJECT"],
    ];
    for (const [kind, name] of expected) {
      expect(KINDS.get(kind)?.name, `kind ${kind}`).toBe(name);
    }
  });

  it("scopes the branch-room band to a channel and the project band globally", () => {
    // The whole reason the room can be the record: a patch stored `global` would
    // be readable community-wide and invisible to the room it was posted in.
    for (const kind of ROOM_FORGE_KINDS) {
      expect(KINDS.get(kind)?.scope, `kind ${kind}`).toBe("optional");
    }
    for (const kind of PROJECT_GLOBAL_KINDS) {
      expect(KINDS.get(kind)?.scope, `kind ${kind}`).toBe("global");
    }
  });

  it("keeps the forge set and the transcript set disjoint, in both directions", () => {
    for (const kind of ROOM_FORGE_KINDS) {
      expect(TIMELINE_CONTENT_KINDS.has(kind), `forge kind ${kind}`).toBe(false);
    }
    for (const kind of TIMELINE_CONTENT_KINDS) {
      expect(ROOM_FORGE_KINDS.has(kind), `timeline kind ${kind}`).toBe(false);
    }
  });

  it("maps a kind and a subject to exactly one outcome, and refuses the pairs with no meaning", () => {
    expect(statusKindFor("ci", "passed")).toBe(KIND_GIT_STATUS_OPEN);
    expect(statusKindFor("review", "approved")).toBe(KIND_GIT_STATUS_OPEN);
    expect(statusKindFor("state", "merged")).toBe(KIND_GIT_STATUS_MERGED);
    // There is no such thing as a merged build or a provisional review.
    expect(statusKindFor("ci", "merged")).toBeNull();
    expect(statusKindFor("review", "running")).toBeNull();
    expect(isStatusOutcome("ci", "passed")).toBe(true);
    expect(isStatusOutcome("ci", "approved")).toBe(false);
    expect(isStatusSubject("ci")).toBe(true);
    expect(isStatusSubject("build")).toBe(false);
  });

  it("reads a status with no subject tag as a lifecycle status", () => {
    // Tolerant on read, strict on write: a NIP-34 status from a foreign tool
    // carries no `t` and means exactly this.
    expect(statusSubjectOf([])).toBe("state");
    expect(statusSubjectOf([["t", "nonsense"]])).toBe("state");
    expect(statusSubjectOf([["t", "ci"]])).toBe("ci");
  });
});

describe("addresses, slugs and refs", () => {
  it("round-trips a repo address and refuses anything else", () => {
    const owner = "a".repeat(64);
    const address = repoAddress(owner, "payments-api");
    expect(address).toBe(`30617:${owner}:payments-api`);
    expect(parseRepoAddress(address)).toEqual({ owner, dtag: "payments-api" });
    // A `d` may contain colons; everything after the second one is the id.
    expect(parseRepoAddress(`30617:${owner}:a:b`)).toEqual({ owner, dtag: "a:b" });
    expect(parseRepoAddress(`30621:${owner}:x`)).toBeNull();
    expect(parseRepoAddress(`30617:NOTHEX:x`)).toBeNull();
    expect(parseRepoAddress(`30617:${owner}:`)).toBeNull();
  });

  it("slugifies a name the way the store keys on it", () => {
    expect(projectSlug("Payments API")).toBe("payments-api");
    expect(projectSlug("  --Payments / API--  ")).toBe("payments-api");
    expect(projectSlug("!!!")).toBe("");
  });

  it("accepts a git ref name and refuses a repaired one", () => {
    expect(normalizeBranchName(" feature/retry-budget ")).toBe("feature/retry-budget");
    expect(normalizeBranchName("")).toBeNull();
    expect(normalizeBranchName("with space")).toBeNull();
    expect(normalizeBranchName("/leading")).toBeNull();
    expect(normalizeBranchName("trailing/")).toBeNull();
    expect(normalizeBranchName("a//b")).toBeNull();
    expect(normalizeBranchName("a/../b")).toBeNull();
    expect(normalizeBranchName("x".repeat(500))).toBeNull();
  });

  it("reads a commit oid at 40 or 64 hex and nothing else", () => {
    expect(asCommitOid(OID_A)).toBe(OID_A);
    expect(asCommitOid("f".repeat(64))).toBe("f".repeat(64));
    expect(asCommitOid("abc")).toBeUndefined();
    expect(asCommitOid("z".repeat(40))).toBeUndefined();
    expect(shortCommit(OID_A)).toBe("aaaaaaa");
    expect(shortCommit(null)).toBe("");
  });

  it("reads ref state, strips the HEAD prefix and skips an unreadable oid", () => {
    const state = refsFromRepoState({
      id: "e1",
      pubkey: "a".repeat(64),
      created_at: 10,
      kind: KIND_GIT_REPO_STATE,
      tags: [
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", OID_A],
        ["refs/heads/broken", "nope"],
        ["refs/tags/v1", OID_B],
      ],
      content: "",
    });
    expect(state?.head).toBe("main");
    // One unreadable ref must not lose the other ninety-nine.
    expect(state?.branches).toEqual([{ name: "main", oid: OID_A }]);
    expect(state?.tags).toEqual([{ name: "v1", oid: OID_B }]);
  });
});

describe("reading an announcement", () => {
  const owner = "a".repeat(64);
  function announcement(tags: string[][], content = ""): ForgeEvent {
    return {
      id: "e1",
      pubkey: owner,
      created_at: 100,
      kind: KIND_GIT_REPO_ANNOUNCEMENT,
      tags,
      content,
    };
  }

  it("falls back rather than dropping a malformed announcement", () => {
    const project = projectFromEvent(announcement([], "just a blurb"));
    // No `d`, no `name`: the event id stands in, and the card still renders.
    expect(project?.dtag).toBe("e1");
    expect(project?.name).toBe("e1");
    expect(project?.description).toBe("just a blurb");
  });

  it("refuses an announcement it cannot attribute", () => {
    expect(projectFromEvent({ ...announcement([["d", "x"]]), pubkey: "nope" })).toBeNull();
  });

  it("reads multi-value clone tags and always includes the owner as a maintainer", () => {
    const project = projectFromEvent(
      announcement([
        ["d", "api"],
        ["name", "API"],
        ["clone", "https://one", "https://two"],
        ["maintainers", "b".repeat(64)],
      ]),
    );
    expect(project?.cloneUrls).toEqual(["https://one", "https://two"]);
    expect(project?.maintainers).toEqual([owner, "b".repeat(64)]);
    expect(projectHref(project?.id ?? "")).toContain(encodeURIComponent(`${owner}:api`));
  });

  it("takes the FIRST buzz-channel tag, and a broken first tag binds nothing", () => {
    // Buzz's `RepoBinding::Broken` rule: "find the first parseable tag" would let
    // an author who can append a second tag choose which channel governs.
    const good = "1".repeat(64);
    expect(
      projectFromEvent(
        announcement([
          ["d", "api"],
          ["buzz-channel", good],
          ["buzz-channel", "2".repeat(64)],
        ]),
      )?.projectChannelId,
    ).toBe(good);
    expect(
      projectFromEvent(
        announcement([
          ["d", "api"],
          ["buzz-channel", "garbage"],
          ["buzz-channel", good],
        ]),
      )?.projectChannelId,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

const REPO = repoAddress("a".repeat(64), "api");

function ev(over: Partial<ForgeEvent> & { kind: number; id: string }): ForgeEvent {
  return {
    pubkey: "1".repeat(64),
    created_at: 100,
    tags: [],
    content: "",
    ...over,
  };
}

function binding(over: Partial<ForgeEvent> = {}): ForgeEvent {
  return ev({
    id: "bind1",
    kind: KIND_GIT_PULL_REQUEST,
    created_at: 100,
    tags: [
      ["a", REPO],
      ["branch-name", "feature/x"],
      ["target-branch", "main"],
      ["subject", "Retry budget"],
      ["c", OID_A],
    ],
    ...over,
  });
}

function status(
  id: string,
  kind: number,
  subject: string,
  over: Partial<ForgeEvent> = {},
): ForgeEvent {
  return ev({
    id,
    kind,
    tags: [
      ["t", subject],
      ["e", "bind1"],
    ],
    ...over,
  });
}

describe("classifying one event", () => {
  it("refuses a binding with an unusable address or branch", () => {
    expect(classifyForgeEvent(binding())?.type).toBe("binding");
    expect(
      classifyForgeEvent(binding({ tags: [["a", "nope"], ["branch-name", "x"]] })),
    ).toBeNull();
    expect(classifyForgeEvent(binding({ tags: [["a", REPO]] }))).toBeNull();
  });

  it("refuses a tip update that names nothing", () => {
    expect(
      classifyForgeEvent(ev({ id: "u", kind: KIND_GIT_PR_UPDATE, tags: [["c", OID_B]] }))?.type,
    ).toBe("update");
    expect(classifyForgeEvent(ev({ id: "u", kind: KIND_GIT_PR_UPDATE }))).toBeNull();
  });

  it("returns null for the room's conversation", () => {
    expect(classifyForgeEvent(ev({ id: "m", kind: 9, content: "hello" }))).toBeNull();
    expect(classifyForgeEvent(ev({ id: "r", kind: 7, content: "+" }))).toBeNull();
  });
});

describe("folding a branch room", () => {
  it("keeps the EARLIEST binding, so a room cannot be re-pointed later", () => {
    const room = buildBranchRoom("ch", [
      binding(),
      binding({
        id: "bind2",
        created_at: 500,
        tags: [
          ["a", REPO],
          ["branch-name", "feature/other"],
        ],
      }),
    ]);
    expect(room.binding?.branch).toBe("feature/x");
  });

  it("takes the tip from the newest claim, and falls back to the binding", () => {
    expect(buildBranchRoom("ch", [binding()]).tip).toBe(OID_A);
    const moved = buildBranchRoom("ch", [
      binding(),
      ev({ id: "u1", kind: KIND_GIT_PR_UPDATE, created_at: 200, tags: [["c", OID_B]] }),
    ]);
    expect(moved.tip).toBe(OID_B);
  });

  it("keeps one decision per reviewer, latest wins, and marks a stale one", () => {
    const bob = "2".repeat(64);
    const room = buildBranchRoom("ch", [
      binding(),
      ev({ id: "u1", kind: KIND_GIT_PR_UPDATE, created_at: 150, tags: [["c", OID_B]] }),
      // Bob approved against the old tip, then asked for changes against the new
      // one. Both are his; only the second is what he thinks.
      status("s1", KIND_GIT_STATUS_OPEN, "review", {
        pubkey: bob,
        created_at: 120,
        tags: [["t", "review"], ["e", "bind1"], ["c", OID_A]],
      }),
      status("s2", KIND_GIT_STATUS_CLOSED, "review", {
        pubkey: bob,
        created_at: 200,
        tags: [["t", "review"], ["e", "bind1"], ["c", OID_B]],
      }),
      // Carol approved against the old tip and never came back.
      status("s3", KIND_GIT_STATUS_OPEN, "review", {
        pubkey: "3".repeat(64),
        created_at: 130,
        tags: [["t", "review"], ["e", "bind1"], ["c", OID_A]],
      }),
    ]);
    expect(room.reviews).toHaveLength(2);
    const byBob = room.reviews.find((r) => r.by === bob);
    expect(byBob?.outcome).toBe("changes_requested");
    expect(byBob?.current).toBe(true);
    const byCarol = room.reviews.find((r) => r.by === "3".repeat(64));
    expect(byCarol?.outcome).toBe("approved");
    expect(byCarol?.current).toBe(false);
  });

  it("reads the latest check and the state ladder", () => {
    const running = buildBranchRoom("ch", [
      binding(),
      status("c1", KIND_GIT_STATUS_DRAFT, "ci", { created_at: 110 }),
      status("c2", KIND_GIT_STATUS_OPEN, "ci", { created_at: 120 }),
    ]);
    expect(running.check?.outcome).toBe("passed");
    expect(running.state).toBe("open");

    const drafted = buildBranchRoom("ch", [
      binding(),
      status("d1", KIND_GIT_STATUS_DRAFT, "state", { created_at: 110 }),
    ]);
    expect(drafted.state).toBe("draft");

    const merged = buildBranchRoom("ch", [
      binding(),
      status("m1", KIND_GIT_STATUS_MERGED, "state", {
        created_at: 300,
        tags: [["t", "state"], ["e", "bind1"], ["merge-commit", OID_MERGE]],
      }),
      // A later close does not un-merge anything.
      status("x1", KIND_GIT_STATUS_CLOSED, "state", { created_at: 400 }),
    ]);
    expect(merged.state).toBe("merged");
    expect(merged.merge?.mergeCommit).toBe(OID_MERGE);
  });

  it("names what is missing before a merge, and never claims more than it knows", () => {
    const blocked = mergeReadiness(
      buildBranchRoom("ch", [
        binding(),
        status("c1", KIND_GIT_STATUS_CLOSED, "ci", { created_at: 120 }),
      ]),
    );
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toContain("Checks failed");
    expect(blocked.blockers).toContain("No current approval");

    const ready = mergeReadiness(
      buildBranchRoom("ch", [
        binding(),
        status("c1", KIND_GIT_STATUS_OPEN, "ci", { created_at: 120 }),
        status("s1", KIND_GIT_STATUS_OPEN, "review", {
          pubkey: "2".repeat(64),
          created_at: 130,
          tags: [["t", "review"], ["e", "bind1"], ["c", OID_A]],
        }),
      ]),
    );
    expect(ready).toEqual({ ready: true, blockers: [] });
  });

  it("rolls a project up over only the rooms it is handed", () => {
    const project = projectFromEvent({
      id: "p1",
      pubkey: "a".repeat(64),
      created_at: 1,
      kind: KIND_GIT_REPO_ANNOUNCEMENT,
      tags: [["d", "api"], ["name", "API"]],
      content: "",
    });
    const room = buildBranchRoom("ch", [
      binding(),
      ev({
        id: "p2",
        kind: KIND_GIT_PATCH,
        created_at: 140,
        tags: [["a", REPO], ["subject", "Fix"], ["c", OID_B]],
        content: "diff",
      }),
    ]);
    const summary = summarizeProject(project as NonNullable<typeof project>, [room]);
    expect(summary.branchRooms).toBe(1);
    expect(summary.openBranchRooms).toBe(1);
    expect(summary.patches).toBe(1);
    expect(summary.participants).toContain("1".repeat(64));
  });

  it("builds a newest-first feed and caps it", () => {
    const rooms = Array.from({ length: 30 }, (_, index) =>
      buildBranchRoom(`ch${index}`, [
        binding({ id: `bind${index}`, created_at: 100 + index }),
        ev({
          id: `patch${index}`,
          kind: KIND_GIT_PATCH,
          created_at: 200 + index,
          tags: [["a", REPO]],
          content: "diff",
        }),
      ]),
    );
    const feed = projectActivity(rooms);
    expect(feed.length).toBe(ACTIVITY_LIMIT);
    for (let i = 1; i < feed.length; i += 1) {
      expect(feed[i - 1].at >= feed[i].at).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

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

    // A CI runner: an ordinary agent with an ordinary key and its own signing
    // identity, because a check result has to be attributable to the machine
    // that produced it.
    const agentId = await ctx.db.insert("agents", {
      name: "CI",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(RUNNER_KEY),
      keyPrefix: RUNNER_KEY.slice(0, 12),
      createdAt: Date.now(),
    });
    await ctx.db.insert("buzzKeys", {
      principalType: "agent",
      principalId: agentId,
      pubkey: publicKeyFromSecret(RUNNER_SECRET),
      secretKey: RUNNER_SECRET,
      createdAt: Date.now(),
    });

    return { workspaceId, otherWorkspaceId, agentId };
  });

  return {
    t,
    scope: { scopeType: "workspace", scopeId: ids.workspaceId } as Scope,
    otherScope: { scopeType: "workspace", scopeId: ids.otherWorkspaceId } as Scope,
    agentId: ids.agentId,
  };
}

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function announce(t: Harness, scope: Scope, name = "Payments API", as = ALICE) {
  return (await t
    .withIdentity(as)
    .mutation(projects.announce, { ...scope, name })) as {
    projectId: string;
    eventId: string;
  };
}

async function room(
  t: Harness,
  scope: Scope,
  name: string,
  args: Record<string, unknown> = {},
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, name, ...args })) as { channelId: string };
  return result.channelId;
}

async function bind(
  t: Harness,
  scope: Scope,
  channelId: string,
  address: string,
  branch = "feature/x",
  as = ALICE,
) {
  return await t.withIdentity(as).mutation(projects.bindBranch, {
    ...scope,
    channelId,
    repoAddress: address,
    branch,
    targetBranch: "main",
  });
}

async function addMember(
  t: Harness,
  scope: Scope,
  channelId: string,
  actorId: string,
  actorType: "user" | "agent" = "user",
) {
  await t.withIdentity(ALICE).mutation(channels.addMembers, {
    ...scope,
    channelId,
    members: [{ actorId, actorType }],
  });
}

describe("the tenancy fence", () => {
  it("refuses somebody outside the community outright", async () => {
    const { t, scope } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).query(projects.list, { ...scope }),
    ).rejects.toThrow();
  });

  it("does not show a project announced in another community", async () => {
    const { t, scope, otherScope } = await seed();
    const { projectId } = await announce(t, otherScope, "Secret");
    const page = (await t.withIdentity(ALICE).query(projects.list, { ...scope })) as {
      projects: { project: { name: string } }[];
    };
    expect(page.projects).toHaveLength(0);
    expect(
      await t.withIdentity(ALICE).query(projects.get, { ...scope, projectId }),
    ).toBeNull();
  });
});

describe("announcing", () => {
  it("announces, lists, replaces and retires", async () => {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    expect(projectId).toBe(`${pubkeyOf(ALICE)}:payments-api`);

    const page = (await t.withIdentity(BOB).query(projects.list, { ...scope })) as {
      projects: { project: { id: string; name: string }; branchRooms: number }[];
    };
    expect(page.projects).toHaveLength(1);
    expect(page.projects[0].project.name).toBe("Payments API");

    // Addressable: the same slug replaces rather than duplicating.
    await announce(t, scope, "payments-api");
    const again = (await t.withIdentity(BOB).query(projects.list, { ...scope })) as {
      projects: unknown[];
    };
    expect(again.projects).toHaveLength(1);

    // Only the announcer may retire it — otherwise anybody could hide somebody
    // else's project.
    await expect(
      t.withIdentity(BOB).mutation(projects.retire, { ...scope, projectId }),
    ).rejects.toThrow(/announced/i);
    await t.withIdentity(ALICE).mutation(projects.retire, { ...scope, projectId });
    const after = (await t.withIdentity(BOB).query(projects.list, { ...scope })) as {
      projects: unknown[];
    };
    expect(after.projects).toHaveLength(0);
  });

  it("groups repositories without giving the grouping's author any authority", async () => {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const address = `30617:${projectId}`;
    await t.withIdentity(BOB).mutation(projects.group, {
      ...scope,
      name: "Platform",
      memberAddresses: [address],
    });
    const page = (await t.withIdentity(CAROL).query(projects.list, { ...scope })) as {
      groups: { name: string; memberAddresses: string[] }[];
    };
    expect(page.groups[0].name).toBe("Platform");
    expect(page.groups[0].memberAddresses).toEqual([address]);

    // Bob grouped Alice's repository and still cannot retire it.
    await expect(
      t.withIdentity(BOB).mutation(projects.retire, { ...scope, projectId }),
    ).rejects.toThrow();
  });
});

describe("binding a room to a branch", () => {
  it("binds once, refuses an unknown repository, and refuses a rebind", async () => {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const address = `30617:${projectId}`;
    const channelId = await room(t, scope, "retry-budget");

    await expect(
      bind(t, scope, channelId, `30617:${"9".repeat(64)}:ghost`),
    ).rejects.toThrow(/No such project/);

    await bind(t, scope, channelId, address);
    // A room whose branch could change later is a room whose record can be
    // pointed at different code after the fact.
    await expect(bind(t, scope, channelId, address, "feature/other")).rejects.toThrow(
      /already the room for/,
    );

    const detail = (await t
      .withIdentity(ALICE)
      .query(projects.get, { ...scope, projectId })) as {
      rooms: { channelId: string; events: Event[] }[];
    };
    expect(detail.rooms.map((r) => r.channelId)).toEqual([channelId]);
  });

  it("refuses a branch name git would not accept", async () => {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const channelId = await room(t, scope, "bad-branch");
    await expect(
      bind(t, scope, channelId, `30617:${projectId}`, "not a branch"),
    ).rejects.toThrow(/branch name/);
  });

  it("refuses somebody who is not in the room", async () => {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const channelId = await room(t, scope, "private-work", { visibility: "private" });
    await expect(bind(t, scope, channelId, `30617:${projectId}`, "x", BOB)).rejects.toThrow();
  });
});

describe("the room is the record", () => {
  async function branchRoom() {
    const { t, scope, otherScope } = await seed();
    const { projectId } = await announce(t, scope);
    const address = `30617:${projectId}`;
    const channelId = await room(t, scope, "retry-budget");
    await bind(t, scope, channelId, address);
    await addMember(t, scope, channelId, BOB.subject);
    return { t, scope, otherScope, projectId, address, channelId };
  }

  it("posts a patch, moves the tip with a 1619, and folds the room", async () => {
    const { t, scope, channelId } = await branchRoom();
    await t.withIdentity(ALICE).mutation(projects.postPatch, {
      ...scope,
      channelId,
      title: "Bound the retries",
      body: "--- a/x\n+++ b/x\n+retry\n",
      commit: OID_B,
    });

    const forge = (await t
      .withIdentity(ALICE)
      .query(projects.roomForge, { ...scope, channelId })) as {
      events: Event[];
      project: { name: string } | null;
    };
    const kinds = forge.events.map((e) => e.kind).sort();
    expect(kinds).toContain(KIND_GIT_PATCH);
    // A patch naming a commit the room has not seen moves the tip, and that is
    // an event rather than an inference.
    expect(kinds).toContain(KIND_GIT_PR_UPDATE);
    expect(forge.project?.name).toBe("Payments API");

    const folded = buildBranchRoom(channelId, forge.events);
    expect(folded.patches).toHaveLength(1);
    expect(folded.tip).toBe(OID_B);
  });

  it("keeps forge events out of the chat transcript and messages out of the panel", async () => {
    const { t, scope, channelId } = await branchRoom();
    await t.withIdentity(ALICE).mutation(messages.post, {
      ...scope,
      channelId,
      body: "does this need a migration?",
    });
    await t.withIdentity(ALICE).mutation(projects.postPatch, {
      ...scope,
      channelId,
      title: "Bound the retries",
      body: "diff --git a/x b/x\n",
      commit: OID_B,
    });

    // The transcript. Not filtered here — the projector's content set simply
    // does not list a patch, so there is nothing to forget.
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as { events: TimelineEvent[] };
    expect(page.events.some((e) => e.kind === KIND_GIT_PATCH)).toBe(true);
    const rows = projectTimeline(page.events, { selfPubkey: pubkeyOf(ALICE) });
    const drawn = rows.filter((row) => row.type === "message");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].type === "message" && drawn[0].message.body).toContain("migration");

    // The panel. Same room, the other set.
    const forge = (await t
      .withIdentity(ALICE)
      .query(projects.roomForge, { ...scope, channelId })) as { events: Event[] };
    expect(forge.events.every((e) => ROOM_FORGE_KINDS.has(e.kind))).toBe(true);
    expect(forge.events.some((e) => e.kind === 9)).toBe(false);
  });

  it("makes a patch channel-scoped, so a community-wide read cannot reach it", async () => {
    const { t, scope, channelId } = await branchRoom();
    await t.withIdentity(ALICE).mutation(projects.postPatch, {
      ...scope,
      channelId,
      title: "Bound the retries",
      body: "diff",
      commit: OID_B,
    });
    // The whole point of the `optional` scope in `_kinds.ts`: a global read sees
    // only events with no channel, so a patch is not community-wide.
    const global = (await t
      .withIdentity(CAROL)
      .query(log.read, { ...scope, filters: [{ kinds: [KIND_GIT_PATCH] }] })) as Event[];
    expect(global).toHaveLength(0);
  });

  it("hides a private branch room's record from a community member who is not in it", async () => {
    const { t, scope, projectId } = await branchRoom();
    const secret = await room(t, scope, "acquisition-spike", { visibility: "private" });
    await bind(t, scope, secret, `30617:${projectId}`, "feature/secret");
    await t.withIdentity(ALICE).mutation(projects.postPatch, {
      ...scope,
      channelId: secret,
      title: "Spike",
      body: "diff",
    });

    // Not "forbidden": whether a branch called `feature/secret` exists is itself
    // the information.
    await expect(
      t.withIdentity(CAROL).query(projects.roomForge, { ...scope, channelId: secret }),
    ).rejects.toThrow(/not found/i);

    // And it does not leak through the project's branch count either.
    const detail = (await t
      .withIdentity(CAROL)
      .query(projects.get, { ...scope, projectId })) as { rooms: { channelId: string }[] };
    expect(detail.rooms.map((r) => r.channelId)).not.toContain(secret);
  });
});

describe("verdicts", () => {
  async function branchRoom() {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const channelId = await room(t, scope, "retry-budget");
    await bind(t, scope, channelId, `30617:${projectId}`);
    await addMember(t, scope, channelId, BOB.subject);
    await addMember(t, scope, channelId, CAROL.subject);
    return { t, scope, projectId, channelId };
  }

  it("refuses a self-review and records somebody else's", async () => {
    const { t, scope, channelId } = await branchRoom();
    // Alice opened the branch. An approval count its author can raise alone is
    // not a signal.
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(projects.postReview, { ...scope, channelId, outcome: "approved" }),
    ).rejects.toThrow(/your own branch/);

    await t
      .withIdentity(BOB)
      .mutation(projects.postReview, { ...scope, channelId, outcome: "approved" });
    const forge = (await t
      .withIdentity(ALICE)
      .query(projects.roomForge, { ...scope, channelId })) as { events: Event[] };
    const folded = buildBranchRoom(channelId, forge.events);
    expect(folded.reviews).toEqual([
      expect.objectContaining({ by: pubkeyOf(BOB), outcome: "approved", current: true }),
    ]);
  });

  it("lets only a machine assert a check result", async () => {
    const { t, scope, channelId } = await branchRoom();
    // There is no human door for a check at all — a person typing "checks
    // passed" produces a row that renders identically to one a build produced,
    // and the room's whole value is that its record is the record.
    const agentId = (await t.run(async (ctx: Ctx) => {
      const agent = await ctx.db.query("agents").first();
      return agent?._id ?? "";
    })) as string;
    await addMember(t, scope, channelId, agentId, "agent");
    await t.mutation(projects.report, {
      apiKey: RUNNER_KEY,
      channelId,
      report: { type: "check", outcome: "passed" },
    });

    const forge = (await t
      .withIdentity(ALICE)
      .query(projects.roomForge, { ...scope, channelId })) as { events: Event[] };
    const folded = buildBranchRoom(channelId, forge.events);
    expect(folded.check?.outcome).toBe("passed");
    // Signed by the runner's own key, forever, without trusting a column.
    expect(folded.check?.by).toBe(publicKeyFromSecret(RUNNER_SECRET));
  });
});

describe("the merge decision", () => {
  async function branchRoom() {
    const { t, scope } = await seed();
    const { projectId } = await announce(t, scope);
    const channelId = await room(t, scope, "retry-budget");
    await bind(t, scope, channelId, `30617:${projectId}`);
    return { t, scope, projectId, channelId };
  }

  it("cannot be forged by somebody outside the room", async () => {
    const { t, scope, channelId } = await branchRoom();
    await expect(
      t.withIdentity(BOB).mutation(projects.postMerge, { ...scope, channelId }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER).mutation(projects.postMerge, { ...scope, channelId }),
    ).rejects.toThrow();
  });

  it("cannot be recorded by an ordinary member of the room", async () => {
    const { t, scope, channelId } = await branchRoom();
    await addMember(t, scope, channelId, CAROL.subject);
    await expect(
      t.withIdentity(CAROL).mutation(projects.postMerge, { ...scope, channelId }),
    ).rejects.toThrow(/owners and admins|maintainers/);
  });

  it("is attributable to whoever made it", async () => {
    const { t, scope, channelId } = await branchRoom();
    await t
      .withIdentity(ALICE)
      .mutation(projects.postMerge, { ...scope, channelId, mergeCommit: OID_MERGE });

    const forge = (await t
      .withIdentity(ALICE)
      .query(projects.roomForge, { ...scope, channelId })) as { events: Event[] };
    const folded = buildBranchRoom(channelId, forge.events);
    expect(folded.state).toBe("merged");
    expect(folded.merge?.by).toBe(pubkeyOf(ALICE));
    expect(folded.merge?.mergeCommit).toBe(OID_MERGE);

    // The event itself, in the log, in the room, beside the conversation.
    const raw = forge.events.find((e) => e.kind === KIND_GIT_STATUS_MERGED);
    expect(raw?.pubkey).toBe(pubkeyOf(ALICE));
    expect(raw?.tags).toContainEqual(["h", channelId]);
  });
});
