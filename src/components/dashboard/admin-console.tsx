"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  Bot,
  Building2,
  Check,
  Pause,
  Play,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import {
  AnimatedNumber,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Platform admin console. A single cohesive surface with sub-tabs (like
// the workspace + agents views) instead of many routes. Every data call
// is a platform-admin Convex function; the client only orchestrates.

type Tab =
  | "overview"
  | "users"
  | "workspaces"
  | "agents"
  | "billing"
  | "audit"
  | "security"
  | "admins";

const TABS: { key: Tab; label: string; icon: typeof Users }[] = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "users", label: "Users", icon: Users },
  { key: "workspaces", label: "Workspaces", icon: Building2 },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "billing", label: "Billing", icon: Wallet },
  { key: "audit", label: "Audit log", icon: Shield },
  { key: "security", label: "Security", icon: ShieldCheck },
  { key: "admins", label: "Admins", icon: Shield },
];

export function AdminConsole() {
  const me = useQuery(api.admin.me, {});
  const [tab, setTab] = useState<Tab>("overview");
  const isSuper = me?.role === "superadmin";

  return (
    <div className="space-y-6">
      <header className="title-rule flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Admin console
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Platform oversight, security posture, and a complete audit trail.
          </p>
        </div>
        {me && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
            <ShieldCheck className="h-3.5 w-3.5" />
            {me.role === "superadmin" ? "Superadmin" : "Support admin"}
            {me.viaEnv && " · root"}
          </span>
        )}
      </header>

      {/* Scrollable pill tab row (mobile-safe). */}
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-8 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <nav
          aria-label="Admin sections"
          className="segmented whitespace-nowrap text-sm"
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
                  ? "segmented-on font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        {tab === "overview" ? (
          <OverviewTab />
        ) : tab === "users" ? (
          <UsersTab />
        ) : tab === "workspaces" ? (
          <WorkspacesTab />
        ) : tab === "agents" ? (
          <AgentsTab />
        ) : tab === "billing" ? (
          <BillingAdminTab isSuper={isSuper} />
        ) : tab === "audit" ? (
          <AuditTab />
        ) : tab === "security" ? (
          <SecurityTab isSuper={isSuper} />
        ) : (
          <AdminsTab isSuper={isSuper} />
        )}
      </motion.div>
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const data = useQuery(api.admin.overview, {});
  if (data === undefined) return <SkeletonGrid n={6} />;

  const tiles = [
    { label: "Users", value: data.users.total, sub: `${data.users.onboarded} onboarded` },
    { label: "Suspended users", value: data.users.suspended, sub: "account holds", warn: data.users.suspended > 0 },
    { label: "Workspaces", value: data.workspaces.total, sub: `${data.workspaces.suspended} suspended`, warn: data.workspaces.suspended > 0 },
    { label: "Agents", value: data.agents.total, sub: `${data.agents.online} online now` },
    { label: "Paused agents", value: data.agents.paused, sub: "kill-switched" },
    { label: "Agent runs · 24h", value: data.runsToday.total, sub: `${data.runsToday.failed} failed`, warn: data.runsToday.failed > 0 },
  ];

  return (
    <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {tiles.map((t) => (
        <StaggerItem
          key={t.label}
          className="rounded-2xl bento p-5"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t.label}
          </p>
          <p
            className={cn(
              "mt-2 text-3xl font-bold tabular-nums tracking-tight",
              t.warn && "text-amber-600",
            )}
          >
            <AnimatedNumber value={t.value} />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t.sub}</p>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [search, setSearch] = useState("");
  const users = useQuery(api.admin.listUsers, { search: search || undefined });
  const suspend = useMutation(api.admin.suspendUser);
  const reactivate = useMutation(api.admin.reactivateUser);
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <SearchBar value={search} onChange={setSearch} placeholder="Search users by email or name…" />
      {users === undefined ? (
        <SkeletonRows />
      ) : users.length === 0 ? (
        <Empty label="No users match." />
      ) : (
        <ul className="space-y-2">
          {users.map((u) => (
            <li
              key={u._id}
              className="flex flex-wrap items-center gap-3 rounded-2xl bento px-4 py-3"
            >
              <Avatar name={u.name ?? u.email} img={u.imageUrl} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {u.name ?? u.email.split("@")[0]}
                  {u.suspendedAt && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                      Suspended
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {u.email} · {u.workspaceCount} workspace
                  {u.workspaceCount === 1 ? "" : "s"} · joined{" "}
                  {timeAgo(u.createdAt)}
                </p>
                {u.suspendedReason && (
                  <p className="mt-0.5 truncate text-xs text-red-600">
                    Reason: {u.suspendedReason}
                  </p>
                )}
              </div>
              {u.suspendedAt ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await reactivate({ clerkId: u.clerkId });
                    toast(`Reactivated ${u.email}`);
                  }}
                >
                  <Play className="h-3.5 w-3.5" /> Reactivate
                </Button>
              ) : (
                <ReasonAction
                  label="Suspend"
                  danger
                  placeholder="Reason for suspension (audited)…"
                  onConfirm={async (reason) => {
                    try {
                      await suspend({ clerkId: u.clerkId, reason });
                      toast(`Suspended ${u.email}`);
                    } catch (e) {
                      toast(errMsg(e), { kind: "error" });
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Workspaces ───────────────────────────────────────────────────────────

function WorkspacesTab() {
  const [search, setSearch] = useState("");
  const rows = useQuery(api.admin.listWorkspaces, { search: search || undefined });
  const suspend = useMutation(api.admin.suspendWorkspace);
  const reactivate = useMutation(api.admin.reactivateWorkspace);
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <SearchBar value={search} onChange={setSearch} placeholder="Search workspaces…" />
      {rows === undefined ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <Empty label="No workspaces match." />
      ) : (
        <ul className="space-y-2">
          {rows.map((w) => (
            <li
              key={w._id}
              className="flex flex-wrap items-center gap-3 rounded-2xl bento px-4 py-3"
            >
              <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <Building2 className="h-4 w-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {w.name}
                  {w.suspendedAt && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                      Suspended
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {w.memberCount} member{w.memberCount === 1 ? "" : "s"} ·{" "}
                  {w.agentCount} agent{w.agentCount === 1 ? "" : "s"} · created{" "}
                  {timeAgo(w.createdAt)}
                </p>
              </div>
              {w.suspendedAt ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await reactivate({ workspaceId: w._id });
                    toast(`Reactivated ${w.name}`);
                  }}
                >
                  <Play className="h-3.5 w-3.5" /> Reactivate
                </Button>
              ) : (
                <ReasonAction
                  label="Suspend"
                  danger
                  placeholder="Reason for suspension (audited)…"
                  onConfirm={async (reason) => {
                    try {
                      await suspend({ workspaceId: w._id, reason });
                      toast(`Suspended ${w.name}`);
                    } catch (e) {
                      toast(errMsg(e), { kind: "error" });
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Agents ───────────────────────────────────────────────────────────────

function AgentsTab() {
  const rows = useQuery(api.admin.listAgents, {});
  const setStatus = useMutation(api.admin.setAgentStatus);
  const { toast } = useToast();

  if (rows === undefined) return <SkeletonRows />;
  if (rows.length === 0) return <Empty label="No agents on the platform yet." />;

  return (
    <ul className="space-y-2">
      {rows.map((a) => (
        <li
          key={a._id}
          className="flex flex-wrap items-center gap-3 rounded-2xl bento px-4 py-3"
        >
          <span className="text-xl" aria-hidden>
            {a.emoji ?? "🤖"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 truncate text-sm font-medium">
              {a.name}
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                  a.status === "paused"
                    ? "bg-muted text-muted-foreground"
                    : a.online
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {a.status === "paused" ? "Paused" : a.online ? "Online" : "Offline"}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {a.role}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {a.parentType} · {a.activeKeys} active key
              {a.activeKeys === 1 ? "" : "s"}
              {a.lastSeenAt ? ` · seen ${timeAgo(a.lastSeenAt)}` : " · never connected"}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const next = a.status === "active" ? "paused" : "active";
              await setStatus({ agentId: a._id, status: next });
              toast(`${next === "paused" ? "Paused" : "Resumed"} ${a.name}`);
            }}
          >
            {a.status === "active" ? (
              <>
                <Pause className="h-3.5 w-3.5" /> Pause
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" /> Resume
              </>
            )}
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ── Audit log ────────────────────────────────────────────────────────────

const ACTION_STYLE: Record<string, string> = {
  suspended: "bg-red-100 text-red-700",
  reactivated: "bg-emerald-100 text-emerald-700",
  granted: "bg-brand-50 text-brand-700",
  revoked: "bg-amber-100 text-amber-700",
  break_glass: "bg-amber-100 text-amber-700",
};

function auditTone(action: string): string {
  for (const [k, v] of Object.entries(ACTION_STYLE)) {
    if (action.includes(k)) return v;
  }
  return "bg-muted text-muted-foreground";
}

function AuditTab() {
  const rows = useQuery(api.admin.auditLog, { limit: 200 });
  if (rows === undefined) return <SkeletonRows />;
  if (rows.length === 0)
    return <Empty label="No admin actions recorded yet." />;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r._id}
          className="flex flex-wrap items-baseline gap-2 rounded-2xl bento px-4 py-2.5 text-sm"
        >
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
              auditTone(r.action),
            )}
          >
            {r.action}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{r.actorEmail}</span>
            {r.summary && (
              <span className="text-muted-foreground"> · {r.summary}</span>
            )}
            {r.reason && (
              <span className="text-muted-foreground">, “{r.reason}”</span>
            )}
          </span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            {timeAgo(r.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Billing (x402 revenue + metering) ────────────────────────────────────

function BillingAdminTab({ isSuper }: { isSuper: boolean }) {
  const data = useQuery(api.x402.platformRevenue, {});
  const setConfig = useMutation(api.x402.setMeteringConfig);
  const { toast } = useToast();

  if (data === undefined) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted/40" />
          ))}
        </div>
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  const { metering, pricing } = data;

  return (
    <div className="space-y-6">
      <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StaggerItem className="rounded-2xl bento p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Credits sold
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
            <AnimatedNumber value={data.totalCreditsSold} />
          </p>
        </StaggerItem>
        <StaggerItem className="rounded-2xl bento p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Settled payments
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
            <AnimatedNumber value={data.settledCount} />
          </p>
        </StaggerItem>
        <StaggerItem className="rounded-2xl bento p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Funded wallets
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
            <AnimatedNumber value={data.walletCount} />
          </p>
        </StaggerItem>
        <StaggerItem className="rounded-2xl bento p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Metering
          </p>
          <p className="mt-2 text-lg font-semibold">
            {metering.enabled ? "On" : "Off"}
          </p>
          <p className="text-xs text-muted-foreground">
            {metering.actionCredits} credit
            {metering.actionCredits === 1 ? "" : "s"}/action
          </p>
        </StaggerItem>
      </Stagger>

      {/* Metering config, superadmin only, since it changes what every
          agent is charged platform-wide. */}
      <div className="rounded-2xl bento p-5">
        <h3 className="text-sm font-semibold">Metering</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          When on, each metered agent write action consumes credits from its
          scope wallet. Agents top up via x402. Priced in {pricing.assetSymbol}{" "}
          on {pricing.network}.
        </p>
        {isSuper ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Charge agents per action</p>
                <p className="text-xs text-muted-foreground">
                  Turns credit metering on across the platform.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={metering.enabled}
                onClick={async () => {
                  try {
                    await setConfig({ enabled: !metering.enabled });
                    toast(
                      `Metering ${!metering.enabled ? "enabled" : "disabled"}`,
                    );
                  } catch (e) {
                    toast(errMsg(e), { kind: "error" });
                  }
                }}
                className={cn(
                  "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors",
                  metering.enabled ? "bg-foreground" : "bg-border",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
                    metering.enabled ? "translate-x-[1.375rem]" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
            <NumberSetting
              label="Credits per action"
              hint="Consumed on each metered write. 0 = free."
              value={metering.actionCredits}
              onSave={async (v) => {
                try {
                  await setConfig({ actionCredits: v });
                  toast("Saved");
                } catch (e) {
                  toast(errMsg(e), { kind: "error" });
                }
              }}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Only a superadmin can change metering.
          </p>
        )}
      </div>

      {/* Recent settlements */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent settlements
        </h3>
        {data.recent.length === 0 ? (
          <div className="mt-3 rounded-2xl bento p-8 text-center text-sm text-muted-foreground">
            No payments yet.
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl bento">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Scope</th>
                  <th scope="col" className="px-4 py-2.5">Credits</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((p, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {p.scopeType}
                    </td>
                    <td className="px-4 py-2.5 font-medium tabular-nums">
                      {p.status === "settled"
                        ? `+${p.creditsGranted.toLocaleString()}`
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          p.status === "settled"
                            ? "bg-pastel-green text-foreground"
                            : "bg-pastel-red text-foreground",
                        )}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                      {timeAgo(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Security posture ─────────────────────────────────────────────────────

function SecurityTab({ isSuper }: { isSuper: boolean }) {
  const posture = useQuery(api.admin.securityPosture, {});
  if (posture === undefined) return <SkeletonRows />;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Security posture
        </h2>
        <ul className="space-y-2">
          {posture.checks.map((c) => (
            <li
              key={c.key}
              className="flex items-start gap-3 rounded-2xl bento px-4 py-3"
            >
              <span
                className={cn(
                  "mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full",
                  c.status === "pass"
                    ? "bg-emerald-100 text-emerald-700"
                    : c.status === "warn"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-red-100 text-red-700",
                )}
              >
                {c.status === "pass" ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : (
                  <X className="h-3.5 w-3.5" strokeWidth={3} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {c.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {isSuper && <SettingsPanel settings={posture.settings} />}
    </div>
  );
}

function SettingsPanel({ settings }: { settings: Record<string, unknown> }) {
  const setSetting = useMutation(api.admin.setSecuritySetting);
  const { toast } = useToast();
  const idle = Number(settings["session_idle_minutes"] ?? 0);
  const maxAgents = Number(settings["max_agents_per_workspace"] ?? 0);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Platform policy
      </h2>
      <div className="space-y-3 rounded-2xl bento p-4">
        <NumberSetting
          label="Session idle timeout (minutes)"
          hint="0 disables the platform-wide idle policy."
          value={idle}
          onSave={async (v) => {
            await setSetting({ key: "session_idle_minutes", value: v });
            toast("Session policy saved");
          }}
        />
        <NumberSetting
          label="Max agents per workspace"
          hint="0 means unlimited."
          value={maxAgents}
          onSave={async (v) => {
            await setSetting({ key: "max_agents_per_workspace", value: v });
            toast("Agent cap saved");
          }}
        />
      </div>
    </section>
  );
}

function NumberSetting({
  label,
  hint,
  value,
  onSave,
}: {
  label: string;
  hint: string;
  value: number;
  onSave: (v: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          className="w-24 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={Number(draft) === value}
          onClick={() => onSave(Number(draft) || 0)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ── Admin roster ─────────────────────────────────────────────────────────

function AdminsTab({ isSuper }: { isSuper: boolean }) {
  const rows = useQuery(api.admin.listAdmins, {});
  const grant = useMutation(api.admin.grantAdmin);
  const revoke = useMutation(api.admin.revokeAdmin);
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"superadmin" | "support">("support");

  return (
    <div className="space-y-5">
      {!isSuper && (
        <p className="rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          Only superadmins can grant or revoke admin access. You have read
          access to the roster.
        </p>
      )}

      {isSuper && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-2xl bento p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!email.trim()) return;
            try {
              await grant({ email: email.trim(), role });
              toast(`Granted ${role} to ${email.trim()}`);
              setEmail("");
            } catch (err) {
              toast(errMsg(err), { kind: "error" });
            }
          }}
        >
          <label className="block min-w-52 flex-1">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Grant admin to (email)
            </span>
            <input
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="teammate@company.com"
              className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Role
            </span>
            <select
              value={role}
              onChange={(e) =>
                setRole(e.currentTarget.value as "superadmin" | "support")
              }
              className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="support">Support (read + holds)</option>
              <option value="superadmin">Superadmin (full)</option>
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!email.trim()}>
            Grant
          </Button>
        </form>
      )}

      {rows === undefined ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <Empty label="No in-app admins granted. Root admins come from the deployment allowlist." />
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li
              key={a._id}
              className="flex flex-wrap items-center gap-3 rounded-2xl bento px-4 py-3"
            >
              <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <Shield className="h-4 w-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{a.email}</p>
                <p className="text-xs text-muted-foreground">
                  {a.role} · granted {timeAgo(a.createdAt)}
                </p>
              </div>
              {isSuper && (
                <button
                  type="button"
                  aria-label="Revoke admin"
                  onClick={async () => {
                    try {
                      await revoke({ adminId: a._id as Id<"platformAdmins"> });
                      toast(`Revoked ${a.email}`);
                    } catch (err) {
                      toast(errMsg(err), { kind: "error" });
                    }
                  }}
                  className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

function ReasonAction({
  label,
  placeholder,
  onConfirm,
  danger,
}: {
  label: string;
  placeholder: string;
  onConfirm: (reason: string) => void | Promise<void>;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className={cn(danger && "hover:border-red-300 hover:text-red-600")}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      className="flex w-full items-center gap-2 sm:w-auto"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!reason.trim() || pending) return;
        setPending(true);
        try {
          await onConfirm(reason.trim());
          setOpen(false);
          setReason("");
        } finally {
          setPending(false);
        }
      }}
    >
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 sm:w-64"
      />
      <Button
        type="submit"
        size="sm"
        disabled={!reason.trim() || pending}
        className={cn(danger && "bg-red-600 hover:bg-red-600/85")}
      >
        {pending ? "…" : "Confirm"}
      </Button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          setOpen(false);
          setReason("");
        }}
        className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </form>
  );
}

function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2">
      <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm focus:outline-none"
      />
    </div>
  );
}

function Avatar({ name, img }: { name: string; img?: string }) {
  if (img) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={img}
        alt=""
        className="h-9 w-9 flex-shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white">
      {(Array.from(name.trim())[0] ?? "?").toUpperCase()}
    </span>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-2xl bento p-10 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-2xl border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}

function SkeletonGrid({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-2xl border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}

function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || "Something went wrong";
}
