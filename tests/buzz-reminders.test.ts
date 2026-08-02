import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import {
  jitteredExpiration,
  parseNotBefore,
  parseReminderContent,
  parseReminderTarget,
} from "../convex/buzz/reminders";
import {
  countDue,
  formatRelativeTime,
  groupReminders,
  hasNavigableTarget,
  nextDayAt9am,
  nextMondayAt9am,
  parseCustomDateTime,
  TIME_PRESETS,
  type ReminderLike,
} from "../src/components/chat/reminders/model";

// C7b — reminders.
//
// The load-bearing claim is the watermark, and it is stated as two properties
// that pull against each other:
//
//   a cron that fires twice must not notify twice
//   a cron that misses a tick must not lose the reminder
//
// A window-based check `(lastSeen, now]` satisfies the first and fails the
// second. A "have I fired this" boolean re-read on every pass satisfies both
// and is a filter somebody eventually forgets. Ours is neither: `dueAt` is
// present iff the reminder is pending and *this* schedule has not fired, and
// firing clears it — so the idempotency is a property of the index range the
// cron selects on, not of a check inside the loop. Both directions are tested
// below, and so is the third case that catches naive implementations: snooze,
// which has to put a fired reminder *back* into the range.
//
// Everything else here is the shape of the thing: fail-closed parsing (a
// reminder that cannot be rendered must never be stored), replacement ordering
// (a snooze in the same second as the create must still win), and the fence —
// a reminder belongs to one person and nobody else can read, move or settle it.

const modules = import.meta.glob("../convex/**/*.*s");
const reminders = anyApi.buzz.reminders;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
const OUTSIDER = { subject: "user_outsider" };

const USER_KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type T = ReturnType<typeof convexTest>;
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type View = {
  reminderId: string;
  eventId: string;
  status: "pending" | "done" | "cancelled";
  notBefore: number | null;
  dueAtMs: number | null;
  note: string | null;
  target: { channelId: string; preview: string } | null;
  firedAt: number | null;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
    for (const person of [ALICE, BOB, OUTSIDER]) {
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
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    return { workspaceId };
  });
  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  return { t, scope, ...ids };
}

/** Seconds, `n` hours from now — the shape every `create` call wants. */
function inHours(n: number): number {
  return Math.floor((Date.now() + n * HOUR_MS) / 1000);
}

/**
 * Drag a reminder's schedule into the past.
 *
 * `create` refuses a past time on purpose, so the only honest way to make one
 * *arrive* in a test is to move the clock the way real time does — by editing
 * the row, which is exactly what "the schedule is now behind us" means.
 */
async function makeDue(t: T, reminderId: string, agoMs: number) {
  await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("buzzReminders").collect();
    const row = rows.find((r) => r.reminderId === reminderId)!;
    const when = Date.now() - agoMs;
    await ctx.db.patch(row._id, { dueAt: when, notBefore: Math.floor(when / 1000) });
  });
}

async function notifications(t: T, subject = ALICE.subject) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("notifications").collect();
    return rows.filter((r) => r.userClerkId === subject);
  });
}

async function reminderRows(t: T) {
  return await t.run(async (ctx: Ctx) => await ctx.db.query("buzzReminders").collect());
}

async function reminderEvents(t: T) {
  return await t.run(async (ctx: Ctx) => {
    const rows = await ctx.db.query("buzzEvents").collect();
    return rows.filter((r) => r.kind === 30300);
  });
}

async function create(t: T, scope: Scope, args: Record<string, unknown> = {}) {
  return (await t.withIdentity(ALICE).mutation(reminders.create, {
    ...scope,
    notBefore: inHours(2),
    note: "check the deploy",
    ...args,
  })) as View;
}

// ---------------------------------------------------------------------------
// Wire shapes — fail closed
// ---------------------------------------------------------------------------

