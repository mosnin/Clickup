"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Bell, Inbox as InboxIcon, ShieldCheck } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { parseMentionBody } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import {
  isStale,
  OBLIGATION_KIND,
  type ObligationKind,
  summarize,
  waitedFor,
} from "@/lib/obligations";
import { describeBatch } from "@/lib/pending-effects";
import { useToast } from "@/components/toast";
import {
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { errorMessage } from "@/lib/errors";
import { safeNotificationBody } from "@/lib/notification-copy";
import { NotificationSettings } from "@/components/dashboard/notification-settings";

// The one inbox. Everything that needs the user's attention lives here, in
// order of urgency: approvals to grant, mentions to answer, updates to skim.
// One unread language (the small ink dot), one "Mark all read" that clears
// the whole surface.
//
// Row language throughout: a zero-padded index in the margin, a small
// circular glyph, a heavy title, outlined chips pushed right. Approvals sit
// in a quietly emphasized frame — the page's one focal moment — without
// reaching for alarm colour to say so.

const CONTEXT_KIND: Record<string, string> = {
  task: "Task",
  workspace: "Chat",
  channel: "Channel",
  space: "Chat",
  // C12: a mention in a Chat room. One literal — the row already arrives with
  // its `#channel` label and a working `/chat/c/…` link from
  // `mentions.feedForCurrent`.
  room: "Room",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function Inbox() {
  const mentions = useQuery(api.mentions.feedForCurrent, {});
  const obligations = useQuery(api.obligations.forCurrentUser, {});
  const updates = useQuery(api.notificationCenter.listForCurrent, {});
  const markMentionsRead = useMutation(api.mentions.markAllRead);
  const markUpdatesRead = useMutation(api.notificationCenter.markAllRead);

  if (mentions === undefined || updates === undefined) {
    return (
      <div className="space-y-6">
        <PageHeader icon={InboxIcon} title="Inbox" />


        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted/40" />
          ))}
        </div>
      </div>
    );
  }

  const unreadMentions = mentions.filter((m) => !m.readAt).length;
  const unreadUpdates = updates.filter((n) => n.readAt === undefined).length;
  const totalUnread = unreadMentions + unreadUpdates;
  const isEmpty =
    mentions.length === 0 &&
    updates.length === 0 &&
    (obligations?.length ?? 0) === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Waiting on you"
        description="Mentions, approvals and handoffs — the things that do not move until you touch them."
        icon={InboxIcon}
        title="Inbox"
        context={
          totalUnread === 0
            ? "All caught up"
            : `${totalUnread} unread`
        }
        actions={
          totalUnread > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void markMentionsRead({});
                void markUpdatesRead({});
              }}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      {isEmpty ? (
        <EmptyState
          title="Nothing needs you right now"
          message="Approvals, mentions, and updates about your work all land here the moment they happen."
        />
      ) : (
        <>
          {obligations !== undefined && obligations.length > 0 && (
            <YourTurnQueue rows={obligations} />
          )}

          {mentions.length > 0 && (
            <section>
              <SectionHeading
                label="Mentions"
                unread={unreadMentions}
              />
              <div className="panel mt-3 overflow-hidden rounded-2xl">
                <Stagger className="divide-y divide-border">
                  {mentions.map((mention, index) => (
                    <StaggerItem key={mention._id}>
                      <MentionItem mention={mention} index={index} />
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            </section>
          )}

          {updates.length > 0 && (
            <section>
              <SectionHeading label="Updates" unread={unreadUpdates} />
              <div className="panel mt-3 overflow-hidden rounded-2xl">
                <Stagger className="divide-y divide-border">
                  {updates.map((n, index) => (
                    <StaggerItem key={n._id}>
                      <UpdateItem n={n} index={index} />
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            </section>
          )}
        </>
      )}

      {/* Collapsed by default: the controls belong next to the thing they
          govern, but nobody comes to the Inbox to change settings. */}
      <details className="panel rounded-2xl p-5">
        <summary className="tap-target cursor-pointer text-sm font-semibold text-foreground">
          Notification settings
        </summary>
        <div className="mt-5 max-w-xl">
          <NotificationSettings />
        </div>
      </details>
    </div>
  );
}

function SectionHeading({ label, unread }: { label: string; unread: number }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-tiny font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h2>
      {unread > 0 && (
        <span className="ui-chip rounded-full px-2 py-0.5 text-tiny font-medium text-muted-foreground">
          {unread} new
        </span>
      )}
    </div>
  );
}

/** The one unread indicator: a small dot. Never a row tint. */
function UnreadDot({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
        visible ? "bg-unread" : "bg-transparent",
      )}
    />
  );
}

// Gated tasks where agents finished (or are working) and a human needs to
// sign off. Approve inline or click through to review first. The one focal
// moment on this page — a quiet frame rather than an alarm colour, because a
// gate waiting on a human is not a status, it is the page's whole subject.
/**
 * Everything waiting on this person, as one queue.
 *
 * Four sources used to live on four screens with four sets of words: a task
 * behind an approval gate, a revision somebody answered, a plan question a
 * person reserved, an outcome criterion needing sign-off. A fleet running
 * unattended for a week only has to be forgotten on ONE of those to stall.
 *
 * Oldest first, and the age is shown — the ordering every source it replaces
 * got backwards. A feed is for things you might read; this is for things that
 * do not move until you touch them, and the one at risk of never being
 * touched is the one that has waited longest.
 */
function YourTurnQueue({
  rows,
}: {
  rows: {
    kind: ObligationKind;
    id: string;
    title: string;
    href: string;
    raisedBy?: string;
    createdAt: number;
  }[];
}) {
  const approve = useMutation(api.tasks.approve);
  const decide = useMutation(api.pendingEffects.decide);
  const clearHold = useMutation(api.tasks.clearThrashHold);
  const { toast } = useToast();
  const now = Date.now();
  const { stale } = summarize(rows, now);

  // Work an agent has finished and handed back. Bulk matters here and nowhere
  // else in this queue: a decision is one at a time by nature, but a fleet
  // that cleared nine gated tasks this afternoon produced nine rows that say
  // the same thing, and reviewing those one click at a time is how people end
  // up turning the gate off.
  const handbacks = rows.filter((r) => r.kind === "handback");

  async function onApprove(taskId: string) {
    try {
      await approve({ taskId: taskId as Id<"tasks"> });
    } catch (e) {
      toast(errorMessage(e, "Couldn't approve this task"), { kind: "error" });
    }
  }

  async function onDecide(ids: string[], decision: "approve" | "reject") {
    try {
      const r = await decide({
        ids: ids as Id<"pendingEffects">[],
        decision,
      });
      // Reported per outcome rather than as one verdict. In a batch of nine,
      // a task somebody else moved cannot be applied, and saying "9 approved"
      // when eight were is the kind of small lie that costs trust in the
      // whole queue.
      const parts: string[] = [];
      if (r.applied > 0) parts.push(`${r.applied} completed`);
      if (r.rejected > 0) parts.push(`${r.rejected} sent back`);
      if (r.superseded > 0) {
        parts.push(`${r.superseded} skipped — changed since`);
      }
      toast(parts.join(", ") || "Nothing left to decide");
    } catch (e) {
      toast(errorMessage(e, "Couldn't record that decision"), { kind: "error" });
    }
  }

  return (
    <section>
      <SectionHeading label="Your turn" unread={rows.length} />
      <div className="mt-3 rounded-[1.625rem] bg-muted/30 p-1.5">
        <div className="overflow-hidden rounded-2xl panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
            <h3 className="text-base font-medium">
              Nothing moves until you touch these
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {stale > 0 && (
                <span className="ui-chip px-2 py-0.5 text-tiny font-medium text-danger">
                  {stale} waiting over a day
                </span>
              )}
              {handbacks.length > 1 && (
                <Button
                  size="sm"
                  onClick={() =>
                    onDecide(
                      handbacks.map((r) => r.id),
                      "approve",
                    )
                  }
                >
                  {describeBatch(
                    handbacks.map(() => ({ kind: "task.complete" as const })),
                  )}
                </Button>
              )}
            </div>
          </div>
          <ul className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {rows.map((row, index) => (
                <motion.li
                  key={`${row.kind}:${row.id}`}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 24, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.35, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <span className="w-6 shrink-0 font-title text-xs tabular-nums text-muted-foreground">
                      {pad(index + 1)}
                    </span>
                    <span className="icon-tile flex-shrink-0" aria-hidden>
                      <ShieldCheck className="size-4" />
                    </span>
                    <Link
                      href={row.href}
                      className="min-w-0 flex-1 basis-48 truncate text-sm font-semibold hover:underline"
                    >
                      {row.title}
                    </Link>
                    <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <span className="ui-chip px-2 py-0.5 text-tiny font-medium text-muted-foreground">
                        {OBLIGATION_KIND[row.kind].label}
                      </span>
                      {/* How long it has waited, not when it arrived. The
                          question a person acts on is "has this been
                          ignored", and a timestamp makes them do that
                          arithmetic themselves. */}
                      <span
                        className={cn(
                          "ui-chip ui-figure px-2 py-0.5 text-tiny",
                          isStale(row.createdAt, now)
                            ? "text-danger"
                            : "text-muted-foreground",
                        )}
                      >
                        {waitedFor(row.createdAt, now)}
                      </span>
                      {row.kind === "stuck" ? (
                        <>
                          {/* Open first, and it is the primary. A held task is
                              the one row in this queue where clearing it
                              without looking is the wrong move — the hold
                              exists precisely because trying again is what
                              got it here. */}
                          <Button size="sm" asChild>
                            <Link href={row.href}>Look at it</Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                await clearHold({
                                  taskId: row.id as Id<"tasks">,
                                });
                                toast("Released — agents can pick it up again");
                              } catch (e) {
                                toast(
                                  errorMessage(e, "Couldn't release this task"),
                                  { kind: "error" },
                                );
                              }
                            }}
                          >
                            Let it retry
                          </Button>
                        </>
                      ) : row.kind === "handback" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onDecide([row.id], "reject")}
                          >
                            Send back
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => onDecide([row.id], "approve")}
                          >
                            Approve
                          </Button>
                        </>
                      ) : row.kind === "approval" ? (
                        <Button size="sm" onClick={() => onApprove(row.id)}>
                          Approve
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" asChild>
                          <Link href={row.href}>Open</Link>
                        </Button>
                      )}
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </div>
    </section>
  );
}

