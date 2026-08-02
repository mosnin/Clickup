import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  QUEUE_ACTIONS,
  REPORT_TYPES,
  SEVERITY_RANK,
  actionMatchesTarget,
  formatTimeoutRemaining,
  groupReports,
  isTimeoutActive,
  parseTimeoutRejection,
  reportStatusForAction,
  statusForAction,
  targetKey,
  type ModerationAction,
  type ModerationReport,
} from "@/lib/buzz/moderation";

// `anyApi` rather than the generated `api`, for the reason the other Chat
// suites state: `convex/_generated/api.d.ts` is a hand-rolled stub that
// predates `convex/buzz/*` and only `npx convex dev` may rewrite it. The
// references resolve identically at runtime through the glob below.
const modules = import.meta.glob("../convex/**/*.*s");
const moderation = anyApi.buzz.moderation;
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const pulse = anyApi.buzz.pulse;


const ALICE = { subject: "user_alice" }; // workspace owner
const BOB = { subject: "user_bob" }; // workspace admin
const CAROL = { subject: "user_carol" }; // ordinary member
const DAVE = { subject: "user_dave" }; // ordinary member
const OUTSIDER = { subject: "user_outsider" }; // in no workspace at all

// Fixed keys: several assertions below are about *which* pubkey signed or was
// acted on, and a random key makes those pass or fail depending on the day.
const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [DAVE.subject]: "04".repeat(32),
  [OUTSIDER.subject]: "05".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;

type QueueResult = {
  reports: ModerationReport[];
  withheld: number;
};
type AuditResult = { entries: ModerationAction[]; withheld: number };

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  // Removing a message publishes a relay-signed tombstone, so the community
  // relay seed is not optional for this suite. Fixed so the derived pubkey is
  // the same on every run.
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, CAROL, DAVE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: pubkeyOf(person),
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
    // A second community, so "the tenancy fence" is a claim about two real
    // workspaces rather than about a string that resolves to nothing.
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Beta",
      slug: "beta",
      ownerClerkId: DAVE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "admin"],
      [CAROL.subject, "member"],
      [DAVE.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    await ctx.db.insert("memberships", {
      userClerkId: DAVE.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });
    return { workspaceId, otherWorkspaceId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const otherScope: Scope = { scopeType: "workspace", scopeId: ids.otherWorkspaceId };
  return { t, scope, otherScope };
}

async function createChannel(
  t: Harness,
  scope: Scope,
  args: Record<string, unknown>,
  as = ALICE,
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, ...args })) as { channelId: string };
  return result.channelId;
}

async function post(
  t: Harness,
  scope: Scope,
  channelId: string,
  body: string,
  as: { subject: string },
): Promise<string> {
  const result = (await t
    .withIdentity(as)
    .mutation(messages.post, { ...scope, channelId, body })) as { eventId: string };
  return result.eventId;
}

async function fileReport(
  t: Harness,
  scope: Scope,
  as: { subject: string },
  args: Record<string, unknown>,
) {
  return (await t.withIdentity(as).mutation(moderation.report, {
    ...scope,
    ...args,
  })) as { reportId: string; created: boolean };
}

// ---------------------------------------------------------------------------
// Pure: the vocabulary and the triage fold (§6.4)
// ---------------------------------------------------------------------------

function report(over: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: over.id ?? "r1",
    reporterPubkey: "aa",
    reporterName: "A",
    targetKind: "event",
    target: "e1",
    reportType: "spam",
    status: "open",
    createdAt: 1000,
    ...over,
  };
}

describe("moderation vocabulary", () => {
  it("ranks illegal above everything and other below everything", () => {
    const ranked = [...REPORT_TYPES].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a]);
    expect(ranked[0]).toBe("illegal");
    expect(ranked[ranked.length - 1]).toBe("other");
  });

  it("pairs dismiss with dismissed and nothing else", () => {
    expect(statusForAction("dismiss")).toBe("dismissed");
    for (const action of ["delete", "kick", "ban", "timeout", "escalate"] as const) {
      expect(statusForAction(action)).toBe("resolved");
    }
  });

  it("sends escalation to its own lane on the report row", () => {
    expect(reportStatusForAction("escalate")).toBe("escalated");
    expect(reportStatusForAction("dismiss")).toBe("dismissed");
    expect(reportStatusForAction("ban")).toBe("resolved");
  });

  it("offers only the actions the queue actually carries out", () => {
    expect([...QUEUE_ACTIONS].sort()).toEqual(["ban", "delete", "dismiss", "escalate"]);
  });
});