describe("the wire shape", () => {
  it("mirrors the relay's strict not_before validator", () => {
    expect(parseNotBefore("0")).toBe(0);
    expect(parseNotBefore("1893456000")).toBe(1893456000);
    // Everything a lenient `Number()` would have accepted and the relay would
    // then have thrown away, leaving a reminder the client shows and the server
    // never fires.
    expect(parseNotBefore("")).toBeNull();
    expect(parseNotBefore("01")).toBeNull();
    expect(parseNotBefore("-1")).toBeNull();
    expect(parseNotBefore("1.5")).toBeNull();
    expect(parseNotBefore(" 12 ")).toBeNull();
    expect(parseNotBefore("1e9")).toBeNull();
    expect(parseNotBefore("99999999999999999999")).toBeNull();
  });

  it("refuses any content it cannot fully understand", () => {
    const target = {
      eventId: "e1",
      channelId: "c1",
      preview: "hi",
      authorPubkey: "ab",
    };
    expect(parseReminderContent(JSON.stringify({ status: "pending", note: "x" }))).toEqual({
      status: "pending",
      note: "x",
    });
    expect(
      parseReminderContent(JSON.stringify({ status: "done", target })),
    ).toEqual({ status: "done", target });

    expect(parseReminderContent("not json")).toBeNull();
    expect(parseReminderContent("[]")).toBeNull();
    expect(parseReminderContent("null")).toBeNull();
    expect(parseReminderContent(JSON.stringify({ status: "snoozed", note: "x" }))).toBeNull();
    expect(parseReminderContent(JSON.stringify({ status: "pending", note: 3 }))).toBeNull();
    // A partial target navigates nowhere, so it is not a target.
    expect(
      parseReminderContent(
        JSON.stringify({ status: "pending", target: { eventId: "e1" } }),
      ),
    ).toBeNull();
    // Neither a target nor a note: a notification that would arrive saying
    // nothing, with no way to find out what it was about.
    expect(parseReminderContent(JSON.stringify({ status: "pending" }))).toBeNull();
    expect(
      parseReminderContent(JSON.stringify({ status: "pending", note: "   " })),
    ).toBeNull();
    expect(parseReminderTarget({ ...target, preview: 1 })).toBeNull();
  });

  it("spreads expirations across 30–90 days without a random number", () => {
    const now = 1_800_000_000;
    const thirty = 30 * DAY_MS / 1000;
    const ninety = 90 * DAY_MS / 1000;
    const ids = Array.from({ length: 40 }, (_, i) =>
      `${i}`.padStart(32, "0").slice(0, 32),
    );
    const values = ids.map((id) => jitteredExpiration(id, now));
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(now + thirty);
      expect(value).toBeLessThanOrEqual(now + ninety);
    }
    // Spread, so a thousand reminders settled on one afternoon do not all
    // expire in the same hour...
    expect(new Set(values).size).toBeGreaterThan(30);
    // ...and reproducible, so a mutation retry produces the same event.
    expect(jitteredExpiration(ids[0], now)).toBe(values[0]);
  });
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe("creating", () => {
  it("writes a signed, author-gated 30300 and arms the watermark", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope, {
      target: {
        eventId: "evt_1",
        channelId: "chan_1",
        preview: "ship it?",
        authorPubkey: publicKeyFromSecret(USER_KEYS[BOB.subject]),
      },
    });

    expect(view.status).toBe("pending");
    expect(view.dueAtMs).toBe(view.notBefore! * 1000);

    const events = await reminderEvents(t);
    expect(events).toHaveLength(1);
    const event = events[0];
    // Global, not channel-scoped: a reminder is not a thing that happens in a
    // room, it is a thing that happens to you — so it must never land in a room
    // subscription however loudly its content names one.
    expect(event.channelId).toBeUndefined();
    expect(event.pubkey).toBe(publicKeyFromSecret(USER_KEYS[ALICE.subject]));
    expect(event.tags.find((tag: string[]) => tag[0] === "d")?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(event.tags.find((tag: string[]) => tag[0] === "not_before")?.[1]).toBe(
      String(view.notBefore),
    );
    expect(event.tags.some((tag: string[]) => tag[0] === "expiration")).toBe(false);
    // The coordinate is what makes a snooze a replacement rather than a second
    // reminder.
    expect(event.coord).toBe(`30300:${event.pubkey}:${view.reminderId}`);

    const content = parseReminderContent(event.content);
    expect(content?.status).toBe("pending");
    expect(content?.target?.channelId).toBe("chan_1");

    // Never indexed for search: `searchText` is an allowlist and a reminder's
    // note is the most private string in the product.
    expect(event.searchText).toBeUndefined();
  });

  it("refuses everything it could not later render or fire", async () => {
    const { t, scope } = await seed();

    // A time that has already gone would fire the instant it was created.
    await expect(create(t, scope, { notBefore: inHours(-1) })).rejects.toThrow(
      /future/,
    );
    // Neither a note nor a target.
    await expect(
      create(t, scope, { note: "   ", target: undefined }),
    ).rejects.toThrow(/note or a message/);
    // NIP-ER mandates 128 bits; a shorter or non-hex id is not one.
    await expect(create(t, scope, { reminderId: "nope" })).rejects.toThrow(
      /32 lowercase hex/,
    );

    const first = await create(t, scope, { reminderId: "a".repeat(32) });
    expect(first.reminderId).toBe("a".repeat(32));
    // Loud, not a silent replace: the coordinate is `kind:pubkey:d`, so a
    // collision would quietly overwrite one of this person's own reminders.
    await expect(create(t, scope, { reminderId: "a".repeat(32) })).rejects.toThrow(
      /already exists/,
    );
    expect(await reminderRows(t)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The watermark
// ---------------------------------------------------------------------------

describe("the fire-on-due watermark", () => {
  it("fires once, however many times the cron runs", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope);
    await makeDue(t, view.reminderId, 5 * 60_000);

    const first = (await t.mutation(reminders.fireDue, {})) as { fired: number };
    expect(first.fired).toBe(1);
    expect(await notifications(t)).toHaveLength(1);

    // The row left the index range in the same transaction that delivered it,
    // so the next three passes select nothing. This is the property that would
    // be a comparison somebody could get backwards in any other design.
    for (let i = 0; i < 3; i += 1) {
      const again = (await t.mutation(reminders.fireDue, {})) as { fired: number };
      expect(again.fired).toBe(0);
    }
    expect(await notifications(t)).toHaveLength(1);

    const [row] = await reminderRows(t);
    expect(row.dueAt).toBeUndefined();
    expect(row.firedAt).not.toBeUndefined();
    // Still pending: firing is not settling. The person has to say "done".
    expect(row.status).toBe("pending");
  });

  it("loses nothing when a tick is missed", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope);
    // Three days behind — the deployment was down, or the cron did not run.
    // A window-based watermark `(lastCheck, now]` would step straight over
    // this; the predicate here is `dueAt <= now`, unbounded below.
    await makeDue(t, view.reminderId, 3 * DAY_MS);

    const outcome = (await t.mutation(reminders.fireDue, {})) as { fired: number };
    expect(outcome.fired).toBe(1);
    expect(await notifications(t)).toHaveLength(1);
  });

  it("re-arms on snooze, and fires exactly once more", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope);
    await makeDue(t, view.reminderId, 60_000);
    await t.mutation(reminders.fireDue, {});
    expect(await notifications(t)).toHaveLength(1);

    const snoozed = (await t.withIdentity(ALICE).mutation(reminders.snooze, {
      ...scope,
      reminderId: view.reminderId,
      notBefore: inHours(1),
    })) as View;
    expect(snoozed.status).toBe("pending");
    expect(snoozed.dueAtMs).toBe(snoozed.notBefore! * 1000);
    // Not yet — the new schedule has not arrived.
    expect(((await t.mutation(reminders.fireDue, {})) as { fired: number }).fired).toBe(0);

    await makeDue(t, view.reminderId, 1000);
    expect(((await t.mutation(reminders.fireDue, {})) as { fired: number }).fired).toBe(1);
    expect(await notifications(t)).toHaveLength(2);
    // And once more is still once.
    expect(((await t.mutation(reminders.fireDue, {})) as { fired: number }).fired).toBe(0);
    expect(await notifications(t)).toHaveLength(2);
  });

  it("never fires a reminder that was settled first", async () => {
    const { t, scope } = await seed();
    const done = await create(t, scope, { note: "one" });
    const cancelled = await create(t, scope, { note: "two" });

    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: done.reminderId,
      status: "done",
    });
    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: cancelled.reminderId,
      status: "cancelled",
    });

    // Both watermarks are cleared in the same transaction that settled them,
    // so there is no window in which a completed reminder can still arrive.
    for (const row of await reminderRows(t)) {
      expect(row.dueAt).toBeUndefined();
      expect(row.notBefore).toBeUndefined();
    }
    await makeDue(t, done.reminderId, 0);
    await t.run(async (ctx: Ctx) => {
      // Undo only the schedule, leaving the status settled: the defensive
      // re-check inside the cron has to clear it rather than deliver it.
      const rows = await ctx.db.query("buzzReminders").collect();
      const row = rows.find((r) => r.reminderId === cancelled.reminderId)!;
      await ctx.db.patch(row._id, { dueAt: Date.now() - 1000 });
    });

    const outcome = (await t.mutation(reminders.fireDue, {})) as { fired: number };
    expect(outcome.fired).toBe(0);
    expect(await notifications(t)).toHaveLength(0);
  });

  it("coalesces a person's due reminders into one delivery", async () => {
    const { t, scope } = await seed();
    for (const note of ["a", "b", "c"]) {
      const view = await create(t, scope, { note });
      await makeDue(t, view.reminderId, 60_000);
    }
    // Bob has one too, so the coalescing has to be per person rather than per
    // pass — three people with one reminder each is three deliveries.
    const bob = (await t.withIdentity(BOB).mutation(reminders.create, {
      ...scope,
      notBefore: inHours(1),
      note: "bob's",
    })) as View;
    await makeDue(t, bob.reminderId, 60_000);

    const outcome = (await t.mutation(reminders.fireDue, {})) as {
      fired: number;
      people: number;
    };
    expect(outcome).toEqual({ fired: 4, people: 2 });

    const mine = await notifications(t);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("3 reminders are due");
    // Reuse, not a second delivery path: this is the row the Inbox already
    // reads, in the slot buzz/notifications.ts puts a mention in.
    expect(mine[0].type).toBe("chat.needs_action");

    const bobs = await notifications(t, BOB.subject);
    expect(bobs).toHaveLength(1);
    expect(bobs[0].title).toBe("Reminder");
    expect(bobs[0].body).toBe("bob's");
  });
});

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

