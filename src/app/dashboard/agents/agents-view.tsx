"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Activity,
  Bot,
  BookOpen,
  KeyRound,
  Pause,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Wallet,
  Webhook,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import { CopyButton } from "@/components/dashboard/copy-button";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Card, CardContent } from "@/components/ui/card";
import { AgentStream } from "@/components/dashboard/agent-stream";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Orb } from "@/components/dashboard/orb";
import { BillingTab } from "@/components/dashboard/billing-panel";
import { ConnectSnippet } from "@/components/dashboard/connect-snippet";
import { Tabs } from "@/components/interior/tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { TerminalSurface } from "@/components/terminal-surface";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { eventHref, eventLabel } from "@/lib/event-labels";
import { agentPresence } from "@/lib/agent-presence";
import { useToast } from "@/components/toast";
import {
  AnimatedNumber,
  AnimatePresence,
  EASE,
  motion,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { ActorGlyph } from "@/components/appearance/actor-glyph";

// Agents HQ ("Mission Control"): manage agent principals + API keys, watch
// a live activity feed of everything agents and humans are doing, and
// configure webhooks and skills. Everything renders live off Convex
// queries, so an agent's heartbeat/statusText updates appear in realtime.

type Tab = "agents" | "activity" | "billing" | "webhooks" | "skills";

const AGENTS_PANEL_ID = "agents-section-panel";

const TABS: { key: Tab; label: string; icon: typeof Bot }[] = [
  { key: "agents", label: "Agents", icon: Bot },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "billing", label: "Billing", icon: Wallet },
  { key: "webhooks", label: "Webhooks", icon: Webhook },
  { key: "skills", label: "Skills", icon: BookOpen },
];

function usePresenceClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function AgentsView() {
  // Tab is URL-addressable (?tab=) so the sidebar can deep-link to Activity/
  // Billing/Webhooks/Skills; the "agents" tab is the bare /dashboard/agents.
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab");
  const initialTab: Tab = TABS.some((t) => t.key === rawTab)
    ? (rawTab as Tab)
    : "agents";
  const [tab, setTab] = useState<Tab>(initialTab);
  // Create/template flows are lifted here so the "New agent" trigger can
  // live in the sticky PageHeader while the form itself renders inside the
  // Agents tab, exactly where it always has.
  const [creating, setCreating] = useState(false);
  const [templating, setTemplating] = useState(false);
  const now = usePresenceClock();

  const agentsData = useQuery(api.agents.listForCurrentUser, {});
  const { onlineCount, totalCount } = useMemo(() => {
    if (!agentsData) return { onlineCount: 0, totalCount: 0 };
    const all = [
      ...agentsData.personal,
      ...agentsData.workspaces.flatMap((w) => w.agents),
    ];
    const online = all.filter((a) => agentPresence(a, now).online).length;
    return { onlineCount: online, totalCount: all.length };
  }, [agentsData, now]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Mission control"
        description="The AI agents working in your spaces. See what they're doing live, hand them work, and manage their access."
        icon={Bot}
        title="Agents"
        context={
          totalCount > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <PresenceDot online={onlineCount > 0} />
              {onlineCount} online
            </span>
          )
        }
        actions={
          tab === "agents" && (
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
                setTemplating(false);
              }}
            >
              <Plus className="h-4 w-4" /> New agent
            </Button>
          )
        }
      >
        {/* These were already tabs in everything but name and behaviour —
            `aria-current="page"` on a row of buttons that switch a panel,
            which announces them as navigation and costs one tab stop each.
            Now they say what they are and the arrow keys work. */}
        <Tabs
          items={TABS.map(({ key, label, icon }) => ({
            value: key,
            label,
            icon,
          }))}
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          label="Agents sections"
          // Automatic: these switch between already-subscribed views, so
          // arrowing through them is free and selection-follows-focus is the
          // faster contract.
          activation="automatic"
          panelId={AGENTS_PANEL_ID}
        />
      </PageHeader>

      {/* The page's own title block, under the sticky chrome.
          This was a typewriter animating the description into place on every
          visit — a paragraph that types itself is a paragraph you wait for,
          and it left the screen with no title at all above it. The eyebrow
          says what the screen is FOR; the heading is allowed to be large. */}

      <motion.div
        id={AGENTS_PANEL_ID}
        role="tabpanel"
        key={tab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        {tab === "agents" ? (
          <AgentsTab
            creating={creating}
            setCreating={setCreating}
            templating={templating}
            setTemplating={setTemplating}
          />
        ) : tab === "activity" ? (
          // The live card first, then the full history. They answer different
          // questions — "are my agents working right now" and "what happened
          // here" — and the first one is why anybody opens this tab.
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="order-2 lg:order-1">
              <ActivityFeed />
            </div>
            <Card className="order-1 h-fit max-h-[420px] rounded-2xl p-5 lg:order-2">
              <AgentStream limit={10} />
            </Card>
          </div>
        ) : tab === "billing" ? (
          <BillingTab />
        ) : tab === "webhooks" ? (
          <WebhooksTab />
        ) : (
          <SkillsTab />
        )}
      </motion.div>
    </div>
  );
}