describe("triage grouping", () => {
  it("keys groups by kind so an event id cannot collide with a pubkey", () => {
    const hex = "ab".repeat(32);
    expect(targetKey("event", hex)).not.toBe(targetKey("pubkey", hex));
    const groups = groupReports([
      report({ id: "r1", targetKind: "event", target: hex }),
      report({ id: "r2", targetKind: "pubkey", target: hex }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("orders by severity, then recency, then key — and is stable in both input orders", () => {
    const input: ModerationReport[] = [
      report({ id: "a", target: "e1", reportType: "spam", createdAt: 5000 }),
      report({ id: "b", target: "e2", reportType: "illegal", createdAt: 1000 }),
      report({ id: "c", target: "e3", reportType: "spam", createdAt: 9000 }),
      report({ id: "d", target: "e4", reportType: "spam", createdAt: 9000 }),
    ];
    const forwards = groupReports(input).map((g) => g.key);
    const backwards = groupReports([...input].reverse()).map((g) => g.key);
    expect(forwards).toEqual(backwards);
    // illegal first even though it is the oldest; then the two newest spam
    // groups, tied on time and broken deterministically by key.
    expect(forwards).toEqual(["event:e2", "event:e3", "event:e4", "event:e1"]);
  });

  it("collapses reports about one target and keeps them newest first", () => {
    const groups = groupReports([
      report({ id: "old", target: "e1", createdAt: 1000, reportType: "other" }),
      report({ id: "new", target: "e1", createdAt: 4000, reportType: "malware" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reports.map((r) => r.id)).toEqual(["new", "old"]);
    expect(groups[0].maxSeverity).toBe(SEVERITY_RANK.malware);
    expect(groups[0].latestCreatedAt).toBe(4000);
  });

  it("correlates prior actions by target kind and surfaces none for a blob", () => {
    const action: ModerationAction = {
      id: "a1",
      actorPubkey: "mod",
      actorName: "Mod",
      action: "ban",
      targetPubkey: "bb",
      createdAt: 10,
    };
    const eventAction: ModerationAction = { ...action, id: "a2", targetEventId: "e1" };
    expect(actionMatchesTarget(eventAction, "event", "e1")).toBe(true);
    expect(actionMatchesTarget(action, "pubkey", "bb")).toBe(true);
    // An act against the author is a fact about the person, not about every
    // message they wrote.
    expect(actionMatchesTarget(action, "event", "e1")).toBe(false);
    expect(actionMatchesTarget(eventAction, "blob", "x")).toBe(false);

    const groups = groupReports(
      [report({ targetKind: "blob", target: "blob1" })],
      [action, eventAction],
    );
    expect(groups[0].priorActions).toEqual([]);
  });
});

describe("the timeout parse contract", () => {
  it("reads a rejection produced by the server", () => {
    const parsed = parseTimeoutRejection("restricted: you are timed out until 1700000000");
    expect(parsed?.expiresAtMs).toBe(1_700_000_000_000);
  });

  it("is not fooled by an unrelated refusal", () => {
    expect(parseTimeoutRejection("You are not in this channel")).toBeNull();
    expect(parseTimeoutRejection("restricted: you are banned from this community")).toBeNull();
  });

  it("fails closed on an unreadable timestamp", () => {
    const parsed = parseTimeoutRejection("restricted: you are timed out until soon");
    expect(parsed).not.toBeNull();
    expect(parsed?.expiresAtMs).toBeNull();
    // Still active: a composer that re-enabled itself because it could not read
    // a number would let somebody type a message that is refused again.
    expect(isTimeoutActive(parsed, Date.now())).toBe(true);
  });

  it("renders at most two units and never a negative", () => {
    expect(formatTimeoutRemaining(2 * 3600_000 + 5 * 60_000 + 41_000)).toBe("2h 5m");
    expect(formatTimeoutRemaining(3 * 60_000 + 20_000)).toBe("3m 20s");
    expect(formatTimeoutRemaining(12_000)).toBe("12s");
    expect(formatTimeoutRemaining(-5000)).toBe("0s");
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe("filing a report", () => {
  it("is idempotent for one reporter, one target", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "hello", ALICE);

    const first = await fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });
    const second = await fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: eventId,
      reportType: "illegal",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reportId).toBe(first.reportId);

    const queue = (await t
      .withIdentity(ALICE)
      .query(moderation.queue, { ...scope })) as QueueResult;
    expect(queue.reports).toHaveLength(1);
    // The first category stands: a second click is the same report, not a
    // re-categorisation of it.
    expect(queue.reports[0].reportType).toBe("spam");
  });

  it("refuses a target the reporter cannot reach, indistinguishably from one that does not exist", async () => {
    const { t, scope } = await seed();
    const secret = await createChannel(t, scope, { name: "secret", visibility: "private" });
    const eventId = await post(t, scope, secret, "internal", ALICE);

    const unreachable = fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });
    const nonexistent = fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: "ff".repeat(32),
      reportType: "spam",
    });
    await expect(unreachable).rejects.toThrow(/could not be found/);
    await expect(nonexistent).rejects.toThrow(/could not be found/);
  });

  it("keeps the reporter out of the log entirely", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "hello", ALICE);
    await fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });

    const carolPubkey = pubkeyOf(CAROL);
    const events = await t.run(async (ctx: Ctx) =>
      await ctx.db.query("buzzEvents").collect(),
    );
    // A report publishes nothing at all — not a 1984, and nothing carrying the
    // reporter's key as an author of a moderation act.
    expect(events.some((e) => e.kind === 1984)).toBe(false);
    expect(
      events.some(
        (e) => e.pubkey === carolPubkey && e.tags.some((tag: string[]) => tag[0] === "e" && tag[1] === eventId),
      ),
    ).toBe(false);
  });

  it("fences a report to its own community", async () => {
    const { t, scope, otherScope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    const eventId = await post(t, scope, channelId, "hello", ALICE);
    // Dave governs the *other* workspace and is an ordinary member here.
    await expect(
      fileReport(t, otherScope, DAVE, {
        targetKind: "event",
        target: eventId,
        reportType: "spam",
      }),
    ).rejects.toThrow(/could not be found/);
    await expect(
      t.withIdentity(OUTSIDER).query(moderation.queue, { ...scope }),
    ).rejects.toThrow(/Forbidden/);
  });
});

