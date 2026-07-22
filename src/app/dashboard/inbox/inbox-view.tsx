"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Inbox as InboxIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { parseMentionBody } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
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

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

export function Inbox() {
  const mentions = useQuery(api.mentions.feedForCurrent, {});
  const approvals = useQuery(api.tasks.pendingApprovals, {});
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
    (approvals?.length ?? 0) === 0;

  return (
    <div className="space-y-8">
      <PageHeader
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
  const { toast } = useToast();

  async function onApprove(taskId: Id<"tasks">) {
    try {
      await approve({ taskId });
    } catch (e) {
      toast(errorMessage(e, "Couldn't approve this task"), {
        kind: "error",
      });
    }
  }

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
              className="overflow-hidden"
            >
              <Card className="gap-0 rounded-2xl py-0">
                <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
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
                  <Button size="sm" onClick={() => onApprove(a.taskId)}>
                    Approve
                  </Button>
                </CardContent>
              </Card>
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
    return (
      <Card className="gap-0 rounded-2xl py-0 opacity-70">
        <CardContent className="p-4">{inner}</CardContent>
      </Card>
    );
  }

  return (
    <Link
      href={mention.href}
      onClick={() => {
        if (!mention.readAt) markRead({ mentionId: mention._id });
      }}
      className="lift block"
    >
      <Card className="gap-0 rounded-2xl py-0">
        <CardContent className="p-4">{inner}</CardContent>
      </Card>
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
      className={cn("lift block w-full text-left", !n.href && "cursor-default")}
    >
      <Card className="gap-0 rounded-2xl py-0">
        <CardContent className="p-4">
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
        </CardContent>
      </Card>
    </button>
  );
}

function renderInlineBody(body: string): string {
  return parseMentionBody(body)
    .map((p) => (p.kind === "text" ? p.text : `@${p.name}`))
    .join("");
}
