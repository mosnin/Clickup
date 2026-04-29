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
  const markAllRead = useMutation(api.mentions.markAllRead);

  if (mentions === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-24 animate-pulse rounded-3xl bg-muted/40" />
      </div>
    );
  }

  const unread = mentions.filter((m) => !m.readAt);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
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

      {mentions.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
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

function MentionItem({ mention }: { mention: Doc<"mentions"> }) {
  // The mention row has parentType+parentId already (denormalized from
  // the message), so we can build a link without resolving the message.
  const message = useQuery(api.messages.listForParent, {
    parentType: mention.parentType,
    parentId: mention.parentId,
  });
  const taskLocation = useQuery(
    api.tasks.resolveLocation,
    mention.parentType === "task"
      ? { taskId: mention.parentId as Id<"tasks"> }
      : "skip",
  );
  const markRead = useMutation(api.mentions.markRead);

  const href =
    mention.parentType === "workspace"
      ? `/dashboard/w/${mention.parentId}?tab=chat`
      : mention.parentType === "task" && taskLocation
        ? `/dashboard/l/${taskLocation.listId}/t/${mention.parentId}`
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
        "block rounded-3xl border border-border bg-background p-3 transition-colors hover:border-brand-500",
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
