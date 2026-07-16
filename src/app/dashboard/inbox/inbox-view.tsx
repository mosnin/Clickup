"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { parseMentionBody } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import {
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// The one inbox. Everything that needs the user's attention lives here, in
// order of urgency: approvals to grant, mentions to answer, updates to skim.
// One unread language (the small ink dot), one "Mark all read" that clears
// the whole surface.

const CONTEXT_KIND: Record<string, string> = {
  task: "Task",
  workspace: "Chat",
  channel: "Channel",
  space: "Chat",
};

export function Inbox() {
  const mentions = useQuery(api.mentions.feedForCurrent, {});
  const approvals = useQuery(api.tasks.pendingApprovals, {});
  const updates = useQuery(api.notificationCenter.listForCurrent, {});
  const markMentionsRead = useMutation(api.mentions.markAllRead);
  const markUpdatesRead = useMutation(api.notificationCenter.markAllRead);

  if (mentions === undefined || updates === undefined) {
    return (
      <div className="space-y-6">
        <div className="space-y-2 pb-4">
          <div className="h-8 w-32 animate-pulse rounded-full bg-muted" />
          <div className="h-4 w-48 animate-pulse rounded-full bg-muted/70" />
        </div>
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
    (approvals?.length ?? 0) === 0;

  return (
    <div className="space-y-10">
      <header className="title-rule flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalUnread === 0
              ? "All caught up."
              : `${totalUnread} thing${totalUnread === 1 ? "" : "s"} waiting for you.`}
          </p>
        </div>
        {totalUnread > 0 && (
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
        )}
      </header>

      {isEmpty ? (
        <EmptyState
          title="Nothing needs you right now"
          message="Approvals, mentions, and updates about your work all land here the moment they happen."
        />
      ) : (
        <>
          {approvals !== undefined && approvals.length > 0 && (
            <ApprovalsQueue approvals={approvals} />
          )}

          {mentions.length > 0 && (
            <section>
              <SectionHeading
                label="Mentions"
                unread={unreadMentions}
              />
              <Stagger className="mt-3 space-y-2">
                {mentions.map((mention) => (
                  <StaggerItem key={mention._id}>
                    <MentionItem mention={mention} />
                  </StaggerItem>
                ))}
              </Stagger>
            </section>
          )}

          {updates.length > 0 && (
            <section>
              <SectionHeading label="Updates" unread={unreadUpdates} />
              <Stagger className="mt-3 space-y-2">
                {updates.map((n) => (
                  <StaggerItem key={n._id}>
                    <UpdateItem n={n} />
                  </StaggerItem>
                ))}
              </Stagger>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SectionHeading({ label, unread }: { label: string; unread: number }) {
  return (
    <h2 className="flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
      {unread > 0 && (
        <span className="font-normal normal-case tracking-normal">
          {unread} new
        </span>
      )}
    </h2>
  );
}

/** The one unread indicator: a small ink dot. */
function UnreadDot({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-2 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
        visible ? "bg-unread" : "bg-transparent",
      )}
    />
  );
}

// Gated tasks where agents finished (or are working) and a human needs to
// sign off. Approve inline or click through to review first.
function ApprovalsQueue({
  approvals,
}: {
  approvals: {
    taskId: Id<"tasks">;
    listId: Id<"lists">;
    title: string;
    checklistDone: number;
    checklistTotal: number;
    createdAt: number;
  }[];
}) {
  const approve = useMutation(api.tasks.approve);
  return (
    <section>
      <SectionHeading label="Waiting on your approval" unread={approvals.length} />
      <ul className="mt-3 space-y-2">
        <AnimatePresence initial={false}>
          {approvals.map((a) => (
            <motion.li
              key={a.taskId}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 24, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="flex flex-wrap items-center gap-3 overflow-hidden rounded-2xl bento px-4 py-3 text-sm"
            >
              <Link
                href={`/dashboard/l/${a.listId}/t/${a.taskId}`}
                className="min-w-0 flex-1 truncate font-medium hover:underline"
              >
                {a.title}
              </Link>
              {a.checklistTotal > 0 && (
                <span
                  className={cn(
                    "text-xs",
                    a.checklistDone === a.checklistTotal
                      ? "text-positive"
                      : "text-muted-foreground",
                  )}
                >
                  {a.checklistDone}/{a.checklistTotal} checklist
                </span>
              )}
              <Button size="sm" onClick={() => approve({ taskId: a.taskId })}>
                Approve
              </Button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
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

function MentionItem({ mention }: { mention: MentionRow }) {
  const markRead = useMutation(api.mentions.markRead);
  const preview = renderInlineBody(mention.body);
  const kind = CONTEXT_KIND[mention.parentType] ?? "Comment";

  const inner = (
    <div className="flex items-start gap-3">
      <UnreadDot visible={!mention.readAt} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {mention.authorName ? `${mention.authorName} · ` : ""}
            {kind}
            {mention.contextLabel ? ` · ${mention.contextLabel}` : ""}
          </span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            {timeAgo(mention.createdAt)}
          </span>
        </div>
        <p
          className={cn(
            "mt-1 truncate text-sm",
            !mention.readAt && "font-medium",
          )}
        >
          {preview || "…"}
        </p>
      </div>
    </div>
  );

  // A mention whose target no longer exists stays informative but quiet:
  // no dead link, no silent mark-read on click.
  if (!mention.href) {
    return <div className="rounded-2xl bento p-4 opacity-70">{inner}</div>;
  }

  return (
    <Link
      href={mention.href}
      onClick={() => {
        if (!mention.readAt) markRead({ mentionId: mention._id });
      }}
      className="lift block rounded-2xl bento p-4"
    >
      {inner}
    </Link>
  );
}

function UpdateItem({ n }: { n: Doc<"notifications"> }) {
  const markRead = useMutation(api.notificationCenter.markRead);
  const router = useRouter();
  const unread = n.readAt === undefined;

  return (
    <button
      type="button"
      onClick={() => {
        if (unread) void markRead({ notificationId: n._id });
        if (n.href) router.push(n.href);
      }}
      className={cn(
        "lift block w-full rounded-2xl bento p-4 text-left",
        !n.href && "cursor-default",
      )}
    >
      <div className="flex items-start gap-3">
        <UnreadDot visible={unread} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("truncate text-sm", unread && "font-medium")}>
              {n.title}
            </span>
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              {timeAgo(n.createdAt)}
            </span>
          </div>
          {n.body && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {n.body}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

function renderInlineBody(body: string): string {
  return parseMentionBody(body)
    .map((p) => (p.kind === "text" ? p.text : `@${p.name}`))
    .join("");
}
