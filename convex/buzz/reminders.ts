// Reminders — "bring this back to me at nine tomorrow".
//
// 03-workflows-projects.md §4 (NIP-ER). A reminder is a signed, replaceable
// event that belongs to exactly one person: a schedule, an optional note, and
// an optional pointer at the message that provoked it. Everything about the
// design follows from "it belongs to exactly one person", including which kind
// number it is written under.
//
// ## Kind 30300, not 40007 — and this is a security choice, not a preference
//
// §4 names the wire kind as `40007` (`KIND_EVENT_REMINDER` /
// `KIND_STREAM_REMINDER`) and then states two properties of it:
// **parameterized-replaceable by `d`**, and **content encrypted to self**.
// Neither of those is true of 40007 on our substrate, and both are true of
// 30300, which our registry already carries as `KIND_EVENT_REMINDER`:
//
//   - Storage class is a function of the *number* (`_kinds.ts` §16.4). 40007
//     sits outside 30000–39999, so it is a **regular** kind: republishing on
//     snooze would append rather than replace, and the "the newest replacement
//     wins" mechanism the spec relies on would simply not exist.
//   - 40007 is registered `scope: "required"`, `gate: "open"` — a *channel*
//     event any member of the room can read. A reminder's note is the most
//     private string in this product, and the encryption Buzz uses is what
//     stops the relay operator and everyone else from reading it. We have no
//     cipher (`_kinds.ts` says so at length under 30078), and the substitute
//     this codebase already chose for exactly that situation is the **author
//     gate** — which 30300 has and 40007 does not.
//
// So the reminder is written as 30300: addressable by `d`, global, author-only.
// Choosing 40007 would have meant editing the kind registry to change a read
// gate, which is the one table where a mistake is silent and permanent.
//
// The consequence of `scope: "global"` is that the reminder carries no `h` tag,
// so **which room it points at travels in the content**, alongside the note —
// which is where Buzz's decrypted `ReminderTarget` puts it anyway. A reminder
// is not a thing that happens in a room; it is a thing that happens to you.
//
// ## The watermark is idempotent by construction
//
// The hard requirement: a cron that runs twice must not notify twice, and a
// cron that misses a tick must not lose the reminder. Those two pull in
// opposite directions, and the shape that satisfies both is *not* a global
// "last checked at" timestamp — Buzz's client-side `buzz:lastReminderCheck`
// watermark has to be seeded to `now` on first launch precisely because a
// window-based check `(watermark, now]` loses everything outside the window and
// replays everything inside it.
//
// Ours is per-reminder and it is the **index key**:
//
//   `dueAt` is present **iff** the reminder is pending and its current schedule
//   has not yet fired. Firing clears it.
//
// So the cron is `by_due` ranged over `(0, now]`, and:
//
//   - **Fires twice ⇒ notifies once.** The first pass clears `dueAt`, so the
//     row is no longer in the index range. There is no "have I seen this"
//     comparison to get wrong, because a fired reminder is not a row the query
//     returns.
//   - **Misses a tick ⇒ nothing is lost.** The predicate is `dueAt <= now`,
//     unbounded below. A reminder that came due during an outage is picked up
//     by the next pass, however much later that is, because nothing about the
//     row depends on when it was last looked at.
//   - **Snooze re-arms it.** Setting a new `not_before` writes a new `dueAt`,
//     which puts the row back in the range for the new time — the watermark
//     moves *with* the schedule rather than being a separate fact that can
//     disagree with it.
//
// This is the same trick `calibration` uses to make grading idempotent (clear
// the due field, the row leaves the range), and it is used here for the same
// reason: a boolean "fired" column re-read on every pass is a filter, and a
// filter is a thing somebody eventually forgets to apply.
//
// ## The projection table, and why there is one
//
// The log is the record; `buzzReminders` is an index. Every read gate, every
// signature, every past version lives in `buzzEvents` — but `not_before` is not
// a filterable tag, and every index on the log leads with the scope, so no
// query over it can answer "every reminder in the whole deployment that is due
// now". A cron has no scope and no identity, so it needs an index that leads
// with time. The projection is written inside the same transaction as the
// event, so the two cannot diverge.

import { ConvexError, v } from "convex/values";
import { defineTable } from "convex/server";
import { internalMutation, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireScopeAccess } from "../_authz";
import type { Actor } from "../_agentAuth";
import { sha256Hex } from "../_agentAuth";
import { notify as notifyInApp } from "../notificationCenter";
import { pubkeyFor } from "./identity";
import { publishCore, type Scope } from "./log";

