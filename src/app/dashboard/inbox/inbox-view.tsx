"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { parseMentionBody } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export function Inbox() {
  const mentions = useQuery(api.mentions.listForCurrent, {});
  const approvals = useQuery(api.tasks.pendingApprovals, {});
  const markAllRead = useMutation(api.mentions.markAllRead);

  if (mentions === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-24 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  const unread = mentions.filter((m) => !m.readAt);

  return (
    <div className="space-y-6">
      <header className="title-rule flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unread.length === 0
              ? "All caught up."
              : `${unread.length} unread mention${unread.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        {unread.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead({})}
          >
            Mark all read
          </Button>
        )}
      </header>

      {approvals !== undefined && approvals.length > 0 && (
        <ApprovalsQueue approvals={approvals} />
      )}

      {mentions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
          When someone @mentions you, it&apos;ll show up here.
        </div>
      ) : (
        <ul className="space-y-2">
          {mentions.map((mention) => (
            <li key={mention._id}>
              <MentionItem mention={mention} />
            </li>
          ))}
        </ul>
      )}
    </div>
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
    <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-brand-700">
        Waiting on your approval ({approvals.length})
      </h2>
      <ul className="mt-2 space-y-2">
        {approvals.map((a) => (
          <li
            key={a.taskId}
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 text-sm"
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
                    ? "text-emerald-600"
                    : "text-muted-foreground",
                )}
              >
                {a.checklistDone}/{a.checklistTotal} checklist
              </span>
            )}
            <Button size="sm" onClick={() => approve({ taskId: a.taskId })}>
              Approve
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MentionItem({ mention }: { mention: Doc<"mentions"> }) {
  // The mention row has parentType+parentId already (denormalized from
  // the message), so we can build a link without resolving the message.
  const message = useQuery(api.messages.listForParent, {
    parentType: mention.parentType,
    parentId: mention.parentId,
  });
  const markRead = useMutation(api.mentions.markRead);

  // Task mentions resolve their listId for a real deep link; channel
  // mentions resolve their workspace so they land on the right chat tab.
  const taskListId = useQuery(
    api.tasks.resolveListId,
    mention.parentType === "task"
      ? { taskId: mention.parentId as Id<"tasks"> }
      : "skip",
  );
  const channel = useQuery(
    api.channels.get,
    mention.parentType === "channel"
      ? { channelId: mention.parentId as Id<"channels"> }
      : "skip",
  );
  const href =
    mention.parentType === "workspace"
      ? `/dashboard/w/${mention.parentId}?tab=chat`
      : mention.parentType === "task" && taskListId
        ? `/dashboard/l/${taskListId}/t/${mention.parentId}`
        : mention.parentType === "channel" &&
            channel?.scopeType === "workspace"
          ? `/dashboard/w/${channel.scopeId}?tab=chat&channel=${mention.parentId}`
          : "/dashboard/inbox";

  const msg = message?.find((m) => m._id === mention.messageId);
  const preview = msg ? renderInlineBody(msg.body) : "…";

  return (
    <Link
      href={href}
      onClick={() => {
        if (!mention.readAt) markRead({ mentionId: mention._id });
      }}
      className={cn(
        "block rounded-2xl border border-border bg-background p-3 transition-colors hover:border-foreground/25",
        !mention.readAt && "border-l-4 border-l-brand-600",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {mention.parentType}
        </span>
        <span className="text-xs text-muted-foreground">
          {timeAgo(mention.createdAt)}
        </span>
      </div>
      <p className="mt-1 truncate text-sm">{preview}</p>
    </Link>
  );
}

function renderInlineBody(body: string): string {
  return parseMentionBody(body)
    .map((p) => (p.kind === "text" ? p.text : `@${p.name}`))
    .join("");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
