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
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { eventLabel } from "@/lib/event-labels";
import { useToast } from "@/components/toast";
import { AnimatedBar, Stagger, StaggerItem } from "@/components/motion";

// Per-agent drill-down: live status, governance controls (role, budget,
// notify URL), run history, current claims/assignments, and the agent's
// own event trail.

export function AgentDetail({ agentId }: { agentId: string }) {
  const detail = useQuery(api.agents.detail, {
    agentId: agentId as Id<"agents">,
  });
  const stats = useQuery(api.agents.stats, {
    agentId: agentId as Id<"agents">,
  });

  if (detail === undefined) {
    // Shaped like the loaded page: breadcrumb, header, stat tiles, panel.
    return (
      <div className="space-y-6">
        <div className="h-4 w-20 animate-pulse rounded-full bg-muted" />
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
          <div className="h-7 w-48 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-border bg-muted/30"
            />
          ))}
        </div>
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-muted/30" />
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center">
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
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
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

      {stats && <StatsRow stats={stats} />}

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
                  className="lift block truncate rounded-2xl bento px-3 py-2 text-sm"
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
              className="flex items-baseline gap-2 rounded-2xl bento px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">
                  {eventLabel(e.type)}{" "}
                </span>
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

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 6) / 10}h`;
}

// Last-7-days analytics: is this agent actually productive?
function StatsRow({
  stats,
}: {
  stats: NonNullable<
    ReturnType<typeof useQuery<typeof api.agents.stats>>
  >;
}) {
  const tiles: { label: string; value: string }[] = [
    { label: "Completed · 7d", value: String(stats.completed7d) },
    { label: "Created · 7d", value: String(stats.created7d) },
    { label: "Comments · 7d", value: String(stats.comments7d) },
    {
      label: "Runs · 7d",
      value: `${stats.runsSucceeded7d}✓ ${stats.runsFailed7d}✗`,
    },
    { label: "Avg run", value: fmtMs(stats.avgRunMs) },
    { label: "Time logged · 7d", value: fmtMs(stats.timeLoggedMs7d) },
    ...(stats.costUsd7d > 0
      ? [{ label: "Cost · 7d", value: `$${stats.costUsd7d}` }]
      : []),
  ];
  return (
    <Stagger className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {tiles.map((t) => (
        <StaggerItem
          key={t.label}
          className="rounded-2xl bento p-3 text-center"
        >
          <p className="text-lg font-bold tracking-tight">{t.value}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t.label}
          </p>
        </StaggerItem>
      ))}
    </Stagger>
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
  const { toast } = useToast();
  const [limitDraft, setLimitDraft] = useState(String(usageLimit));
  const [notifyDraft, setNotifyDraft] = useState(agent.notifyUrl ?? "");
  const [secretDraft, setSecretDraft] = useState(agent.notifySecret ?? "");
  const usagePct = Math.min(100, Math.round((usageToday / usageLimit) * 100));

  // Blur-saving fields confirm themselves — silence reads as "did that
  // stick?".
  async function save(patch: Parameters<typeof update>[0], label: string) {
    try {
      await update(patch);
      toast(`${label} saved`);
    } catch {
      toast(`Couldn't save ${label.toLowerCase()}`, { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl bento p-4">
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
              save(
                {
                  agentId: agent._id,
                  role: e.currentTarget.value as "member" | "readonly",
                },
                "Role",
              )
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
                  save(
                    { agentId: agent._id, dailyActionLimit: n },
                    "Daily budget",
                  );
                }
              }}
              className="w-28 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              {usageToday} used today ({usagePct}%)
            </span>
          </div>
          <AnimatedBar
            pct={usagePct}
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
            barClassName={cn(
              "h-full rounded-full",
              usagePct > 90 ? "bg-red-500" : "bg-brand-600",
            )}
          />
        </label>

        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Notify URL (assignment/mention pings)
            </span>
            <input
              value={notifyDraft}
              onChange={(e) => setNotifyDraft(e.currentTarget.value)}
              onBlur={() => {
                if (notifyDraft !== (agent.notifyUrl ?? "")) {
                  save(
                    {
                      agentId: agent._id,
                      notifyUrl: notifyDraft.trim() || null,
                    },
                    "Notify URL",
                  );
                }
              }}
              placeholder="https://my-runtime.example.com/wake"
              className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ping signing secret (optional)
            </span>
            <input
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.currentTarget.value)}
              onBlur={() => {
                if (secretDraft !== (agent.notifySecret ?? "")) {
                  save(
                    {
                      agentId: agent._id,
                      notifySecret: secretDraft.trim() || null,
                    },
                    "Signing secret",
                  );
                }
              }}
              placeholder="pings get X-Ping-Signature when set"
              className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
        </div>
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
    <li className="rounded-2xl bento px-3 py-2 text-sm">
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
      {(run.links?.length ?? 0) > 0 && (
        <ul className="mt-1 space-y-0.5 pl-6">
          {run.links!.map((l) => (
            <li key={l}>
              <a
                href={l}
                target="_blank"
                rel="noreferrer"
                className="break-all text-xs text-brand-600 hover:underline"
              >
                {l}
              </a>
            </li>
          ))}
        </ul>
      )}
      {(run.costUsd !== undefined || run.tokensUsed !== undefined) && (
        <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
          {run.tokensUsed !== undefined && `${run.tokensUsed} tokens`}
          {run.tokensUsed !== undefined && run.costUsd !== undefined && " · "}
          {run.costUsd !== undefined && `$${run.costUsd}`}
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