/** `KIND_EVENT_REMINDER`. Addressable by `d`, global, author-only. */
const KIND_EVENT_REMINDER = 30300;

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

const DAY_SECONDS = 24 * 60 * 60;

/**
 * How many due reminders one cron pass delivers.
 *
 * A cap rather than `.collect()`, because the one situation this has to survive
 * is the one it was built for: a deployment that was down for a day comes back
 * with every reminder in the estate due at once. A capped pass delivers a
 * batch, clears their watermarks, and the next tick takes the rest — which is
 * exactly the behaviour "a missed tick loses nothing" promises, applied to a
 * missed day.
 */
export const FIRE_BATCH = 200;

/** A note is a sentence, not a document. */
export const REMINDER_NOTE_MAX = 500;
/** Long enough to recognise the message, short enough to store per reminder. */
export const REMINDER_PREVIEW_MAX = 200;

// ---------------------------------------------------------------------------
// The content shape (`lib/reminderTypes.ts`), and its fail-closed parser
// ---------------------------------------------------------------------------

export type ReminderStatus = "pending" | "done" | "cancelled";

export type ReminderTarget = {
  eventId: string;
  channelId: string;
  preview: string;
  authorPubkey: string;
};

export type ReminderContent = {
  target?: ReminderTarget;
  note?: string;
  status: ReminderStatus;
};

const STATUSES: ReadonlySet<string> = new Set(["pending", "done", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A target, or null. **Every field is required and must be a string** — a
 * partially-formed target is worse than none, because
 * `hasNavigableTarget` would offer a row that navigates nowhere.
 */
export function parseReminderTarget(value: unknown): ReminderTarget | null {
  if (!isRecord(value)) return null;
  const { eventId, channelId, preview, authorPubkey } = value;
  if (
    typeof eventId !== "string" ||
    typeof channelId !== "string" ||
    typeof preview !== "string" ||
    typeof authorPubkey !== "string"
  ) {
    return null;
  }
  return { eventId, channelId, preview, authorPubkey };
}

/**
 * Parse a reminder's content, failing closed on every ambiguity.
 *
 * §4.1's rules, verbatim: not a JSON object ⇒ null; unknown status ⇒ null;
 * non-string note ⇒ null; malformed target ⇒ null; and **a reminder must have
 * either a target or a non-empty note**, because a reminder that says nothing
 * and points at nothing is a notification with no content — it would arrive,
 * and the person receiving it would have no way to find out what it was about.
 */
export function parseReminderContent(raw: string): ReminderContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.status !== "string" || !STATUSES.has(parsed.status)) return null;

  let note: string | undefined;
  if (parsed.note !== undefined) {
    if (typeof parsed.note !== "string") return null;
    note = parsed.note;
  }

  let target: ReminderTarget | undefined;
  if (parsed.target !== undefined) {
    const resolved = parseReminderTarget(parsed.target);
    if (!resolved) return null;
    target = resolved;
  }

  if (!target && !(note && note.trim().length > 0)) return null;
  return { status: parsed.status as ReminderStatus, ...(note !== undefined ? { note } : {}), ...(target ? { target } : {}) };
}

// ---------------------------------------------------------------------------
// Tag values
// ---------------------------------------------------------------------------

/** NIP-ER mandates 128 bits, so the `d` tag is 32 lowercase hex characters. */
export const REMINDER_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The relay's strict `not_before` validator, mirrored (§4.1).
 *
 * `^(0|[1-9][0-9]*)$` and `<= Number.MAX_SAFE_INTEGER`. Buzz applies this on
 * the way *out* so a client never shows a reminder the relay considers
 * malformed; we apply it on the way *in* as well, which is strictly better —
 * the malformed row is never written, so there is nothing to disagree about.
 */
