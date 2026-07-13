"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Activity,
  Bot,
  BookOpen,
  Copy,
  KeyRound,
  Pause,
  Play,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Agents HQ ("Mission Control"): manage agent principals + API keys, watch
// a live activity feed of everything agents and humans are doing, and
// configure webhooks and skills. Everything renders live off Convex
// queries, so an agent's heartbeat/statusText updates appear in realtime.

type Tab = "agents" | "activity" | "webhooks" | "skills";

const TABS: { key: Tab; label: string; icon: typeof Bot }[] = [
  { key: "agents", label: "Agents", icon: Bot },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "webhooks", label: "Webhooks", icon: Webhook },
  { key: "skills", label: "Skills", icon: BookOpen },
];

export function AgentsView() {
  const [tab, setTab] = useState<Tab>("agents");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Agents
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mission control for the AI agents working in your spaces — see what
          they&apos;re doing live, hand them work, and manage their access.
        </p>
      </header>

      <nav
        aria-label="Agents tabs"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-background p-1 text-sm"
      >
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
              tab === key
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>

      {tab === "agents" ? (
        <AgentsTab />
      ) : tab === "activity" ? (
        <ActivityFeed />
      ) : tab === "webhooks" ? (
        <WebhooksTab />
      ) : (
        <SkillsTab />
      )}
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Agents tab ─────────────────────────────────────────────────────────

function AgentsTab() {
  const data = useQuery(api.agents.listForCurrentUser, {});
  const [creating, setCreating] = useState(false);

  const allAgents = useMemo(() => {
    if (!data) return [];
    return [...data.personal, ...data.workspaces.flatMap((w) => w.agents)];
  }, [data]);
  const currentTaskIds = allAgents
    .map((a) => a.currentTaskId)
    .filter((id): id is Id<"tasks"> => id !== undefined);
  const taskTitles = useQuery(api.agents.currentTaskTitles, {
    taskIds: currentTaskIds,
  });

  if (data === undefined) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/40" />;
  }
  if (data === null) return null;

  return (
    <div className="space-y-6">
      <ConnectHint />

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Your agents
        </h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New agent
        </Button>
      </div>

      {creating && (
        <CreateAgentForm
          workspaces={data.workspaces.map((w) => ({
            id: w.workspaceId,
            name: w.workspaceName,
          }))}
          onDone={() => setCreating(false)}
        />
      )}

      <AgentGroup
        label="Personal space"
        agents={data.personal}
        taskTitles={taskTitles ?? {}}
      />
      {data.workspaces.map((w) => (
        <AgentGroup
          key={w.workspaceId}
          label={w.workspaceName}
          agents={w.agents}
          taskTitles={taskTitles ?? {}}
        />
      ))}
    </div>
  );
}

