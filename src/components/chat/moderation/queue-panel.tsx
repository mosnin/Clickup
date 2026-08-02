"use client";

// The moderation queue.
//
// What the screen draws follows from one sentence in §6.4: **the audit trail is
// the product.** So the queue is not a list of buttons — it is a list of
// *targets*, each carrying every report filed against it, every act already
// taken against it, and, when the reader is entitled to see it, the message
// itself. A moderator deciding without those three is guessing, and a guess
// recorded in an append-only trail is worse than no record.
//
// The triage — grouping, severity, ordering, prior-action correlation — is
// `src/lib/buzz/moderation.ts:groupReports`, pure and tested. Nothing here
// decides what goes above what.
//
// **The withheld count is drawn, not swallowed.** The server withholds every
// report whose target this moderator could not have read anyway, and returns a
// number. Showing it is the difference between "nothing to do" and "two things,
// and not for you" — and it is the only honest way to have a gate this strict.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { Stagger, StaggerItem } from "@/components/motion";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  QUEUE_ACTIONS,
  REPORT_TYPE_LABELS,
  RESOLUTION_ACTION_LABELS,
  groupReports,
  isActionable,
  severityOf,
  type ModerationQueueGroup,
  type ReportType,
  type ResolutionAction,
} from "@/lib/buzz/moderation";
import {
  moderationAudit,
  moderationQueue,
  moderationRestrictions,
  reasonOf,
  resolveReport,
  untimeoutMember,
  unbanMember,
} from "./moderation-data";

type Mode = "open" | "all" | "restricted";