export function parseNotBefore(raw: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * When the relay may garbage-collect a settled reminder: 30–90 days out.
 *
 * Jittered so a thousand reminders completed on the same afternoon do not all
 * expire in the same hour. Buzz jitters with a random number; ours is derived
 * from the reminder's own (random) id, which spreads identically and is
 * **reproducible** — a mutation that reads a clock and a PRNG is a mutation
 * whose retry can produce a different event id than its first attempt.
 */
export function jitteredExpiration(reminderId: string, nowSecs: number): number {
  let hash = 0;
  for (let i = 0; i < reminderId.length; i += 1) {
    hash = (hash * 31 + reminderId.charCodeAt(i)) >>> 0;
  }
  return nowSecs + 30 * DAY_SECONDS + (hash % (61 * DAY_SECONDS));
}

/**
 * Mint a `d` tag when the caller did not bring one.
 *
 * Buzz mints it in the browser with `crypto.getRandomValues`, and a client that
 * does so is honoured below — but a mutation has no CSPRNG, so the server's own
 * fallback is a hash over the things that make this call distinct. It does not
 * need to be unpredictable: the replacement coordinate is `kind:pubkey:d`, so a
 * collision could only ever be with one of your own reminders, and the insert
 * path refuses a collision loudly rather than replacing.
 */
function mintReminderId(seed: string): string {
  return sha256Hex(seed).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ReminderRow = Doc<"buzzReminders">;

/**
 * Due: pending, and its schedule has arrived.
 *
 * **The one definition**, used by the badge, the panel and the cron's
 * defensive re-check — the same reason Buzz factors `countDue` out rather than
 * writing the comparison twice: a badge that disagrees with the fire detector
 * is a badge that shows a number nothing will ever clear.
 */
export function isDueRow(row: ReminderRow, nowMs: number): boolean {
  return (
    row.status === "pending" &&
    row.notBefore !== undefined &&
    row.notBefore * 1000 <= nowMs
  );
}

/** What a reminder looks like to a client. */
export type ReminderView = {
  reminderId: string;
  eventId: string;
  status: ReminderStatus;
  /** Unix seconds, or null for a settled reminder that no longer has a schedule. */
  notBefore: number | null;
  /** Milliseconds — `timeAgo` and the grouping both speak the app's clock. */
  dueAtMs: number | null;
  note: string | null;
  target: ReminderTarget | null;
  firedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function toView(row: ReminderRow): ReminderView {
  return {
    reminderId: row.reminderId,
    eventId: row.eventId,
    status: row.status,
    notBefore: row.notBefore ?? null,
    dueAtMs: row.notBefore !== undefined ? row.notBefore * 1000 : null,
    note: row.note ?? null,
    target: row.target ?? null,
    firedAt: row.firedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function rowFor(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  subject: string,
  reminderId: string,
): Promise<ReminderRow | null> {
  return await ctx.db
    .query("buzzReminders")
    .withIndex("by_reminder", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("ownerClerkId", subject)
        .eq("reminderId", reminderId),
    )
    .unique();
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Write the reminder's current state to the log, replacing the previous one.
 *
 * `created_at = max(now, previous + 1)` (§4.1). Not decoration: `created_at` is
 * seconds, replacement is decided by it, and setting a reminder and snoozing it
 * in the same second is a thing a person does — on a tie the log falls back to
 * comparing event ids, which is a hash, so the *older* state would win half the
 * time and the snooze would silently not take.
 */
async function publishReminder(
  ctx: MutationCtx,
  args: {
    actor: Actor;
    scope: Scope;
    reminderId: string;
    content: ReminderContent;
    notBefore?: number;
    previousCreatedAt?: number;
  },
): Promise<{ eventId: string; createdAt: number }> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const createdAt =
    args.previousCreatedAt !== undefined
      ? Math.max(nowSecs, args.previousCreatedAt + 1)
      : nowSecs;

  // Pending carries `not_before`; settled carries `expiration` and **drops**
  // `not_before` entirely, which is what tells a relay the schedule is over
  // rather than merely in the past.
  const tags: string[][] = [["d", args.reminderId]];
  if (args.content.status === "pending") {
    if (args.notBefore === undefined) {
      throw new ConvexError("A pending reminder must have a time.");
    }
    tags.push(["not_before", String(args.notBefore)]);
  } else {
    tags.push(["expiration", String(jitteredExpiration(args.reminderId, createdAt))]);
  }

  const outcome = await publishCore(ctx, {
    actor: args.actor,
    scope: args.scope,
    kind: KIND_EVENT_REMINDER,
    tags,
    content: JSON.stringify(args.content),
    createdAt,
  });
  if (outcome.status === "dominated" || outcome.status === "ephemeral") {
    throw new ConvexError(
      `The log refused this reminder (${outcome.status}); nothing was written.`,
    );
  }
  return { eventId: outcome.event.id, createdAt };
}

async function userActor(ctx: QueryCtx | MutationCtx, subject: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return { type: "user", id: subject, name: user?.name ?? user?.email ?? subject };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const targetArg = v.object({
  eventId: v.string(),
  channelId: v.string(),
  preview: v.string(),
  authorPubkey: v.string(),
});

/**
 * Set a reminder.
 *
 * `notBefore` is unix **seconds** and is validated through the same
 * `parseNotBefore` a stored tag goes through, so the strictness is stated once.
 * A time in the past is refused: the native time input has no `min`, and
 * without this guard the commonest slip — picking today and a time that has
 * already gone — produces a reminder that fires the instant it is created,
 * which reads as a bug rather than as the schedule it literally is.
 */
export const create = mutation({
  args: {
    ...scopeArgs,
    notBefore: v.number(),
    note: v.optional(v.string()),
    target: v.optional(targetArg),
    /** A client-minted 32-hex `d` tag (`crypto.getRandomValues(16)`). */
    reminderId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ReminderView> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);

    const notBefore = parseNotBefore(String(args.notBefore));
    if (notBefore === null) throw new ConvexError("That is not a valid reminder time.");
    const now = Date.now();
    if (notBefore * 1000 <= now) {
      throw new ConvexError("Pick a time in the future.");
    }

    const note = (args.note ?? "").trim().slice(0, REMINDER_NOTE_MAX);
    const target = args.target
      ? { ...args.target, preview: args.target.preview.slice(0, REMINDER_PREVIEW_MAX) }
      : undefined;
    // The same bar `parseReminderContent` applies on the way out. Enforced here
    // too so a reminder that could never be rendered is never written.
    if (!target && note.length === 0) {
      throw new ConvexError("A reminder needs a note or a message to point at.");
    }

    const reminderId = args.reminderId ?? mintReminderId(`${subject}|${scope.scopeId}|${now}|${notBefore}|${note}`);
    if (!REMINDER_ID_RE.test(reminderId)) {
      throw new ConvexError("A reminder id must be 32 lowercase hex characters.");
    }
    if (await rowFor(ctx, scope, subject, reminderId)) {
      // Loud, not a silent replace. The coordinate is `kind:pubkey:d`, so a
      // collision would quietly overwrite one of this person's own reminders.
      throw new ConvexError("A reminder with that id already exists.");
    }

    const content: ReminderContent = {
      status: "pending",
      ...(note ? { note } : {}),
      ...(target ? { target } : {}),
    };
    const actor = await userActor(ctx, subject);
    const published = await publishReminder(ctx, {
      actor,
      scope,
      reminderId,
      content,
      notBefore,
    });

    const pubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";
    const id = await ctx.db.insert("buzzReminders", {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      ownerClerkId: subject,
      pubkey,
      reminderId,
      eventId: published.eventId,
      eventCreatedAt: published.createdAt,
      status: "pending",
      notBefore,
      // The watermark, armed.
      dueAt: notBefore * 1000,
      ...(note ? { note } : {}),
      ...(target ? { target } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return toView((await ctx.db.get(id))!);
  },
});

// ---------------------------------------------------------------------------
// Snooze, complete, cancel
// ---------------------------------------------------------------------------

/**
 * Move a reminder's schedule.
 *
 * Snoozing a *settled* reminder is allowed and is how "actually, bring that
 * back" works — it republishes with `status: "pending"` and a fresh
 * `not_before`, exactly as Buzz's snooze does. What matters here is the last
 * line: re-arming `dueAt` is what puts the row back into the cron's index
 * range, so the watermark and the schedule are one fact rather than two.
 */
export const snooze = mutation({
  args: { ...scopeArgs, reminderId: v.string(), notBefore: v.number() },
  handler: async (ctx, args): Promise<ReminderView> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const row = await rowFor(ctx, scope, subject, args.reminderId);
    if (!row) throw new ConvexError("Reminder not found");

    const notBefore = parseNotBefore(String(args.notBefore));
    if (notBefore === null) throw new ConvexError("That is not a valid reminder time.");
    if (notBefore * 1000 <= Date.now()) throw new ConvexError("Pick a time in the future.");

    const content: ReminderContent = {
      status: "pending",
      ...(row.note ? { note: row.note } : {}),
      ...(row.target ? { target: row.target } : {}),
    };
    const published = await publishReminder(ctx, {
      actor: await userActor(ctx, subject),
      scope,
      reminderId: row.reminderId,
      content,
      notBefore,
      previousCreatedAt: row.eventCreatedAt,
    });

    await ctx.db.patch(row._id, {
      status: "pending",
      notBefore,
      dueAt: notBefore * 1000,
      eventId: published.eventId,
      eventCreatedAt: published.createdAt,
      updatedAt: Date.now(),
    });
    return toView((await ctx.db.get(row._id))!);
  },
});

/**
 * Complete or cancel.
 *
 * One mutation because they are the same act on the same row with a different
 * word on it, and because both do the one thing that matters: **clear `dueAt`**.
 * A settled reminder leaves the cron's index range in the same transaction that
 * settles it, so there is no window in which a completed reminder can still
 * fire.
 */
export const settle = mutation({
  args: {
    ...scopeArgs,
    reminderId: v.string(),
    status: v.union(v.literal("done"), v.literal("cancelled")),
  },
  handler: async (ctx, args): Promise<ReminderView> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const row = await rowFor(ctx, scope, subject, args.reminderId);
    if (!row) throw new ConvexError("Reminder not found");
    if (row.status === args.status) return toView(row);

    const content: ReminderContent = {
      status: args.status,
      ...(row.note ? { note: row.note } : {}),
      ...(row.target ? { target: row.target } : {}),
    };
    const published = await publishReminder(ctx, {
      actor: await userActor(ctx, subject),
      scope,
      reminderId: row.reminderId,
      content,
      previousCreatedAt: row.eventCreatedAt,
    });

    await ctx.db.patch(row._id, {
      status: args.status,
      // The schedule is over, so it is removed rather than kept in the past —
      // matching the event, which drops `not_before` and gains `expiration`.
      notBefore: undefined,
      dueAt: undefined,
      eventId: published.eventId,
      eventCreatedAt: published.createdAt,
      updatedAt: Date.now(),
    });
    return toView((await ctx.db.get(row._id))!);
  },
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * This person's reminders in this community.
 *
 * Fenced twice over, and deliberately: `requireScopeAccess` is the tenancy
 * fence, and the index leads with the owner so there is no range that could
 * return somebody else's row even if the fence were bypassed. The log's own
 * author gate is the third — a 30300 is invisible to everyone but its author,
 * so even a direct read of the event store answers nothing.
 */
export const list = query({
  args: { ...scopeArgs, includeSettled: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ReminderView[]> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const rows = await ctx.db
      .query("buzzReminders")
      .withIndex("by_owner", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId),
      )
      .collect();
    return rows
      .filter((row) => (args.includeSettled ? true : row.status === "pending"))
      .map(toView)
      .sort((a, b) => (a.dueAtMs ?? Infinity) - (b.dueAtMs ?? Infinity));
  },
});

/** The badge. Same predicate the cron re-checks — see `isDueRow`. */
export const dueCount = query({
  args: scopeArgs,
  handler: async (ctx, args): Promise<number> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject } = await requireScopeAccess(ctx, scope);
    const now = Date.now();
    const rows = await ctx.db
      .query("buzzReminders")
      .withIndex("by_owner", (q) =>
        q
          .eq("ownerClerkId", subject)
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId),
      )
      .collect();
    return rows.filter((row) => isDueRow(row, now)).length;
  },
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * A reminder that fires is a notification, and it goes out through the
 * notification path this app already has.
 *
 * `notificationCenter.notify` writes the row the Inbox reads, and the `type`
 * carries the same `chat.<slot>` shape `buzz/notifications.ts` uses when it
 * mails a mention — so the reminder lands in the `needs_action` slot and the
 * client's existing per-slot sound and alert switches govern how loudly it
 * arrives. There is deliberately **no second delivery table, no second mailer,
 * and no server-side suppression**: which slots make a sound is a fact about a
 * browser (07 §7.6), and a *durable* record suppressed by a preference is a
 * reminder somebody asked for and never receives.
 */
async function deliver(
  ctx: MutationCtx,
  subject: string,
  rows: ReminderRow[],
): Promise<void> {
  if (rows.length === 0) return;

  if (rows.length === 1) {
    const row = rows[0];
    const body = row.target?.preview?.trim() || row.note?.trim() || "";
    await notifyInApp(ctx, {
      userClerkId: subject,
      type: "chat.needs_action",
      title: "Reminder",
      ...(body ? { body } : {}),
      href: row.target ? `/chat/c/${row.target.channelId}` : "/chat",
    });
    return;
  }

  // Coalesced, exactly as §4.4 specifies. Ten reminders coming due together is
  // one thing that has happened to a person, not ten.
  await notifyInApp(ctx, {
    userClerkId: subject,
    type: "chat.needs_action",
    title: `${rows.length} reminders are due`,
    href: "/chat",
  });
}

/**
 * The cron pass.
 *
 * Every interesting property of this function is in what it does *not* do. It
 * does not read a "last checked" timestamp, so it cannot skip a window. It does
 * not compare a stored `firedAt` against a schedule, so there is no comparison
 * to get backwards. It clears `dueAt`, which is the index key it selected on —
 * so a second pass over the same instant selects nothing, and the idempotency is
 * a property of the query rather than of a check somebody has to remember.
 *
 * `firedAt` is written too, but it is **display only**: nothing reads it to
 * decide whether to fire.
 */
export const fireDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ fired: number; people: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query("buzzReminders")
      .withIndex("by_due", (q) => q.gt("dueAt", 0).lte("dueAt", now))
      .take(FIRE_BATCH);

    const byOwner = new Map<string, ReminderRow[]>();
    for (const row of due) {
      // Defensive: a settled row should already have had `dueAt` cleared, so
      // reaching here means an older build or a hand-edited row. Clearing it
      // rather than notifying is the fail-closed direction.
      if (!isDueRow(row, now)) {
        await ctx.db.patch(row._id, { dueAt: undefined });
        continue;
      }
      const list = byOwner.get(row.ownerClerkId);
      if (list) list.push(row);
      else byOwner.set(row.ownerClerkId, [row]);
    }

    let fired = 0;
    for (const [subject, rows] of byOwner) {
      await deliver(ctx, subject, rows);
      for (const row of rows) {
        // The watermark. Cleared in the same transaction as the delivery, so a
        // retry of this mutation re-selects nothing.
        await ctx.db.patch(row._id, { dueAt: undefined, firedAt: now });
        fired += 1;
      }
    }
    return { fired, people: byOwner.size };
  },
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The reminder projection, declared here rather than in `_tables.ts`.
 *
 * Same reason `buzzNotificationTables` is declared in `notifications.ts`:
 * `_tables.ts` is the one file every Chat phase touches, and folding this in is
 * `...buzzReminderTables` beside it in `convex/schema.ts` and nothing else — no
 * migration, because there are no rows yet.
 */
export const buzzReminderTables = {
  buzzReminders: defineTable({
    ...scopeArgs,
    /** The owner. A reminder belongs to a person, never to a room. */
    ownerClerkId: v.string(),
    /** The pubkey the 30300 is signed with, so the row names its own event. */
    pubkey: v.string(),
    /** The `d` tag: 32 hex characters, NIP-ER's 128 bits. */
    reminderId: v.string(),
    /** The current head event for this coordinate. */
    eventId: v.string(),
    /**
     * The head's NIP-01 `created_at`, in **seconds**.
     *
     * Stored because the next replacement has to be strictly after it and
     * timestamps are seconds — without it, a snooze in the same second as the
     * create would tie, and the tie-break is a hash comparison.
     */
    eventCreatedAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("cancelled")),
    /** Unix seconds. Absent once the reminder is settled, matching the event. */
    notBefore: v.optional(v.number()),
    /**
     * **The watermark**, in milliseconds.
     *
     * Present iff the reminder is pending *and this schedule has not fired*.
     * Firing clears it, which removes the row from `by_due` — that is what
     * makes "fire twice, notify once" a property of the index rather than of a
     * check. Snoozing re-arms it. See the header of this file.
     */
    dueAt: v.optional(v.number()),
    /** When it last fired. Display only — nothing reads it to decide. */
    firedAt: v.optional(v.number()),
    note: v.optional(v.string()),
    target: v.optional(
      v.object({
        eventId: v.string(),
        channelId: v.string(),
        preview: v.string(),
        authorPubkey: v.string(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Owner-leading, so the panel and the badge range over one person's rows
    // and there is no plan that could return somebody else's.
    .index("by_owner", ["ownerClerkId", "scopeType", "scopeId"])
    // The upsert key. Scope-leading like every other Chat index, then the
    // owner, so a `d` tag from one person cannot address another's row.
    .index("by_reminder", ["scopeType", "scopeId", "ownerClerkId", "reminderId"])
    // The cron's only index, and deliberately **not** scope-leading: a cron has
    // no community and no identity, and "everything due now, anywhere" is a
    // range on time or it is a table scan.
    .index("by_due", ["dueAt"]),
};
