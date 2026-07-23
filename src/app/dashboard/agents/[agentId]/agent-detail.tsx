"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  XCircle,
  AlertTriangle,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { eventLabel } from "@/lib/event-labels";
import { useToast } from "@/components/toast";
import { Monogram } from "@/components/dashboard/monogram";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Picker } from "@/components/ui/picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AnimatedBar,
  AnimatedNumber,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";

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
  const statusLabel = agent.status === "paused"
    ? "Paused"
    : online
      ? "Online"
      : agent.lastSeenAt
        ? `Seen ${timeAgo(agent.lastSeenAt)}`
        : "Never connected";

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Agents
      </Link>

      <PageHeader
        title={agent.name}
        context={
          <>
            <Badge
              variant="secondary"
              className={cn(
                "gap-1.5 uppercase tracking-wider",
                agent.status !== "paused" &&
                  online &&
                  "bg-pastel-green text-foreground dark:text-neutral-900",
              )}
            >
              <PresenceDot online={agent.status === "active" && online} />
              {statusLabel}
            </Badge>
            <Badge variant="outline" className="uppercase tracking-wider">
              {(agent.role ?? "member") === "readonly" ? "Read-only" : "Member"}
            </Badge>
          </>
        }
      />

      <header className="flex items-start gap-3">
        <Monogram name={agent.name} size="lg" />
        <div className="min-w-0 flex-1">
          {agent.description && (
            <p className="text-sm text-muted-foreground">
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
                  className="lift block truncate rounded-2xl panel px-3 py-2 text-sm"
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
              <li className="rounded-2xl panel p-4 text-center text-sm text-muted-foreground">
                No open work assigned.
              </li>
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent runs
          </h2>
          {runs.length > 0 ? (
            <Card className="gap-0 overflow-hidden rounded-2xl py-0">
              <CardContent className="px-0 py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <RunRow key={run._id} run={run} />
                  ))}
                </TableBody>
              </Table>
              </CardContent>
            </Card>
          ) : (
            <Card className="rounded-2xl p-6 text-center text-sm text-muted-foreground">
              No work sessions yet. They&apos;ll appear here once this agent
              starts working on tasks.
            </Card>
          )}
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
              className="flex items-baseline gap-2 rounded-2xl panel px-3 py-1.5 text-sm"
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
            <li className="rounded-2xl panel p-4 text-center text-sm text-muted-foreground">
              Nothing yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "-";
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
  // Pure integer counts get the springy AnimatedNumber count-up; the rest
  // (combined "ok/failed", formatted durations, currency) are pre-formatted
  // strings and render as plain text via the same component.
  const tiles: { label: string; value: number | string }[] = [
    { label: "Completed · 7d", value: stats.completed7d },
    { label: "Created · 7d", value: stats.created7d },
    { label: "Comments · 7d", value: stats.comments7d },
    {
      label: "Runs · 7d",
      value: `${stats.runsSucceeded7d} ok / ${stats.runsFailed7d} failed`,
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
        <StaggerItem key={t.label}>
          <Card className="gap-1 rounded-2xl p-3 text-center">
            <p className="text-lg font-bold tracking-tight">
              <AnimatedNumber value={t.value} />
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t.label}
            </p>
          </Card>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

// Lists in the agent's own scope (its personal space, or its workspace) —
// sourced the same way BillingTab sources scopes: off the current viewer's
// sidebar.tree, since managing an agent already implies access to its scope.
function useScopeLists(agent: Doc<"agents">) {
  const tree = useQuery(api.sidebar.tree, {});
  return useMemo(() => {
    if (!tree) return [];
    function flatten(
      space: { lists: Doc<"lists">[]; folders: { lists: Doc<"lists">[] }[] } | null,
    ): Doc<"lists">[] {
      if (!space) return [];
      return [...space.lists, ...space.folders.flatMap((f) => f.lists)];
    }
    if (agent.parentType === "user") {
      return flatten(tree.personal);
    }
    const ws = tree.workspaces.find((w) => w._id === agent.parentId);
    if (!ws) return [];
    return ws.spaces.flatMap((s) => flatten(s));
  }, [tree, agent.parentType, agent.parentId]);
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
  // The stored secret is never rendered back — like API keys, it's write-only
  // from the UI. An empty field means "unchanged"; typing replaces it.
  const [secretDraft, setSecretDraft] = useState("");
  const usagePct = Math.min(100, Math.round((usageToday / usageLimit) * 100));
  const scopeLists = useScopeLists(agent);
  const listNameById = useMemo(
    () => new Map(scopeLists.map((l) => [l._id as string, l.name])),
    [scopeLists],
  );
  const allowedListIds = agent.allowedListIds ?? [];
  const isMember = (agent.role ?? "member") === "member";

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
    <section className="rounded-2xl panel p-4">
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
              usagePct > 90 ? "bg-danger" : "bg-brand-600",
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
              type="password"
              autoComplete="off"
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.currentTarget.value)}
              onBlur={() => {
                if (secretDraft.trim()) {
                  save(
                    {
                      agentId: agent._id,
                      notifySecret: secretDraft.trim(),
                    },
                    "Signing secret",
                  );
                  setSecretDraft("");
                }
              }}
              placeholder={
                agent.notifySecret
                  ? "Secret set. Type to replace it."
                  : "Add a secret to sign pings"
              }
              className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
            {agent.notifySecret && (
              <button
                type="button"
                onClick={() =>
                  save(
                    { agentId: agent._id, notifySecret: null },
                    "Signing secret",
                  )
                }
                className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Remove secret
              </button>
            )}
          </label>
        </div>
      </div>

      {isMember && (
        <div className="mt-4 border-t border-border pt-4">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Restricted to lists (optional)
          </span>
          <p className="mb-2 text-xs text-muted-foreground">
            Leave empty for full access to every list in scope. When set,
            this agent can only read or write these lists — structure-level
            operations (create list/folder) are refused entirely.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {allowedListIds.map((id) => (
              <Badge
                key={id}
                variant="outline"
                className="gap-1.5 py-1 pr-1 pl-3 text-sm font-normal"
              >
                {listNameById.get(id) ?? "List"}
                <button
                  type="button"
                  aria-label="Remove list restriction"
                  onClick={() =>
                    save(
                      {
                        agentId: agent._id,
                        allowedListIds: allowedListIds.filter(
                          (l) => l !== id,
                        ),
                      },
                      "Restricted lists",
                    )
                  }
                  className="tap-target text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <Picker
              label="+ Add list…"
              dashed
              options={scopeLists
                .filter((l) => !allowedListIds.includes(l._id))
                .map((l) => ({ id: l._id as string, label: l.name }))}
              onSelect={(id) =>
                save(
                  {
                    agentId: agent._id,
                    allowedListIds: [...allowedListIds, id as Id<"lists">],
                  },
                  "Restricted lists",
                )
              }
            />
          </div>
          {allowedListIds.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Unrestricted — can access every list in scope.
            </p>
          )}
        </div>
      )}
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
    <TableRow>
      <TableCell className="align-top">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-xs font-medium",
            RUN_COLOR[run.status],
          )}
        >
          <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          {run.status}
        </span>
      </TableCell>
      <TableCell className="max-w-xs whitespace-normal align-top">
        <p className="truncate font-medium">{run.title}</p>
        {(run.summary || run.error) && (
          <p
            className={cn(
              "mt-1 text-xs",
              run.error ? "text-red-600" : "text-muted-foreground",
            )}
          >
            {run.error ?? run.summary}
          </p>
        )}
        {(run.links?.length ?? 0) > 0 && (
          <ul className="mt-1 space-y-0.5">
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
        {run.taskId && listId && (
          <Link
            href={`/dashboard/l/${listId}/t/${run.taskId}`}
            className="mt-0.5 block text-xs text-brand-600 hover:underline"
          >
            View task
          </Link>
        )}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {timeAgo(run.startedAt)}
      </TableCell>
      <TableCell className="align-top text-right text-xs text-muted-foreground">
        {run.tokensUsed !== undefined && `${run.tokensUsed} tok`}
        {run.tokensUsed !== undefined && run.costUsd !== undefined && " · "}
        {run.costUsd !== undefined && `$${run.costUsd}`}
        {run.tokensUsed === undefined && run.costUsd === undefined && "-"}
      </TableCell>
    </TableRow>
  );
}