// ---------------------------------------------------------------------------
// The visibility invariant — the reason this file exists
// ---------------------------------------------------------------------------

describe("what a moderator can see", () => {
  it("withholds a report about a private room the moderator is not in, and says how many", async () => {
    const { t, scope } = await seed();
    // Carol owns a private room. Bob is a *community admin* and is not in it.
    const secret = await createChannel(t, scope, { name: "secret", visibility: "private" }, CAROL);
    await t
      .withIdentity(CAROL)
      .mutation(channels.addMembers, {
        ...scope,
        channelId: secret,
        members: [{ actorId: DAVE.subject, actorType: "user" }],
      });
    const secretMessage = await post(t, scope, secret, "the acquisition price is 40", CAROL);
    await fileReport(t, scope, DAVE, {
      targetKind: "event",
      target: secretMessage,
      reportType: "illegal",
    });

    const open = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId: open });
    const openMessage = await post(t, scope, open, "buy my coin", CAROL);
    await fileReport(t, scope, DAVE, {
      targetKind: "event",
      target: openMessage,
      reportType: "spam",
    });

    const asBob = (await t
      .withIdentity(BOB)
      .query(moderation.queue, { ...scope })) as QueueResult;
    // One report, and a count for the other. Never the room's id, never the
    // author, never the text.
    expect(asBob.reports).toHaveLength(1);
    expect(asBob.reports[0].target).toBe(openMessage);
    expect(asBob.withheld).toBe(1);
    const serialized = JSON.stringify(asBob);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("acquisition");

    // Alice owns the workspace and is not in the private room either — the
    // gate is about reachability, not about rank. There is no moderator
    // override branch, which is exactly the point.
    const asAlice = (await t
      .withIdentity(ALICE)
      .query(moderation.queue, { ...scope })) as QueueResult;
    expect(asAlice.withheld).toBe(1);
    expect(JSON.stringify(asAlice)).not.toContain("acquisition");

    // Carol wrote the message and is in the room — and still gets nothing,
    // because she is not a moderator. Reachability is necessary, not sufficient.
    await expect(t.withIdentity(CAROL).query(moderation.queue, { ...scope })).rejects.toThrow(
      /owners and admins can moderate/,
    );
  }, 20000);

  it("refuses the queue, the audit and the restrictions to an ordinary member", async () => {
    const { t, scope } = await seed();
    for (const fn of [moderation.queue, moderation.audit, moderation.restrictions]) {
      await expect(t.withIdentity(CAROL).query(fn, { ...scope })).rejects.toThrow(
        /owners and admins can moderate/,
      );
    }
  });

  it("withholds an audit row whose event the moderator cannot reach", async () => {
    const { t, scope } = await seed();
    const secret = await createChannel(t, scope, { name: "secret", visibility: "private" }, ALICE);
    const hidden = await post(t, scope, secret, "hidden", ALICE);
    await t.withIdentity(DAVE).mutation(channels.join, { ...scope, channelId: secret }).catch(() => {});

    // Alice (workspace owner, and in the room) removes it through the queue.
    await t
      .withIdentity(ALICE)
      .mutation(channels.addMembers, {
        ...scope,
        channelId: secret,
        members: [{ actorId: CAROL.subject, actorType: "user" }],
      });
    const secondMessage = await post(t, scope, secret, "also hidden", CAROL);
    const filed = await fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: hidden,
      reportType: "spam",
    });
    await t.withIdentity(ALICE).mutation(moderation.resolveReport, {
      ...scope,
      reportId: filed.reportId,
      action: "delete",
      reason: "off topic",
    });

    const asAlice = (await t
      .withIdentity(ALICE)
      .query(moderation.audit, { ...scope })) as AuditResult;
    expect(asAlice.entries.length).toBeGreaterThan(0);
    expect(asAlice.withheld).toBe(0);

    // Bob governs the community and is not in the room: the trail exists, and
    // he is told how much of it he may not read.
    const asBob = (await t
      .withIdentity(BOB)
      .query(moderation.audit, { ...scope })) as AuditResult;
    expect(asBob.entries.every((entry) => entry.targetEventId === undefined)).toBe(true);
    expect(asBob.withheld).toBeGreaterThan(0);
    expect(JSON.stringify(asBob)).not.toContain(secondMessage);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Acting, and the record it leaves
