import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireIdentity } from "./_authz";

// Per-user notification preferences.
//
// Two rules shape this module:
//
//  1. Absent means default. A user who has never opened the settings has no
//     `notificationPrefs` object at all, and every read resolves through
//     `resolvePrefs` — so there is no migration to run and no "you have no
//     preferences" state to handle in the UI.
//
//  2. Turning something off silences the *push*, never the record. Mentions
//     still land in the inbox, events still land in the log, approvals still
//     queue. The only thing a disabled category stops is the live nudge. That
//     distinction matters: a notification toggle that also drops data is a
//     data-loss bug wearing a settings checkbox.

export const NOTIFICATION_CATEGORIES = [
  "mentions",
  "assignments",
  "approvals",
  "revisions",
  "agentPresence",
  "agentErrors",
  "taskUpdates",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationPrefs = {
  /** Master switch for the live stream. Off = no realtime push at all. */
  realtime: boolean;
} & Record<NotificationCategory, boolean>;

/**
 * Defaults chosen so a new account is useful but not noisy: anything aimed at
 * you personally is on, and the two high-volume firehoses (every task change
 * in your projects, and an agent coming online) are off until you ask for them.
 */
export const NOTIFICATION_DEFAULTS: NotificationPrefs = {
  realtime: true,
  mentions: true,
  assignments: true,
  approvals: true,
  revisions: true,
  agentErrors: true,
  agentPresence: false,
  taskUpdates: false,
};

export const CATEGORY_LABELS: Record<
  NotificationCategory,
  { label: string; hint: string }
> = {
  mentions: {
    label: "Mentions",
    hint: "Someone — or some agent — names you in a comment or a thread.",
  },
  assignments: {
    label: "Assignments",
    hint: "A task is assigned to you, or handed to you by an agent.",
  },
  approvals: {
    label: "Approvals",
    hint: "Work is gated and waiting on your sign-off.",
  },
  revisions: {
    label: "Revisions",
    hint: "A revision you asked for was addressed, or one was asked of you.",
  },
  agentErrors: {
    label: "Agent failures",
    hint: "An agent reported an error or stalled mid-task.",
  },
  agentPresence: {
    label: "Agents coming online",
    hint: "An agent connects or goes quiet. Chatty on a large fleet.",
  },
  taskUpdates: {
    label: "All task activity",
    hint: "Every change in the projects you can see. The full firehose.",
  },
};

/** Fills an incomplete stored object out to a complete one. */
export function resolvePrefs(
  stored:
    | {
        realtime?: boolean;
        mentions?: boolean;
        assignments?: boolean;
        approvals?: boolean;
        revisions?: boolean;
        agentPresence?: boolean;
        agentErrors?: boolean;
        taskUpdates?: boolean;
      }
    | undefined
    | null,
): NotificationPrefs {
  return { ...NOTIFICATION_DEFAULTS, ...(stored ?? {}) };
}

/** Server-side read, for the publisher deciding whether to push. */
export async function prefsForUser(
  ctx: QueryCtx,
  clerkId: string,
): Promise<NotificationPrefs> {
  const row = await ctx.db
    .query("userSettings")
    .withIndex("by_clerk", (q) => q.eq("clerkId", clerkId))
    .unique();
  return resolvePrefs(row?.notificationPrefs);
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    return await prefsForUser(ctx, identity.subject);
  },
});

export const set = mutation({
  args: {
    prefs: v.object({
      realtime: v.optional(v.boolean()),
      mentions: v.optional(v.boolean()),
      assignments: v.optional(v.boolean()),
      approvals: v.optional(v.boolean()),
      revisions: v.optional(v.boolean()),
      agentPresence: v.optional(v.boolean()),
      agentErrors: v.optional(v.boolean()),
      taskUpdates: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { prefs }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject))
      .unique();
    // Merge rather than replace: the UI sends one toggle at a time, and a
    // replace would silently reset every other category to its default.
    const merged = { ...(row?.notificationPrefs ?? {}), ...prefs };
    if (row) {
      await ctx.db.patch(row._id, { notificationPrefs: merged });
    } else {
      await ctx.db.insert("userSettings", {
        clerkId: identity.subject,
        notificationPrefs: merged,
      });
    }
    return resolvePrefs(merged);
  },
});