describe("replacement", () => {
  it("keeps exactly one live version, even for two writes in one second", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope);
    // No wait between them, so all three share a wall-clock second. Without
    // `created_at = max(now, previous + 1)` these tie, and the log's tie-break
    // is a hash comparison — so the snooze would silently not take about half
    // the time.
    await t.withIdentity(ALICE).mutation(reminders.snooze, {
      ...scope,
      reminderId: view.reminderId,
      notBefore: inHours(3),
    });
    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: view.reminderId,
      status: "done",
    });

    const events = await reminderEvents(t);
    expect(events).toHaveLength(3);
    const live = events.filter((e) => e.supersededAt === undefined);
    expect(live).toHaveLength(1);
    expect(parseReminderContent(live[0].content)?.status).toBe("done");
    // Settled drops `not_before` and gains `expiration`, which is what tells a
    // relay the schedule is over rather than merely in the past.
    expect(live[0].tags.some((tag: string[]) => tag[0] === "not_before")).toBe(false);
    expect(live[0].tags.find((tag: string[]) => tag[0] === "expiration")).toBeTruthy();

    const times = events.map((e) => e.createdAt).sort((a, b) => a - b);
    expect(new Set(times).size).toBe(3);
  });

  it("treats settling twice as the same act", async () => {
    const { t, scope } = await seed();
    const view = await create(t, scope);
    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: view.reminderId,
      status: "done",
    });
    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: view.reminderId,
      status: "done",
    });
    // Two events, not three: the second call is a no-op rather than another
    // version saying the same thing.
    expect(await reminderEvents(t)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

describe("the fence", () => {
  it("keeps a reminder to the person whose reminder it is", async () => {
    const { t, scope } = await seed();
    const mine = await create(t, scope, { note: "private thought" });

    // Bob is in the same community and cannot see it, move it or settle it.
    // The index leads with the owner, so there is no range that returns it.
    const bobsList = (await t
      .withIdentity(BOB)
      .query(reminders.list, { ...scope })) as View[];
    expect(bobsList).toHaveLength(0);
    await expect(
      t.withIdentity(BOB).mutation(reminders.snooze, {
        ...scope,
        reminderId: mine.reminderId,
        notBefore: inHours(5),
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      t.withIdentity(BOB).mutation(reminders.settle, {
        ...scope,
        reminderId: mine.reminderId,
        status: "cancelled",
      }),
    ).rejects.toThrow(/not found/i);

    // And the event itself is invisible: 30300 is author-gated, so a direct
    // read of the log answers nothing rather than answering less.
    const seen = (await t.withIdentity(BOB).query(anyApi.buzz.log.read, {
      ...scope,
      filters: [{ kinds: [30300], authors: [publicKeyFromSecret(USER_KEYS[BOB.subject])] }],
    })) as unknown[];
    expect(seen).toHaveLength(0);
    // Even naming somebody else's key is refused at the filter, before the
    // database is touched.
    await expect(
      t.withIdentity(BOB).query(anyApi.buzz.log.read, {
        ...scope,
        filters: [
          { kinds: [30300], authors: [publicKeyFromSecret(USER_KEYS[ALICE.subject])] },
        ],
      }),
    ).rejects.toThrow(/readable only by their author/);
  });

  it("keeps a community out of another community", async () => {
    const { t, scope } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).mutation(reminders.create, {
        ...scope,
        notBefore: inHours(1),
        note: "not mine",
      }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER).query(reminders.list, { ...scope }),
    ).rejects.toThrow();
  });

  it("counts the due ones, and only the due ones", async () => {
    const { t, scope } = await seed();
    const soon = await create(t, scope, { note: "soon" });
    await create(t, scope, { note: "later", notBefore: inHours(48) });
    expect(await t.withIdentity(ALICE).query(reminders.dueCount, { ...scope })).toBe(0);

    await makeDue(t, soon.reminderId, 1000);
    expect(await t.withIdentity(ALICE).query(reminders.dueCount, { ...scope })).toBe(1);

    // Settling clears it, so the badge cannot show a number nothing clears.
    await t.withIdentity(ALICE).mutation(reminders.settle, {
      ...scope,
      reminderId: soon.reminderId,
      status: "done",
    });
    expect(await t.withIdentity(ALICE).query(reminders.dueCount, { ...scope })).toBe(0);

    const pending = (await t
      .withIdentity(ALICE)
      .query(reminders.list, { ...scope })) as View[];
    expect(pending.map((r) => r.note)).toEqual(["later"]);
    const all = (await t
      .withIdentity(ALICE)
      .query(reminders.list, { ...scope, includeSettled: true })) as View[];
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The pure half: presets, grouping, relative time
// ---------------------------------------------------------------------------

describe("presets", () => {
  it("offers the five shared choices, always in the future", () => {
    const now = new Date("2029-04-04T14:30:00");
    expect(TIME_PRESETS.map((p) => p.label)).toEqual([
      "In 30 minutes",
      "In 1 hour",
      "In 3 hours",
      "Tomorrow at 9am",
      "Next Monday at 9am",
    ]);
    for (const preset of TIME_PRESETS) {
      expect(preset.at(now).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("rolls a 9am preset forward rather than scheduling the past", () => {
    // 2029-04-04 is a Wednesday.
    const morning = new Date("2029-04-04T08:00:00");
    expect(nextDayAt9am(morning, 0).toISOString().slice(0, 10)).toBe("2029-04-04");
    // Same call after 9am must not land in the past.
    const afternoon = new Date("2029-04-04T14:00:00");
    expect(nextDayAt9am(afternoon, 0).getTime()).toBeGreaterThan(afternoon.getTime());
    expect(nextDayAt9am(afternoon, 1).getHours()).toBe(9);

    const monday = nextMondayAt9am(afternoon);
    expect(monday.getDay()).toBe(1);
    expect(monday.getHours()).toBe(9);
    // "Next Monday" standing on a Monday morning is the one coming, not today.
    const onMonday = new Date("2029-04-09T08:00:00");
    expect(onMonday.getDay()).toBe(1);
    expect(nextMondayAt9am(onMonday).getDate()).toBe(16);
  });

  it("refuses a custom time that is not strictly in the future", () => {
    const now = new Date("2029-04-04T14:30:00");
    expect(parseCustomDateTime("2029-04-04", "15:00", now)?.getHours()).toBe(15);
    // The native time input has no `min`; without this guard picking today and
    // a time that has gone fires immediately.
    expect(parseCustomDateTime("2029-04-04", "09:00", now)).toBeNull();
    expect(parseCustomDateTime("2029-04-04", "", now)).toBeNull();
    expect(parseCustomDateTime("", "15:00", now)).toBeNull();
    expect(parseCustomDateTime("not-a-date", "15:00", now)).toBeNull();
  });
});

describe("grouping", () => {
  const now = Date.parse("2029-04-04T14:30:00Z");
  function reminder(over: Partial<ReminderLike>): ReminderLike {
    return {
      reminderId: Math.random().toString(36).slice(2),
      status: "pending",
      dueAtMs: now + HOUR_MS,
      note: "n",
      target: null,
      updatedAt: now,
      ...over,
    };
  }

  it("buckets by overdue, today and upcoming and drops what cannot be placed", () => {
    const rows: ReminderLike[] = [
      reminder({ dueAtMs: now - HOUR_MS, note: "overdue" }),
      reminder({ dueAtMs: now + 60_000, note: "today" }),
      reminder({ dueAtMs: now + 5 * DAY_MS, note: "upcoming" }),
      reminder({ status: "done", dueAtMs: null, note: "done" }),
      // Dropped entirely: cancelling is how you say "never mind".
      reminder({ status: "cancelled", dueAtMs: null, note: "cancelled" }),
      // Skipped: pending with no schedule cannot be placed in a bucket
      // ordered by time.
      reminder({ dueAtMs: null, note: "scheduleless" }),
    ];

    const groups = groupReminders(rows, now);
    expect(groups.map((g) => g.key)).toEqual(["overdue", "today", "upcoming"]);
    expect(groups.flatMap((g) => g.reminders.map((r) => r.note))).toEqual([
      "overdue",
      "today",
      "upcoming",
    ]);

    const withDone = groupReminders(rows, now, true);
    expect(withDone.map((g) => g.key)).toEqual([
      "overdue",
      "today",
      "upcoming",
      "completed",
    ]);
    expect(withDone[3].reminders.map((r) => r.note)).toEqual(["done"]);
    // Cancelled is absent from every bucket in both modes.
    expect(
      withDone.flatMap((g) => g.reminders.map((r) => r.note)),
    ).not.toContain("cancelled");

    expect(countDue(rows, now)).toBe(1);
  });

  it("states overdue plainly", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 20 * 60_000, now)).toBe("20m overdue");
    expect(formatRelativeTime(now - 3 * HOUR_MS, now)).toBe("3h overdue");
    expect(formatRelativeTime(now - 2 * DAY_MS, now)).toBe("2d overdue");
    expect(formatRelativeTime(now + 30_000, now)).toBe("in less than a minute");
    expect(formatRelativeTime(now + 45 * 60_000, now)).toBe("in 45m");
    expect(formatRelativeTime(now + 2 * DAY_MS, now)).toBe("in 2d");
  });

  it("does not offer to navigate to a target that holds empty strings", () => {
    const full = {
      eventId: "e",
      channelId: "c",
      preview: "p",
      authorPubkey: "a",
    };
    expect(hasNavigableTarget(reminder({ target: full }))).toBe(true);
    expect(
      hasNavigableTarget(reminder({ target: { ...full, channelId: "" } })),
    ).toBe(false);
    expect(hasNavigableTarget(reminder({ target: null }))).toBe(false);
  });
});