// ---------------------------------------------------------------------------

describe("moderation acts", () => {
  it("writes an audit row for every act", async () => {
    const { t, scope } = await seed();
    const until = Math.floor(Date.now() / 1000) + 3600;
    await t.withIdentity(ALICE).mutation(moderation.ban, {
      ...scope,
      pubkey: pubkeyOf(CAROL),
      reason: "spam",
    });
    await t
      .withIdentity(ALICE)
      .mutation(moderation.unban, { ...scope, pubkey: pubkeyOf(CAROL) });
    await t
      .withIdentity(ALICE)
      .mutation(moderation.timeout, { ...scope, pubkey: pubkeyOf(CAROL), expiresAt: until });
    await t
      .withIdentity(ALICE)
      .mutation(moderation.untimeout, { ...scope, pubkey: pubkeyOf(CAROL) });

    const trail = (await t
      .withIdentity(ALICE)
      .query(moderation.audit, { ...scope })) as AuditResult;
    expect(trail.entries.map((e) => e.action).sort()).toEqual([
      "ban",
      "timeout",
      "unban",
      "untimeout",
    ]);
    // Who / whom / when, on every row.
    for (const entry of trail.entries) {
      expect(entry.actorPubkey).toBe(pubkeyOf(ALICE));
      expect(entry.targetPubkey).toBe(pubkeyOf(CAROL));
      expect(entry.createdAt).toBeGreaterThan(0);
    }
  });

  it("keeps the restriction row after a lift, so the history survives", async () => {
    const { t, scope } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(moderation.ban, { ...scope, pubkey: pubkeyOf(CAROL) });
    await t
      .withIdentity(ALICE)
      .mutation(moderation.unban, { ...scope, pubkey: pubkeyOf(CAROL) });
    const rows = await t.run(
      async (ctx: Ctx) => await ctx.db.query("buzzCommunityRestrictions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].banned).toBe(false);
    // …and nothing live is reported.
    const live = await t.withIdentity(ALICE).query(moderation.restrictions, { ...scope });
    expect(live).toEqual([]);
  });

  it("enforces the guard rails", async () => {
    const { t, scope } = await seed();
    // Bob is an admin. He may not touch the owner…
    await expect(
      t.withIdentity(BOB).mutation(moderation.ban, { ...scope, pubkey: pubkeyOf(ALICE) }),
    ).rejects.toThrow(/owner cannot be restricted/);
    // …nor himself…
    await expect(
      t.withIdentity(BOB).mutation(moderation.ban, { ...scope, pubkey: pubkeyOf(BOB) }),
    ).rejects.toThrow(/cannot moderate yourself/);
    // …and an ordinary member may not moderate at all.
    await expect(
      t.withIdentity(CAROL).mutation(moderation.ban, { ...scope, pubkey: pubkeyOf(DAVE) }),
    ).rejects.toThrow(/owners and admins can moderate/);
  });

  it("refuses a timeout that does not end", async () => {
    const { t, scope } = await seed();
    await expect(
      t.withIdentity(ALICE).mutation(moderation.timeout, {
        ...scope,
        pubkey: pubkeyOf(CAROL),
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      }),
    ).rejects.toThrow(/end in the future/);
  });
});

describe("resolving a report", () => {
  it("acts first and records the decision second", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(DAVE).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "buy my coin", CAROL);
    const filed = await fileReport(t, scope, DAVE, {
      targetKind: "event",
      target: eventId,
      reportType: "malware",
    });

    const result = (await t.withIdentity(ALICE).mutation(moderation.resolveReport, {
      ...scope,
      reportId: filed.reportId,
      action: "ban",
      reason: "scam link",
      privateReason: "third strike",
    })) as { status: string };
    expect(result.status).toBe("resolved");

    const trail = (await t
      .withIdentity(ALICE)
      .query(moderation.audit, { ...scope })) as AuditResult;
    // Newest first, so the decision is above the enforcement it records.
    expect(trail.entries.map((e) => e.action)).toEqual(["resolve:ban", "ban"]);
    expect(trail.entries[0].privateReason).toBe("third strike");
    expect(trail.entries[1].targetPubkey).toBe(pubkeyOf(CAROL));

    const queue = (await t
      .withIdentity(ALICE)
      .query(moderation.queue, { ...scope })) as QueueResult;
    expect(queue.reports[0].status).toBe("resolved");
  }, 20000);

  it("leaves the report open and writes nothing when enforcement is refused", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    // A report against the workspace owner's message: the ban is refused by the
    // guard rails, so nothing may be recorded.
    const eventId = await post(t, scope, channelId, "mine", ALICE);
    const filed = await fileReport(t, scope, CAROL, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });
    await expect(
      t.withIdentity(BOB).mutation(moderation.resolveReport, {
        ...scope,
        reportId: filed.reportId,
        action: "ban",
      }),
    ).rejects.toThrow(/owner cannot be restricted/);

    const queue = (await t
      .withIdentity(ALICE)
      .query(moderation.queue, { ...scope })) as QueueResult;
    expect(queue.reports[0].status).toBe("open");
    const trail = (await t
      .withIdentity(ALICE)
      .query(moderation.audit, { ...scope })) as AuditResult;
    expect(trail.entries).toEqual([]);
  }, 20000);

  it("removes a message with the record, the effect and the tombstone", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    await t.withIdentity(DAVE).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "something awful", CAROL);
    const filed = await fileReport(t, scope, DAVE, {
      targetKind: "event",
      target: eventId,
      reportType: "profanity",
    });

    await t.withIdentity(ALICE).mutation(moderation.resolveReport, {
      ...scope,
      reportId: filed.reportId,
      action: "delete",
      reason: "against the rules",
    });

    const events = await t.run(async (ctx: Ctx) => await ctx.db.query("buzzEvents").collect());
    const removed = events.find((e) => e.eventId === eventId);
    expect(removed?.deletedAt).toBeDefined();
    // The 9005 is the record; the 40099 is what the room reads in its place.
    expect(events.some((e) => e.kind === 9005 && e.tags.some((t2: string[]) => t2[1] === eventId))).toBe(
      true,
    );
    const tombstone = events.find(
      (e) => e.kind === 40099 && e.content.includes("message_moderated"),
    );
    expect(tombstone).toBeDefined();
    // Sanitized: the reason travels, the removed text never does.
    expect(tombstone?.content).toContain("against the rules");
    expect(tombstone?.content).not.toContain("something awful");

    const queue = (await t
      .withIdentity(ALICE)
      .query(moderation.queue, { ...scope })) as QueueResult;
    expect(queue.reports[0].removed).toBe(true);
    expect(queue.reports[0].preview).toBeUndefined();
  }, 20000);

  it("refuses kick and timeout from the queue, each with its own reason", async () => {
    const { t, scope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "hello", CAROL);
    const filed = await fileReport(t, scope, ALICE, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });
    await expect(
      t.withIdentity(ALICE).mutation(moderation.resolveReport, {
        ...scope,
        reportId: filed.reportId,
        action: "timeout",
      }),
    ).rejects.toThrow(/duration is chosen/);
    await expect(
      t.withIdentity(ALICE).mutation(moderation.resolveReport, {
        ...scope,
        reportId: filed.reportId,
        action: "kick",
      }),
    ).rejects.toThrow(/done in that room/);
  });

  it("refuses a report id from another community", async () => {
    const { t, scope, otherScope } = await seed();
    const channelId = await createChannel(t, scope, { name: "general" });
    await t.withIdentity(CAROL).mutation(channels.join, { ...scope, channelId });
    const eventId = await post(t, scope, channelId, "hello", CAROL);
    const filed = await fileReport(t, scope, ALICE, {
      targetKind: "event",
      target: eventId,
      reportType: "spam",
    });
    // Dave owns the other workspace, so he is a moderator *there* — and the
    // fence is re-applied to the row that was actually loaded.
    await expect(
      t.withIdentity(DAVE).mutation(moderation.resolveReport, {
        ...otherScope,
        reportId: filed.reportId,
        action: "dismiss",
      }),
    ).rejects.toThrow(/Report not found/);
  });
});