function ConnectHint() {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/mcp`
      : "/api/mcp";
  return (
    <div className="rounded-3xl border border-border bg-muted/30 p-4 text-sm">
      <p className="font-medium">Connect an agent</p>
      <p className="mt-1 text-muted-foreground">
        Point any MCP-capable agent at{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{url}</code>{" "}
        with header{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          Authorization: Bearer &lt;api key&gt;
        </code>
        . Create an agent below, then mint its key. Tell it to call{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          get_skill(&quot;collaboration-protocol&quot;)
        </code>{" "}
        first.
      </p>
      <button
        type="button"
        className="mt-2 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="h-3 w-3" /> {copied ? "Copied!" : "Copy MCP URL"}
      </button>
    </div>
  );
}

function CreateAgentForm({
  workspaces,
  onDone,
}: {
  workspaces: { id: string; name: string }[];
  onDone: () => void;
}) {
  const create = useMutation(api.agents.create);
  const { user } = useUser();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState("personal");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="space-y-3 rounded-3xl border border-border bg-background p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || pending || !user) return;
        setPending(true);
        try {
          await create({
            name: name.trim(),
            emoji: emoji || undefined,
            description: description.trim() || undefined,
            parentType: scope === "personal" ? "user" : "workspace",
            parentId: scope === "personal" ? user.id : scope,
          });
          onDone();
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[80px_1fr_1fr]">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Emoji
          </span>
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.currentTarget.value)}
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-center text-sm"
            maxLength={4}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Scout"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Works in
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="personal">Personal space</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          What is this agent for? (optional)
        </span>
        <input
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="Triage bot that keeps the backlog clean"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || pending}>
          Create agent
        </Button>
      </div>
    </form>
  );
}

function AgentGroup({
  label,
  agents,
  taskTitles,
}: {
  label: string;
  agents: Doc<"agents">[];
  taskTitles: Record<string, string>;
}) {
  if (agents.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h3>
      <ul className="grid gap-3 lg:grid-cols-2">
        {agents.map((agent) => (
          <li key={agent._id}>
            <AgentCard agent={agent} taskTitles={taskTitles} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function AgentCard({
  agent,
  taskTitles,
}: {
  agent: Doc<"agents">;
  taskTitles: Record<string, string>;
}) {
  const update = useMutation(api.agents.update);
  const remove = useMutation(api.agents.remove);
  const [showKeys, setShowKeys] = useState(false);

  const online =
    agent.lastSeenAt !== undefined &&
    Date.now() - agent.lastSeenAt < ONLINE_WINDOW_MS;
  const currentTitle = agent.currentTaskId
    ? taskTitles[agent.currentTaskId]
    : undefined;

  return (
    <div className="rounded-3xl border border-border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden>
          {agent.emoji ?? "🤖"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{agent.name}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
                agent.status === "paused"
                  ? "bg-muted text-muted-foreground"
                  : online
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-muted text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  agent.status === "paused"
                    ? "bg-muted-foreground"
                    : online
                      ? "bg-emerald-500"
                      : "bg-muted-foreground",
                )}
              />
              {agent.status === "paused"
                ? "Paused"
                : online
                  ? "Online"
                  : agent.lastSeenAt
                    ? `Seen ${timeAgo(agent.lastSeenAt)}`
                    : "Never connected"}
            </span>
          </div>
          {agent.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {agent.description}
            </p>
          )}
          {(agent.statusText || currentTitle) && (
            <p className="mt-2 rounded-2xl bg-muted/50 px-3 py-1.5 text-xs">
              <span className="font-medium">Now:</span>{" "}
              {currentTitle && agent.currentTaskId ? (
                <span className="font-medium">{currentTitle} — </span>
              ) : null}
              {agent.statusText ?? "working"}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            title={agent.status === "active" ? "Pause agent" : "Resume agent"}
            onClick={() =>
              update({
                agentId: agent._id,
                status: agent.status === "active" ? "paused" : "active",
              })
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {agent.status === "active" ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            title="API keys"
            onClick={() => setShowKeys((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Delete agent"
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${agent.name}? Its API keys stop working immediately.`,
                )
              ) {
                remove({ agentId: agent._id });
              }
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {showKeys && <KeysPanel agentId={agent._id} />}
    </div>
  );
}

function KeysPanel({ agentId }: { agentId: Id<"agents"> }) {
  const keys = useQuery(api.agents.listKeys, { agentId });
  const createKey = useAction(api.agentKeys.createKey);
  const revokeKey = useMutation(api.agents.revokeKey);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="mt-3 space-y-2 rounded-2xl border border-border bg-muted/20 p-3">
      {freshKey && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-xs">
          <p className="font-medium text-emerald-800">
            Copy this key now — it won&apos;t be shown again.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1">
              {freshKey}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(freshKey)}
              className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-emerald-700 hover:bg-emerald-100"
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {(keys ?? []).map((k) => (
          <li key={k._id} className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5">
              {k.keyPrefix}…
            </code>
            <span className="text-muted-foreground">
              {k.revokedAt
                ? "revoked"
                : k.lastUsedAt
                  ? `last used ${timeAgo(k.lastUsedAt)}`
                  : "never used"}
            </span>
            {!k.revokedAt && (
              <button
                type="button"
                onClick={() => revokeKey({ keyId: k._id })}
                className="ml-auto rounded-full px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-red-600"
              >
                Revoke
              </button>
            )}
          </li>
        ))}
        {keys !== undefined && keys.length === 0 && (
          <li className="text-muted-foreground">No keys yet.</li>
        )}
      </ul>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            const res = await createKey({ agentId });
            setFreshKey(res.key);
          } finally {
            setPending(false);
          }
        }}
      >
        <Plus className="h-3.5 w-3.5" /> New API key
      </Button>
    </div>
  );
}