type MentionRow = {
  _id: Id<"mentions">;
  createdAt: number;
  readAt?: number;
  parentType: string;
  body: string;
  authorName: string;
  href: string | null;
  contextLabel: string;
};

function MentionItem({
  mention,
  index,
}: {
  mention: MentionRow;
  index: number;
}) {
  const markRead = useMutation(api.mentions.markRead);
  const preview = renderInlineBody(mention.body);
  const kind = CONTEXT_KIND[mention.parentType] ?? "Comment";
  const unread = !mention.readAt;

  // 01 · glyph · title · [tag][tag] — the row is the whole tap target: the
  // meta line and chips share the same destination as the title.
  const row = (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden
        className="w-5 shrink-0 font-title text-tiny tabular-nums text-muted-foreground"
      >
        {pad(index + 1)}
      </span>
      <ActorGlyph
        name={mention.authorName || "Someone"}
        seed={mention._id}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-48">
          <p
            className={cn(
              "truncate text-sm",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {preview || "…"}
          </p>
          {mention.authorName && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {mention.authorName}
            </p>
          )}
        </div>
        <span className="flex flex-shrink-0 items-center gap-1.5">
          <UnreadDot visible={unread} />
          <span className="ui-chip whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground">
            {kind}
            {mention.contextLabel ? ` · ${mention.contextLabel}` : ""}
          </span>
          <span className="ui-chip ui-figure whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground">
            {timeAgo(mention.createdAt)}
          </span>
        </span>
      </div>
    </div>
  );

  // A mention whose target no longer exists stays informative but quiet:
  // no dead link, no silent mark-read on click.
  if (!mention.href) {
    return <div className="opacity-70">{row}</div>;
  }

  return (
    <Link
      href={mention.href}
      onClick={() => {
        if (!mention.readAt) markRead({ mentionId: mention._id });
      }}
      className="block transition-colors hover:bg-muted/20"
    >
      {row}
    </Link>
  );
}

function UpdateItem({ n, index }: { n: Doc<"notifications">; index: number }) {
  const markRead = useMutation(api.notificationCenter.markRead);
  const router = useRouter();
  const unread = n.readAt === undefined;
  const body = safeNotificationBody(n.type, n.body ?? "");

  return (
    <button
      type="button"
      onClick={() => {
        if (unread) void markRead({ notificationId: n._id });
        if (n.href) router.push(n.href);
      }}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20",
        !n.href && "cursor-default",
      )}
    >
      <span
        aria-hidden
        className="w-5 shrink-0 font-title text-tiny tabular-nums text-muted-foreground"
      >
        {pad(index + 1)}
      </span>
      <span className="icon-tile flex-shrink-0" aria-hidden>
        <Bell className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-48">
          <p className={cn("truncate text-sm", unread && "font-semibold")}>
            {n.title}
          </p>
          {body && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {body}
            </p>
          )}
        </div>
        <span className="flex flex-shrink-0 items-center gap-1.5">
          <UnreadDot visible={unread} />
          <span className="ui-chip ui-figure whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground">
            {timeAgo(n.createdAt)}
          </span>
        </span>
      </div>
    </button>
  );
}

function renderInlineBody(body: string): string {
  return parseMentionBody(body)
    .map((p) => (p.kind === "text" ? p.text : `@${p.name}`))
    .join("");
}