// ---------------------------------------------------------------------------
// Enforcement, at the seam
// ---------------------------------------------------------------------------

describe("the enforcement seam", () => {
  // Driven through `pulse.post`, which is a write path that already calls the
  // seam. The room composer's call site is one line in
  // `messages.postMessageCore` and lands with the schema fold — see
  // `requireNotRestricted`.
  async function note(t: Harness, scope: Scope, body: string, as: { subject: string }) {
    return await t.withIdentity(as).mutation(pulse.post, { ...scope, body });
  }

  it("blocks a timed-out member's writes with the sentence the composer parses", async () => {
    const { t, scope } = await seed();
    const until = Math.floor(Date.now() / 1000) + 3600;
    await t
      .withIdentity(ALICE)
      .mutation(moderation.timeout, { ...scope, pubkey: pubkeyOf(CAROL), expiresAt: until });

    let message = "";
    try {
      await note(t, scope, "still here", CAROL);
    } catch (error) {
      message = String((error as { data?: string })?.data ?? (error as Error).message);
    }
    const parsed = parseTimeoutRejection(message);
    expect(parsed).not.toBeNull();
    expect(parsed?.expiresAtMs).toBe(until * 1000);
    expect(isTimeoutActive(parsed, Date.now())).toBe(true);

    // Lifting it restores the write.
    await t
      .withIdentity(ALICE)
      .mutation(moderation.untimeout, { ...scope, pubkey: pubkeyOf(CAROL) });
    await expect(note(t, scope, "back", CAROL)).resolves.toBeTruthy();
  }, 20000);

  it("stops a banned member and lets an expired ban lapse without a sweep", async () => {
    const { t, scope } = await seed();
    await t.withIdentity(ALICE).mutation(moderation.ban, { ...scope, pubkey: pubkeyOf(CAROL) });
    await expect(note(t, scope, "hello", CAROL)).rejects.toThrow(/banned/);

    // A ban that has run out stops biting immediately, with no cron involved.
    await t.run(async (ctx: Ctx) => {
      const row = await ctx.db.query("buzzCommunityRestrictions").first();
      if (row) {
        await ctx.db.patch(row._id, { banExpiresAt: Math.floor(Date.now() / 1000) - 1 });
      }
    });
    await expect(note(t, scope, "hello again", CAROL)).resolves.toBeTruthy();
  }, 20000);

  it("never locks a community out of itself", async () => {
    const { t, scope } = await seed();
    // A row written directly, as a corrupted or legacy state would be: the
    // owner can still write, because the seam refuses to restrict them.
    await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("buzzCommunityRestrictions", {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        pubkey: pubkeyOf(ALICE),
        banned: true,
        actorPubkey: pubkeyOf(BOB),
        updatedAt: Date.now(),
      });
    });
    await expect(note(t, scope, "still the owner", ALICE)).resolves.toBeTruthy();
  });
});