export function ModerationQueuePanel({ scope }: { scope: ChatScope | null }) {
  const [mode, setMode] = useState<Mode>("open");
  const queue = useQuery(moderationQueue, scope ? { ...scope } : "skip");
  const audit = useQuery(moderationAudit, scope ? { ...scope } : "skip");
  const restrictions = useQuery(
    moderationRestrictions,
    scope && mode === "restricted" ? { ...scope } : "skip",
  );

  const groups = groupReports(
    (queue?.reports ?? []).filter((report) => (mode === "open" ? isActionable(report) : true)),
    audit?.entries ?? [],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-8">
      <h1 className="text-2xl font-bold tracking-tight">Moderation</h1>
      <div className="title-rule" />
      <p className="chat-quiet mt-3 text-sm">
        Reports are a signal, never a trigger. Nothing here has removed anything
        on its own.
      </p>

      <div className="segmented mt-5 flex gap-1" role="tablist" aria-label="Queue view">
        {(
          [
            ["open", "Open"],
            ["all", "Everything"],
            ["restricted", "Restricted"],
          ] as [Mode, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={cn(
              "tap-target rounded-full px-3 py-1 text-xs",
              mode === id && "segmented-on font-semibold",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "restricted" ? (
        <RestrictionList scope={scope} rows={restrictions} />
      ) : (
        <>
          {queue === undefined ? <QueueSkeleton /> : null}

          {queue && groups.length === 0 ? (
            <p className="chat-quiet mt-6 text-sm">
              {mode === "open" ? "Nothing open." : "No reports here."}
            </p>
          ) : null}

          <Stagger className="mt-4 space-y-2">
            {groups.map((group) => (
              <StaggerItem key={group.key}>
                <QueueGroupCard scope={scope} group={group} />
              </StaggerItem>
            ))}
          </Stagger>

          {queue && queue.withheld > 0 ? (
            <p className="chat-quiet mt-6 text-xs">
              {queue.withheld === 1
                ? "1 report is about a room you are not in, so it is not shown here."
                : `${queue.withheld} reports are about rooms you are not in, so they are not shown here.`}{" "}
              Their rooms&apos; own owners and admins can act on them.
            </p>
          ) : null}

          {audit && audit.withheld > 0 ? (
            <p className="chat-quiet mt-1 text-xs">
              {audit.withheld} audit {audit.withheld === 1 ? "entry is" : "entries are"}{" "}
              also withheld for the same reason.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function QueueGroupCard({
  scope,
  group,
}: {
  scope: ChatScope | null;
  group: ModerationQueueGroup;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<ResolutionAction | null>(null);
  const { toast } = useToast();
  const resolve = useMutation(resolveReport);

  const newest = group.reports[0];
  const open = group.reports.filter(isActionable);

  async function act(action: ResolutionAction) {
    if (!scope || open.length === 0 || busy) return;
    setBusy(action);
    try {
      // Every open report about this target, so resolving a group does not
      // leave four identical rows behind for the next moderator to re-read.
      for (const report of open) {
        await resolve({
          ...scope,
          reportId: report.id,
          action,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      }
      toast(`Resolved: ${RESOLUTION_ACTION_LABELS[action].toLowerCase()}`);
      setReason("");
    } catch (error) {
      toast(reasonOf(error), { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="bento rounded-2xl px-4 py-3">
      <header className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">
          {newest.targetName ?? "Unknown author"}
        </span>
        <span className="chat-badge" data-size="sm">
          {REPORT_TYPE_LABELS[newest.reportType as ReportType] ?? newest.reportType}
        </span>
        {severityOf(newest.reportType) >= 5 ? (
          <span className="text-xs font-semibold text-danger">high severity</span>
        ) : null}
        <span className="chat-quiet text-xs">{timeAgo(group.latestCreatedAt)}</span>
        {group.reports.length > 1 ? (
          <span className="chat-quiet text-xs">· {group.reports.length} reports</span>
        ) : null}
      </header>

      {newest.preview !== undefined ? (
        <blockquote className="bento-tile mt-2 rounded-xl px-3 py-2 text-sm">
          {newest.preview}
        </blockquote>
      ) : newest.removed ? (
        <p className="chat-quiet mt-2 text-sm">
          This message was removed by a community moderator.
        </p>
      ) : null}

      <ul className="mt-2 space-y-1">
        {group.reports.map((report) => (
          <li key={report.id} className="chat-quiet text-xs">
            {/* The reporter, visible here and **nowhere the reported author can
                reach**. Accountability runs both ways to moderators, never to
                the reported party (§6.4). */}
            {report.reporterName} · {REPORT_TYPE_LABELS[report.reportType as ReportType] ??
              report.reportType}
            {report.note ? ` — “${report.note}”` : ""}
            {report.status !== "open" ? ` · ${report.status}` : ""}
          </li>
        ))}
      </ul>

      {group.priorActions.length > 0 ? (
        <p className="chat-quiet mt-2 text-xs">
          Already acted on: {group.priorActions.map((a) => a.action).join(", ")}
        </p>
      ) : null}

      {open.length > 0 ? (
        <div className="mt-3 space-y-2">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (shown in the room's tombstone)"
            aria-label="Reason"
            className="soft-field w-full px-3 py-1.5 text-xs outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            {QUEUE_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                disabled={busy !== null}
                onClick={() => void act(action)}
                className={cn(
                  "tap-target rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-40",
                  action === "dismiss"
                    ? "bg-muted/70 hover:bg-muted"
                    : "bg-foreground font-semibold text-background",
                )}
              >
                {RESOLUTION_ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RestrictionList({
  scope,
  rows,
}: {
  scope: ChatScope | null;
  rows: ReturnType<typeof useQuery<typeof moderationRestrictions>>;
}) {
  const { toast } = useToast();
  const unban = useMutation(unbanMember);
  const untimeout = useMutation(untimeoutMember);

  if (rows === undefined) return <QueueSkeleton />;
  if (rows.length === 0) {
    return <p className="chat-quiet mt-6 text-sm">Nobody is restricted right now.</p>;
  }

  return (
    <ul className="mt-4 space-y-2">
      {rows.map((row) => (
        <li key={row.pubkey} className="bento flex items-center gap-3 rounded-2xl px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{row.name}</span>
            <span className="chat-quiet block text-xs">
              {row.banned ? "Banned" : "Timed out"}
              {row.expiresAt ? ` until ${new Date(row.expiresAt * 1000).toLocaleString()}` : ""}
              {row.reason ? ` — ${row.reason}` : ""}
            </span>
          </span>
          <button
            type="button"
            onClick={async () => {
              if (!scope) return;
              try {
                if (row.banned) await unban({ ...scope, pubkey: row.pubkey });
                else await untimeout({ ...scope, pubkey: row.pubkey });
                toast("Lifted");
              } catch (error) {
                toast(reasonOf(error), { kind: "error" });
              }
            }}
            className="tap-target shrink-0 rounded-full bg-muted/70 px-3 py-1 text-xs hover:bg-muted"
          >
            Lift
          </button>
        </li>
      ))}
    </ul>
  );
}

function QueueSkeleton() {
  return (
    <div className="mt-4 space-y-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="bento space-y-2 rounded-2xl px-4 py-3">
          <span className="block h-3 w-32 rounded bg-muted" />
          <span className="block h-3 w-full rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