// ── Agents tab ─────────────────────────────────────────────────────────

function AgentsTab({
  creating,
  setCreating,
  templating,
  setTemplating,
}: {
  creating: boolean;
  setCreating: (v: boolean) => void;
  templating: boolean;
  setTemplating: (v: boolean) => void;
}) {
  const data = useQuery(api.agents.listForCurrentUser, {});
  const now = usePresenceClock();

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
  // Same figures the header badge derives, computed here too — this is
  // where the bento that reads them lives.
  const { onlineCount, totalCount } = useMemo(() => {
    const online = allAgents.filter((a) => agentPresence(a, now).online).length;
    return { onlineCount: online, totalCount: allAgents.length };
  }, [allAgents, now]);

  if (data === undefined) {
    return <AgentsSkeleton />;
  }
  if (data === null) return null;

  // Once any agent has ever connected, the connect walkthrough has done
  // its job — collapse it out of the way.
  const anyConnected = allAgents.some((a) => a.lastSeenAt !== undefined);

  return (
    <div className="space-y-6">
      <ConnectHint retired={anyConnected} />

      {/* The page's one signal bento: fleet presence + spend, spent all at
          once so the rest of the screen can stay monochrome. */}
      <AgentsStatBento onlineCount={onlineCount} totalCount={totalCount} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-title text-xl font-bold tracking-tight">
          Your agents
        </h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setTemplating(!templating);
              setCreating(false);
            }}
          >
            <Sparkles className="h-4 w-4" /> From template
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {templating && (
          <motion.div
            key="template-gallery"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden"
          >
            <TemplateGallery
              workspaces={data.workspaces
                .filter((w) => w.canManageAgents)
                .map((w) => ({
                  id: w.workspaceId,
                  name: w.workspaceName,
                }))}
              onDone={() => setTemplating(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {creating && (
        <CreateAgentForm
          workspaces={data.workspaces
            .filter((w) => w.canManageAgents)
            .map((w) => ({
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
        canManage
      />
      {data.workspaces.map((w) => (
        <AgentGroup
          key={w.workspaceId}
          label={w.workspaceName}
          agents={w.agents}
          taskTitles={taskTitles ?? {}}
          canManage={w.canManageAgents}
        />
      ))}
    </div>
  );
}

function AgentsSkeleton() {
  // Shaped like the loaded page: hint card, stat bento, section header, rows.
  return (
    <div className="space-y-6">
      <div className="h-28 animate-pulse rounded-2xl bg-muted/30" />
      <div className="grid grid-cols-2 grid-rows-2 gap-4 @3xl:grid-cols-3">
        <div className="col-span-2 row-span-2 h-40 animate-pulse rounded-2xl bg-muted/30" />
        <div className="h-16 animate-pulse rounded-2xl bg-muted/30" />
        <div className="h-16 animate-pulse rounded-2xl bg-muted/30" />
      </div>
      <div className="h-6 w-28 animate-pulse rounded-full bg-muted" />
      <div className="overflow-hidden rounded-2xl bg-card">
        <div className="h-12 border-b border-border bg-muted/20" />
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0"
          >
            <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectHint({ retired = false }: { retired?: boolean }) {
  // Once an agent has connected the walkthrough collapses to one line;
  // it can be re-expanded to connect the next agent.
  const [expanded, setExpanded] = useState(false);

  if (retired && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Connecting another agent? Show setup instructions
      </button>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl panel text-sm">
      <TerminalSurface className="h-24" contentClassName="flex h-full items-end px-5 pb-3">
        <span className="font-mono text-tiny tracking-wider text-white/70">
          listening for your first agent…
        </span>
      </TerminalSurface>
      <div className="p-5">
      <p className="font-medium">Connect an agent</p>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        Create an agent, copy its key, then paste one of these blocks where
        your agent runs. That&apos;s the whole setup. It shows up here the
        moment it checks in.
      </p>
      <ConnectSnippet className="mt-3" />
      {retired && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Hide
        </button>
      )}
      </div>
    </div>
  );
}

// The page's one signal bento: fleet presence (the tall block, art-carrying)
// beside spend over the last 7 days — the two figures this screen already
// computes elsewhere (the header badge, the old FleetSpend row) drawn once,
// saturated, together. Top spenders stays a plain outlined list underneath —
// it's the one thing on this screen that's a LIST, and a list of names over a
// fill is unreadable (see StatsCards on Home for the same rule).
function AgentsStatBento({
  onlineCount,
  totalCount,
}: {
  onlineCount: number;
  totalCount: number;
}) {
  const spend = useQuery(api.agents.fleetSpend, {});

  return (
    <div className="space-y-3">
      <Stagger className="grid grid-cols-2 grid-rows-2 gap-4 @3xl:grid-cols-3">
        {/* ── The headline block: agents online right now ─────────────── */}
        <StaggerItem lift className="col-span-2 row-span-2 min-h-0">
          <div className="relative flex h-full min-h-[10rem] flex-col justify-between overflow-hidden rounded-2xl bg-signal-yellow p-5 text-signal-ink">
            <span className="relative text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
              Fleet
            </span>
            <span className="relative mt-3 min-w-0">
              <span className="font-title block text-[3.5rem] font-bold leading-[0.85] tracking-tight">
                <AnimatedNumber value={onlineCount} />
              </span>
              <span className="mt-1.5 block text-sm font-medium opacity-70">
                {onlineCount === 1 ? "agent" : "agents"} online right now
              </span>
            </span>
            <span className="relative mt-4 min-w-0 border-t border-current/20 pt-2.5">
              <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-55">
                Fleet size
              </span>
              <span className="mt-0.5 block text-sm font-semibold">
                {totalCount} {totalCount === 1 ? "agent" : "agents"} total
              </span>
            </span>
          </div>
        </StaggerItem>

        {/* ── The two that move, stacked in one column ─────────────────── */}
        <StaggerItem lift className="min-h-0 @3xl:col-start-3 @3xl:row-start-1">
          <div className="flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl bg-signal-teal p-4 text-signal-ink">
            <span className="flex items-center gap-3">
              <span className="font-title block truncate text-[2.25rem] font-bold leading-[0.85] tracking-tight">
                ${(spend?.cost7 ?? 0).toFixed(2)}
              </span>
            </span>
            <span className="mt-auto border-t border-current/20 pt-2">
              <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
                Spend · 7d
              </span>
              <span className="mt-0.5 block text-tiny font-medium opacity-70">
                {spend ? `$${spend.cost30.toFixed(2)} over 30d` : "no spend yet"}
              </span>
            </span>
          </div>
        </StaggerItem>

        <StaggerItem lift className="min-h-0 @3xl:col-start-3 @3xl:row-start-2">
          <div className="flex h-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl bg-signal-pink p-4 text-signal-ink">
            <span className="flex items-center gap-3">
              <span className="font-title block text-[2.25rem] font-bold leading-[0.85] tracking-tight">
                <AnimatedNumber value={spend?.runs7 ?? 0} />
              </span>
            </span>
            <span className="mt-auto border-t border-current/20 pt-2">
              <span className="block text-tiny font-semibold uppercase tracking-[0.14em] opacity-60">
                Runs · 7d
              </span>
              <span className="mt-0.5 block text-tiny font-medium opacity-70">
                {spend && spend.tokens7 > 0
                  ? `${compactNumber(spend.tokens7)} tokens`
                  : "nothing run yet"}
              </span>
            </span>
          </div>
        </StaggerItem>
      </Stagger>

      {spend && spend.topSpenders.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
            Top spend
          </span>
          {spend.topSpenders.map((a) => (
            <span
              key={a.name}
              className="ui-chip inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-xs text-muted-foreground"
            >
              <ActorGlyph seed={a.name} name={a.name} size="xs" isAgent />
              <span className="text-foreground">{a.name}</span>
              <span className="tabular-nums">${a.cost.toFixed(2)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Templates whose persona needs a workspace to function (e.g. sprints are
// workspace-scoped — see convex/sprints.ts and convex/agentTemplates.ts).
// Not encoded on the template itself, so kept as a small allowlist here.
const WORKSPACE_ONLY_TEMPLATE_SLUGS = new Set(["sprint-planner"]);

// One-click, pre-governed agent presets. Picks a target scope once, then
// each card spins up an agent with its role + budget already set.
function TemplateGallery({
  workspaces,
  onDone,
}: {
  workspaces: { id: string; name: string }[];
  onDone: () => void;
}) {
  const { user } = useUser();
  const templates = useQuery(api.agentTemplates.listTemplates, {});
  const createFromTemplate = useMutation(api.agentTemplates.createFromTemplate);
  const { toast } = useToast();
  const [scope, setScope] = useState("personal");
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  const scopeOptions = [
    { id: "personal", label: "Personal space" },
    ...workspaces.map((w) => ({ id: w.id, label: w.name })),
  ];
  const scopeLabel =
    scopeOptions.find((o) => o.id === scope)?.label ?? "Personal space";

  async function spawn(slug: string, name: string) {
    if (!user || pendingSlug) return;
    setPendingSlug(slug);
    try {
      await createFromTemplate({
        slug,
        parentType: scope === "personal" ? "user" : "workspace",
        parentId: scope === "personal" ? user.id : scope,
      });
      toast(`${name} agent created`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      toast(raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || "Failed", {
        kind: "error",
      });
    } finally {
      setPendingSlug(null);
    }
  }

  return (
    <Card className="rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Start from a template</p>
          <p className="text-xs text-muted-foreground">
            Each preset ships with a role and a daily action budget. Mint its
            key after it&apos;s created.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Create in
          <Picker
            label={scopeLabel}
            selectedId={scope}
            options={scopeOptions}
            onSelect={setScope}
          />
        </label>
      </div>
      <Stagger className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(templates ?? []).map((t) => {
          const needsWorkspace = WORKSPACE_ONLY_TEMPLATE_SLUGS.has(t.slug);
          const blocked = needsWorkspace && scope === "personal";
          return (
            <StaggerItem key={t.slug}>
              <button
                type="button"
                disabled={pendingSlug !== null || blocked}
                title={
                  blocked
                    ? "This persona needs a team workspace — switch \"Create in\" above."
                    : undefined
                }
                onClick={() => spawn(t.slug, t.name)}
                className="lift flex h-full w-full flex-col rounded-2xl bento-tile p-4 text-left disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  <Orb seed={t.slug} label={t.name} size="sm" />
                  <span className="font-medium">{t.name}</span>
                  {pendingSlug === t.slug && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Creating…
                    </span>
                  )}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  {t.tagline}
                </span>
                <span className="mt-3 line-clamp-2 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {t.description}
                </span>
                <span className="mt-3 flex flex-wrap gap-1.5">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-micro uppercase tracking-wider",
                      t.role === "readonly"
                        ? "bg-pastel-yellow text-foreground dark:text-neutral-900"
                        : "bg-pastel-blue text-foreground dark:text-neutral-900",
                    )}
                  >
                    {t.role}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-micro uppercase tracking-wider text-muted-foreground">
                    {t.dailyActionLimit.toLocaleString()}/day
                  </span>
                  {needsWorkspace && (
                    <span className="rounded-full bg-pastel-yellow px-2 py-0.5 text-micro uppercase tracking-wider text-foreground dark:text-neutral-900">
                      Needs a workspace
                    </span>
                  )}
                </span>
                {blocked && (
                  <span className="mt-2 text-xs text-amber-600">
                    Can&apos;t be created in Personal space — pick a team
                    workspace above.
                  </span>
                )}
              </button>
            </StaggerItem>
          );
        })}
      </Stagger>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </Card>
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
  const mintKey = useAction(api.agentKeys.createKey);
  const { user } = useUser();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [scope, setScope] = useState("personal");
  const [pending, setPending] = useState(false);
  // After create: the guided connect step, so nobody has to hunt for the
  // key panel. The key is shown exactly once.
  const [connect, setConnect] = useState<{ name: string; key: string } | null>(
    null,
  );

  if (connect) {
    return (
      <div className="overflow-hidden rounded-2xl panel">
        <TerminalSurface
          intensity="live"
          className="h-28"
          contentClassName="flex h-full items-end px-5 pb-3"
        >
          <span className="font-mono text-tiny tracking-wider text-white/70">
            waiting for {connect.name.toLowerCase()} to check in…
          </span>
        </TerminalSurface>
        <div className="space-y-4 p-5">
        <div>
          <p className="font-semibold">{connect.name} is ready.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            One step left: paste this where {connect.name} runs. The key is
            shown only this once, so copy it now.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-muted p-3">
          <code className="min-w-0 flex-1 break-all text-xs">{connect.key}</code>
          {/* The copy morph confirms in place — glyph flips to a check,
              label says Copied, double-tick sounds, reverts on its own. */}
          <CopyButton
            value={connect.key}
            label="Copy key"
            iconClassName="h-3 w-3"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-accent"
          />
        </div>
        <ConnectSnippet apiKey={connect.key} />
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 rounded-2xl panel p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || pending || !user) return;
        setPending(true);
        // Two sequential steps: if create succeeds but minting fails, the
        // agent exists — close to show it and point at the Keys tab rather
        // than pretending total failure.
        let created = false;
        try {
          const agentId = await create({
            name: name.trim(),
            description: description.trim() || undefined,
            capabilities: capabilities
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            parentType: scope === "personal" ? "user" : "workspace",
            parentId: scope === "personal" ? user.id : scope,
          });
          created = true;
          const res = await mintKey({ agentId });
          setConnect({ name: name.trim(), key: res.key });
        } catch (e) {
          if (created) {
            toast(
              "Agent created, but its key couldn't be minted — mint one from the Keys tab",
              { kind: "error" },
            );
            onDone();
          } else {
            const raw = e instanceof Error ? e.message : String(e);
            toast(
              raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
                "Couldn't create agent",
              { kind: "error" },
            );
          }
        } finally {
          setPending(false);
        }
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
            placeholder="Scout"
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
          className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Capabilities (optional)
        </span>
        <input
          value={capabilities}
          onChange={(e) => setCapabilities(e.currentTarget.value)}
          placeholder="typescript, backend, quality-assurance"
          className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Comma-separated contracts used to route only compatible work.
        </span>
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
  canManage,
}: {
  label: string;
  agents: Doc<"agents">[];
  taskTitles: Record<string, string>;
  canManage: boolean;
}) {
  if (agents.length === 0) return null;
  return (
    <section className="@container overflow-hidden rounded-2xl panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <h3 className="text-base font-medium">{label}</h3>
        {!canManage && (
          <span className="text-xs text-muted-foreground">
            Owners and admins manage access
          </span>
        )}
      </div>
      <Stagger className="divide-y divide-border">
        {agents.map((agent, index) => (
          <StaggerItem key={agent._id}>
            <AgentRow
              index={index + 1}
              agent={agent}
              taskTitles={taskTitles}
              canManage={canManage}
            />
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

// The row language: `01 · glyph · title · [tag] [tag]` — a zero-padded
// index in the margin, the agent's glyph, a heavy name, and presence as an
// outlined chip pushed right. Everything below the row header (description,
// signal detail, current status) reads as prose rather than tags, the same
// way Today's tasks on Home keeps its meta line under the title.
function AgentRow({
  index,
  agent,
  taskTitles,
  canManage,
}: {
  index: number;
  agent: Doc<"agents">;
  taskTitles: Record<string, string>;
  canManage: boolean;
}) {
  const now = usePresenceClock();
  const update = useMutation(api.agents.update);
  const remove = useMutation(api.agents.remove);
  const [showKeys, setShowKeys] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  const presence = agentPresence(agent, now);
  const currentTitle = agent.currentTaskId
    ? taskTitles[agent.currentTaskId]
    : undefined;

  // Hidden while its undo toast is live — the delete (and key revocation)
  // only commits once the undo window closes.
  if (deleting) return null;

  const statusLabel =
    presence.state === "recently_seen" || presence.state === "offline"
      ? `Seen ${timeAgo(agent.lastSeenAt!)}`
      : presence.label;
  const signalLabel =
    presence.state === "online_heartbeating"
      ? "Heartbeat live"
      : presence.state === "online_connected"
        ? "MCP connected · heartbeat pending"
        : presence.detail;

  return (
    <div>
      <div className="flex items-start gap-3 px-5 py-3">
        <span
          aria-hidden
          className="w-6 flex-shrink-0 pt-1.5 text-right font-title text-xs tabular-nums text-muted-foreground"
        >
          {String(index).padStart(2, "0")}
        </span>
        <ActorGlyph
          seed={agent._id}
          name={agent.name}
          size="lg"
          isAgent
          className="flex-shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Link
              href={`/dashboard/agents/${agent._id}`}
              className="min-w-0 flex-1 basis-40 truncate text-sm font-semibold hover:underline"
            >
              {agent.name}
            </Link>
            <span
              className="ui-chip inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-tiny text-muted-foreground"
              title={presence.detail}
            >
              <PresenceDot online={presence.online} />
              {statusLabel}
            </span>
          </div>
          {agent.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {agent.description}
            </p>
          )}
          <p className="mt-1 text-tiny text-muted-foreground">
            Signal: {signalLabel}
          </p>
          {(agent.statusText || currentTitle) && (
            <p className="mt-2 rounded-xl bg-muted/50 px-3 py-1.5 text-xs">
              <span className="font-medium">
                {presence.online ? "Now:" : "Last status:"}
              </span>{" "}
              {currentTitle && agent.currentTaskId ? (
                <span className="font-medium">{currentTitle}, </span>
              ) : null}
              {agent.statusText ?? "working"}
            </p>
          )}
        </div>
        {canManage && (
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
              className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
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
              className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <KeyRound className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delete agent"
              onClick={() => {
                setDeleting(true);
                toast(`${agent.name} deleted, keys stop working`, {
                  action: { label: "Undo", onClick: () => setDeleting(false) },
                  onExpire: () => remove({ agentId: agent._id }),
                });
              }}
              className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {showKeys && (
          <motion.div
            key="keys"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden px-5 pb-4"
          >
            <KeysPanel agentId={agent._id} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function KeysPanel({ agentId }: { agentId: Id<"agents"> }) {
  const keys = useQuery(api.agents.listKeys, { agentId });
  const createKey = useAction(api.agentKeys.createKey);
  const { toast } = useToast();
  const revokeKey = useMutation(api.agents.revokeKey);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="mt-3 space-y-2 rounded-2xl bg-muted/20 p-3">
      {freshKey && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">
            Copy this key now, it won&apos;t be shown again.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1">
              {freshKey}
            </code>
            <CopyButton
              value={freshKey}
              className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
            />
          </div>
        </motion.div>
      )}
      {(keys ?? []).length > 0 && (
        <div className="overflow-hidden rounded-xl bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-tiny uppercase tracking-wider">
                  Key
                </TableHead>
                <TableHead className="text-tiny uppercase tracking-wider">
                  Status
                </TableHead>
                <TableHead className="text-right text-tiny uppercase tracking-wider">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys!.map((k) => (
                <TableRow key={k._id}>
                  <TableCell className="font-mono text-xs">
                    {k.keyPrefix}…
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {k.revokedAt
                      ? "revoked"
                      : k.expired
                        ? "expired"
                        : k.lastUsedAt
                          ? `last used ${timeAgo(k.lastUsedAt)}`
                          : "never used"}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revokedAt && !k.expired && (
                      <button
                        type="button"
                        onClick={() =>
                          toast(`Key ${k.keyPrefix}… will be revoked`, {
                            action: { label: "Undo", onClick: () => {} },
                            onExpire: () => revokeKey({ keyId: k._id }),
                          })
                        }
                        className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-danger"
                      >
                        Revoke
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {keys !== undefined && keys.length === 0 && (
        <p className="text-xs text-muted-foreground">No keys yet.</p>
      )}
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
    return <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />;
  }
  if (events.length === 0) {
    return (
      <Card className="rounded-2xl p-10 text-center text-sm text-muted-foreground">
        No activity yet. Events appear here the moment agents (or teammates)
        create, claim, and complete work.
      </Card>
    );
  }

  return (
    <ul className="space-y-1.5">
      <AnimatePresence initial={false}>
      {events.map((e) => (
        <motion.li
          key={e._id}
          layout
          initial={{ opacity: 0, y: -10, filter: "blur(3px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.4, ease: EASE }}
          className="flex items-baseline gap-2 rounded-2xl panel px-3 py-2 text-sm"
        >
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-micro font-medium uppercase tracking-wider",
              e.actorType === "agent"
                ? "bg-brand-50 text-brand-700"
                : e.actorType === "system"
                  ? "bg-muted text-muted-foreground"
                  : "bg-muted text-foreground",
            )}
          >
            {e.actorName}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">
              {eventLabel(e.type)}{" "}
            </span>
            {(() => {
              const href = eventHref(e);
              return href ? (
                <Link href={href} className="font-medium hover:underline">
                  {e.entityTitle ?? "an item"}
                </Link>
              ) : (
                <span className="font-medium">{e.entityTitle ?? ""}</span>
              );
            })()}
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
        </motion.li>
      ))}
      </AnimatePresence>
    </ul>
  );
}

// ── Webhooks tab ───────────────────────────────────────────────────────

function WebhookDeliveryState({
  subscriptionId,
}: {
  subscriptionId: Id<"webhookSubscriptions">;
}) {
  const deliveries = useQuery(api.webhooks.recentDeliveries, {
    subscriptionId,
    limit: 1,
  });
  const delivery = deliveries?.[0];
  if (deliveries === undefined) {
    return <span className="text-xs text-muted-foreground">Checking…</span>;
  }
  if (!delivery) {
    return <span className="text-xs text-muted-foreground">No deliveries</span>;
  }
  const detail =
    delivery.responseStatus !== undefined
      ? `HTTP ${delivery.responseStatus}`
      : delivery.lastError
        ? "Network error"
        : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge
        variant="secondary"
        className={cn(
          "uppercase tracking-wider",
          delivery.status === "success"
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : delivery.status === "failed"
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
        )}
      >
        {delivery.status === "success"
          ? "Delivered"
          : delivery.status === "failed"
            ? "Failed"
            : delivery.attempts === 0
              ? "Queued"
              : `Retrying · ${delivery.attempts}/4`}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {[detail, timeAgo(delivery.completedAt ?? delivery.createdAt)]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}

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
  const { toast } = useToast();

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
        Get notified in your own systems the moment work changes: tasks,
        comments, mentions, and sprints can each ping any HTTPS endpoint you
        choose. Every delivery is signed so your endpoint can verify it came
        from us. Agents can register their own; those show up here too.
      </p>

      <form
        className="flex flex-wrap items-end gap-2 rounded-2xl panel p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!url.trim() || !user) return;
          try {
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
          } catch (e) {
            const raw = e instanceof Error ? e.message : String(e);
            toast(
              raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
                "Couldn't add webhook",
              { kind: "error" },
            );
          }
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
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Scope
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
            className="rounded-full bg-background px-3 py-1.5 text-sm"
          >
            <option value="personal">Personal space</option>
            {(agents?.workspaces ?? [])
              .filter((w) => w.canManageAgents)
              .map((w) => (
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
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <Button type="submit" size="sm" disabled={!url.trim()}>
          <Plus className="h-4 w-4" /> Add webhook
        </Button>
      </form>

      {freshSecret && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">
            Signing secret (copy now, shown once):
          </p>
          <code className="mt-1 block break-all rounded bg-muted px-2 py-1">
            {freshSecret}
          </code>
        </div>
      )}

      {(subs ?? []).length > 0 && (
        <Card className="gap-0 overflow-hidden rounded-2xl py-0">
          <CardContent className="px-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Last delivery</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Delete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subs!.map((s) => (
                <TableRow key={s._id}>
                  <TableCell className="max-w-[16rem] truncate font-mono text-xs">
                    {s.url}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="uppercase tracking-wider">
                      {s.eventTypes.length === 0
                        ? "all events"
                        : s.eventTypes.join(", ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {s.ownerType === "agent" ? (
                      <Badge className="bg-brand-50 text-brand-700 uppercase tracking-wider">
                        {agentNameById.get(s.ownerId) ?? "agent"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">You</span>
                    )}
                    {s.failureCount > 0 && (
                      <Badge
                        variant="secondary"
                        className="ml-1.5 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      >
                        {s.failureCount} fail{s.failureCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <WebhookDeliveryState subscriptionId={s._id} />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() =>
                        update({ subscriptionId: s._id, enabled: !s.enabled })
                      }
                      title={
                        s.disabledAt
                          ? "Auto-disabled after repeated delivery failures. Fix the endpoint, then click to reset and retry."
                          : s.enabled
                            ? "Pause webhook delivery"
                            : "Resume webhook delivery"
                      }
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-xs",
                        s.enabled
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : s.disabledAt
                            ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {s.enabled
                        ? "Enabled"
                        : s.disabledAt
                          ? "Auto-disabled"
                          : "Paused"}
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      onClick={() =>
                        toast("Webhook deleted", {
                          action: { label: "Undo", onClick: () => {} },
                          onExpire: () => remove({ subscriptionId: s._id }),
                        })
                      }
                      className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-danger"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </CardContent>
        </Card>
      )}
      {subs !== undefined && subs.length === 0 && (
        <Card className="rounded-2xl p-6 text-center text-sm text-muted-foreground">
          No webhooks yet.
        </Card>
      )}
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
          Skills are playbooks your agents read before they work: how your
          team triages, reviews, and ships. Built-ins come with the product.
          Write your own to teach agents your way of doing things.
        </p>
        <select
          value={scope}
          onChange={(e) => setScope(e.currentTarget.value)}
          className="rounded-full bg-background px-3 py-1.5 text-sm"
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
  const { toast } = useToast();

  return (
    <Card className="rounded-2xl p-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="font-medium">{skill.name}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-micro">
          {skill.slug}
        </code>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-micro uppercase tracking-wider",
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
              toast(`"${skill.name}" deleted`, {
                action: { label: "Undo", onClick: () => {} },
                onExpire: () => removeSkill({ skillId: skill._id! }),
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                toast(`"${skill.name}" deleted`, {
                  action: { label: "Undo", onClick: () => {} },
                  onExpire: () => removeSkill({ skillId: skill._id! }),
                });
              }
            }}
            className="tap-target ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-danger"
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
    </Card>
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
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  return (
    <form
      className="space-y-3 rounded-2xl panel p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !content.trim()) return;
        try {
          await create({
            ...scopeArgs,
            slug: name,
            name: name.trim(),
            description: description.trim(),
            content,
          });
          onDone();
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          toast(
            raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Couldn't create skill",
            { kind: "error" },
          );
        }
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
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
            className="w-full rounded-full bg-background px-3 py-1.5 text-sm"
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
          className="w-full rounded-2xl soft-field p-4 text-sm"
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