// ── Activity feed ──────────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  "task.created": "created task",
  "task.updated": "updated task",
  "task.assigned": "assigned",
  "task.status_changed": "moved",
  "task.completed": "completed task",
  "task.deleted": "deleted task",
  "task.claimed": "claimed task",
  "task.released": "released task",
  "comment.created": "commented on",
  "mention.created": "mentioned someone in",
  "sprint.created": "created sprint",
  "sprint.started": "started sprint",
  "sprint.completed": "completed sprint",
  "sprint.updated": "updated sprint",
};

export function ActivityFeed({
  scope,
}: {
  scope?: { scopeType: "user" | "workspace"; scopeId: string };
}) {
  const events = useQuery(api.events.feed, {
    scopeType: scope?.scopeType,
    scopeId: scope?.scopeId,
    limit: 75,
  });

  if (events === undefined) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/40" />;
  }
  if (events.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        No activity yet. Events appear here the moment agents (or teammates)
        create, claim, and complete work.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {events.map((e) => (
        <li
          key={e._id}
          className="flex items-baseline gap-2 rounded-2xl border border-border bg-background px-3 py-2 text-sm"
        >
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
              e.actorType === "agent"
                ? "bg-brand-50 text-brand-700"
                : e.actorType === "system"
                  ? "bg-muted text-muted-foreground"
                  : "bg-muted text-foreground",
            )}
          >
            {e.actorType === "agent" ? "🤖 " : ""}
            {e.actorName}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">
              {EVENT_LABEL[e.type] ?? e.type}{" "}
            </span>
            {e.entityType === "task" && e.listId ? (
              <Link
                href={`/dashboard/l/${e.listId}/t/${e.entityId}`}
                className="font-medium hover:underline"
              >
                {e.entityTitle ?? "a task"}
              </Link>
            ) : (
              <span className="font-medium">{e.entityTitle ?? ""}</span>
            )}
            {e.type === "task.status_changed" &&
              e.payload != null &&
              typeof e.payload === "object" && (
                <span className="text-muted-foreground">
                  {" "}
                  → {(e.payload as { to?: string }).to}
                </span>
              )}
          </span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            {timeAgo(e.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Webhooks tab ───────────────────────────────────────────────────────

function WebhooksTab() {
  const { user } = useUser();
  const subs = useQuery(api.webhooks.listForCurrentUser, {});
  const create = useMutation(api.webhooks.create);
  const update = useMutation(api.webhooks.update);
  const remove = useMutation(api.webhooks.remove);
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState("personal");
  const [types, setTypes] = useState("");
  const [freshSecret, setFreshSecret] = useState<string | null>(null);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    if (agents) {
      for (const a of [
        ...agents.personal,
        ...agents.workspaces.flatMap((w) => w.agents),
      ]) {
        map.set(a._id, a.name);
      }
    }
    return map;
  }, [agents]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Webhooks push every matching event (task.*, comment.*, mention.*,
        sprint.*) to an HTTPS endpoint, signed with HMAC-SHA256. Agents can
        also register their own over MCP — those show up here too.
      </p>

      <form
        className="flex flex-wrap items-end gap-2 rounded-3xl border border-border bg-background p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!url.trim() || !user) return;
          const res = await create({
            scopeType: scope === "personal" ? "user" : "workspace",
            scopeId: scope === "personal" ? user.id : scope,
            url: url.trim(),
            eventTypes: types
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          });
          setFreshSecret(res.secret);
          setUrl("");
          setTypes("");
        }}
      >
        <label className="block min-w-52 flex-1">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Endpoint URL
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="https://my-runtime.example.com/hooks"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Scope
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="personal">Personal space</option>
            {(agents?.workspaces ?? []).map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.workspaceName}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-44">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Event types (blank = all)
          </span>
          <input
            value={types}
            onChange={(e) => setTypes(e.currentTarget.value)}
            placeholder="task.created, task.completed"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <Button type="submit" size="sm" disabled={!url.trim()}>
          <Plus className="h-4 w-4" /> Add webhook
        </Button>
      </form>

      {freshSecret && (
        <div className="rounded-3xl border border-emerald-300 bg-emerald-50 p-3 text-xs">
          <p className="font-medium text-emerald-800">
            Signing secret (copy now — shown once):
          </p>
          <code className="mt-1 block break-all rounded bg-white px-2 py-1">
            {freshSecret}
          </code>
        </div>
      )}

      <ul className="space-y-2">
        {(subs ?? []).map((s) => (
          <li
            key={s._id}
            className="flex flex-wrap items-center gap-2 rounded-3xl border border-border bg-background px-4 py-3 text-sm"
          >
            <code className="min-w-0 flex-1 truncate text-xs">{s.url}</code>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {s.eventTypes.length === 0
                ? "all events"
                : s.eventTypes.join(", ")}
            </span>
            {s.ownerType === "agent" && (
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-brand-700">
                🤖 {agentNameById.get(s.ownerId) ?? "agent"}
              </span>
            )}
            {s.failureCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">
                {s.failureCount} fail{s.failureCount === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              onClick={() => update({ subscriptionId: s._id, enabled: !s.enabled })}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs",
                s.enabled
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {s.enabled ? "Enabled" : "Disabled"}
            </button>
            <button
              type="button"
              onClick={() => remove({ subscriptionId: s._id })}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {subs !== undefined && subs.length === 0 && (
          <li className="rounded-3xl border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No webhooks yet.
          </li>
        )}
      </ul>
    </div>
  );
}

// ── Skills tab ─────────────────────────────────────────────────────────

function SkillsTab() {
  const { user } = useUser();
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const [scope, setScope] = useState("personal");
  const scopeArgs = useMemo(
    () =>
      scope === "personal"
        ? { scopeType: "user" as const, scopeId: user?.id ?? "" }
        : { scopeType: "workspace" as const, scopeId: scope },
    [scope, user?.id],
  );
  const skills = useQuery(api.skills.listForScope, scopeArgs);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Skills are markdown playbooks agents import over MCP (
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            list_skills
          </code>
          {" / "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            get_skill
          </code>
          ). Built-ins ship with the product; add your own to teach agents
          your team&apos;s processes.
        </p>
        <select
          value={scope}
          onChange={(e) => setScope(e.currentTarget.value)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="personal">Personal space</option>
          {(agents?.workspaces ?? []).map((w) => (
            <option key={w.workspaceId} value={w.workspaceId}>
              {w.workspaceName}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" /> New skill
        </Button>
      </div>

      {creating && (
        <CreateSkillForm scopeArgs={scopeArgs} onDone={() => setCreating(false)} />
      )}

      <ul className="space-y-2">
        {(skills ?? []).map((s) => (
          <li key={s.slug}>
            <SkillRow
              skill={s}
              scopeArgs={scopeArgs}
              open={openSlug === s.slug}
              onToggle={() =>
                setOpenSlug((cur) => (cur === s.slug ? null : s.slug))
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillRow({
  skill,
  scopeArgs,
  open,
  onToggle,
}: {
  skill: {
    slug: string;
    name: string;
    description: string;
    builtin: boolean;
    _id?: Id<"skills">;
  };
  scopeArgs: { scopeType: "user" | "workspace"; scopeId: string };
  open: boolean;
  onToggle: () => void;
}) {
  const full = useQuery(
    api.skills.get,
    open ? { ...scopeArgs, slug: skill.slug } : "skip",
  );
  const removeSkill = useMutation(api.skills.remove);

  return (
    <div className="rounded-3xl border border-border bg-background p-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="font-medium">{skill.name}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
          {skill.slug}
        </code>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            skill.builtin
              ? "bg-muted text-muted-foreground"
              : "bg-brand-50 text-brand-700",
          )}
        >
          {skill.builtin ? "Built-in" : "Custom"}
        </span>
        {!skill.builtin && skill._id && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              removeSkill({ skillId: skill._id! });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") removeSkill({ skillId: skill._id! });
            }}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
            title="Delete skill"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
      {open && full && (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl bg-muted/40 p-4 text-xs">
          {full.content}
        </pre>
      )}
    </div>
  );
}

function CreateSkillForm({
  scopeArgs,
  onDone,
}: {
  scopeArgs: { scopeType: "user" | "workspace"; scopeId: string };
  onDone: () => void;
}) {
  const create = useMutation(api.skills.create);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  return (
    <form
      className="space-y-3 rounded-3xl border border-border bg-background p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !content.trim()) return;
        await create({
          ...scopeArgs,
          slug: name,
          name: name.trim(),
          description: description.trim(),
          content,
        });
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Release checklist"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Description
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="How we cut and verify a release"
            className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Playbook (markdown)
        </span>
        <textarea
          rows={8}
          value={content}
          onChange={(e) => setContent(e.currentTarget.value)}
          placeholder={"# Release checklist\n\n1. ..."}
          className="w-full rounded-3xl border border-border bg-background p-4 text-sm"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || !content.trim()}>
          Create skill
        </Button>
      </div>
    </form>
  );
}
