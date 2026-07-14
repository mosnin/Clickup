"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Per-agent drill-down: live status, governance controls (role, budget,
// notify URL), run history, current claims/assignments, and the agent's
// own event trail.

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const detail = useQuery(api.agents.detail, {
    agentId: agentId as Id<"agents">,
  });

  if (detail === undefined) {
    return <div className="h-60 animate-pulse rounded-3xl bg-muted/40" />;
  }
  if (detail === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This agent doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Link
          href="/dashboard/agents"
          className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Back to Agents
        </Link>
      </div>
    );
  }

  const { agent, runs, usageToday, usageLimit, events, claimed, assigned } =
    detail;
  const online =
    agent.lastSeenAt !== undefined &&
    Date.now() - agent.lastSeenAt < 5 * 60 * 1000;

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Agents
      </Link>

      <header className="flex items-start gap-3">
        <span className="text-3xl" aria-hidden>
          {agent.emoji ?? "🤖"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {agent.name}
            </h1>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
                agent.status === "paused"
                  ? "bg-muted text-muted-foreground"
                  : online
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {agent.status === "paused"
                ? "Paused"
                : online
                  ? "Online"
                  : agent.lastSeenAt
                    ? `Seen ${timeAgo(agent.lastSeenAt)}`
                    : "Never connected"}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {(agent.role ?? "member") === "readonly" ? "Read-only" : "Member"}
            </span>
          </div>
          {agent.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {agent.description}
            </p>
          )}
          {agent.statusText && (
            <p className="mt-2 inline-block rounded-2xl bg-muted/50 px-3 py-1.5 text-sm">
              <span className="font-medium">Now:</span> {agent.statusText}
            </p>
          )}
        </div>
      </header>

      <GovernancePanel
        agent={agent}
        usageToday={usageToday}
        usageLimit={usageLimit}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Working on ({claimed.length} claimed · {assigned.length} assigned)
          </h2>
          <ul className="space-y-1">
            {[...new Map(
              [...claimed, ...assigned].map((t) => [t.taskId, t]),
            ).values()].map((t) => (
              <li key={t.taskId}>
                <Link
                  href={`/dashboard/l/${t.listId}/t/${t.taskId}`}
                  className="block truncate rounded-2xl border border-border bg-background px-3 py-2 text-sm hover:border-brand-500"
                >
                  {t.title}
                  {claimed.some((c) => c.taskId === t.taskId) && (
                    <span className="ml-2 text-xs text-amber-600">
                      claimed
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {claimed.length === 0 && assigned.length === 0 && (
              <li className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                No open work assigned.
              </li>
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent runs
          </h2>
          <ul className="space-y-1">
            {runs.map((run) => (
              <RunRow key={run._id} run={run} />
            ))}
            {runs.length === 0 && (
              <li className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                No runs reported yet. Agents report sessions via the
                start_run / finish_run MCP tools.
              </li>
            )}
          </ul>
        </section>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent activity
        </h2>
        <ul className="space-y-1">
          {events.map((e) => (
            <li
              key={e._id}
              className="flex items-baseline gap-2 rounded-2xl border border-border bg-background px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{e.type} </span>
                <span className="font-medium">{e.entityTitle ?? ""}</span>
              </span>
              <span className="flex-shrink-0 text-xs text-muted-foreground">
                {timeAgo(e.createdAt)}
              </span>
            </li>
          ))}
          {events.length === 0 && (
            <li className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              Nothing yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function GovernancePanel({
  agent,
  usageToday,
  usageLimit,
}: {
  agent: Doc<"agents">;
  usageToday: number;
  usageLimit: number;
}) {
  const update = useMutation(api.agents.update);
  const [limitDraft, setLimitDraft] = useState(String(usageLimit));
  const [notifyDraft, setNotifyDraft] = useState(agent.notifyUrl ?? "");
  const usagePct = Math.min(100, Math.round((usageToday / usageLimit) * 100));

  return (
    <section className="rounded-3xl border border-border bg-background p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Governance
      </h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Role
          </span>
          <select
            value={agent.role ?? "member"}
            onChange={(e) =>
              update({
                agentId: agent._id,
                role: e.currentTarget.value as "member" | "readonly",
              })
            }
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="member">Member (read + write)</option>
            <option value="readonly">Read-only (no mutations)</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Daily action budget
          </span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={limitDraft}
              onChange={(e) => setLimitDraft(e.currentTarget.value)}
              onBlur={() => {
                const n = parseInt(limitDraft, 10);
                if (Number.isFinite(n) && n > 0 && n !== usageLimit) {
                  update({ agentId: agent._id, dailyActionLimit: n });
                }
              }}
              className="w-28 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              {usageToday} used today ({usagePct}%)
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                usagePct > 90 ? "bg-red-500" : "bg-brand-600",
              )}
              style={{ width: `${usagePct}%` }}
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Notify URL (assignment/mention pings)
          </span>
          <input
            value={notifyDraft}
            onChange={(e) => setNotifyDraft(e.currentTarget.value)}
            onBlur={() => {
              if (notifyDraft !== (agent.notifyUrl ?? "")) {
                update({
                  agentId: agent._id,
                  notifyUrl: notifyDraft.trim() || null,
                });
              }
            }}
            placeholder="https://my-runtime.example.com/wake"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
      </div>
    </section>
  );
}

const RUN_ICON = {
  running: CircleDashed,
  succeeded: CheckCircle2,
  failed: XCircle,
  abandoned: AlertTriangle,
} as const;

const RUN_COLOR = {
  running: "text-blue-500",
  succeeded: "text-emerald-600",
  failed: "text-red-600",
  abandoned: "text-amber-600",
} as const;

function RunRow({ run }: { run: Doc<"agentRuns"> }) {
  const Icon = RUN_ICON[run.status];
  const listId = useQuery(
    api.tasks.resolveListId,
    run.taskId ? { taskId: run.taskId } : "skip",
  );
  return (
    <li className="rounded-2xl border border-border bg-background px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Icon
          className={cn("h-4 w-4 flex-shrink-0", RUN_COLOR[run.status])}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium">{run.title}</span>
        <span className="flex-shrink-0 text-xs text-muted-foreground">
          {timeAgo(run.startedAt)}
        </span>
      </div>
      {(run.summary || run.error) && (
        <p
          className={cn(
            "mt-1 pl-6 text-xs",
            run.error ? "text-red-600" : "text-muted-foreground",
          )}
        >
          {run.error ?? run.summary}
        </p>
      )}
      {run.taskId && listId && (
        <Link
          href={`/dashboard/l/${listId}/t/${run.taskId}`}
          className="mt-0.5 block pl-6 text-xs text-brand-600 hover:underline"
        >
          View task
        </Link>
      )}
    </li>
  );
}
