"use client";

import { useState } from "react";
import type { ReactNode } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/dashboard/page-header";
import { Pagination } from "@/components/interior/pagination";
import { cn } from "@/lib/utils";
import { identityFill } from "@/lib/identity-color";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import {
  AnimatedNumber,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { ActorGlyph } from "@/components/appearance/actor-glyph";

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
      <PageHeader
        icon={ShieldCheck}
        title="Admin"
        actions={
          me && (
            <Badge className="gap-1">
              <ShieldCheck className="h-3 w-3" />
              {me.role === "superadmin" ? "Superadmin" : "Support admin"}
              {me.viaEnv && " · root"}
            </Badge>
          )
        }
      >
        {/* Scrollable tab row, template grammar: rounded-md active fill
            instead of a pill-style toggle. */}
        <nav
          aria-label="Admin sections"
          className="flex items-center gap-1 overflow-x-auto overscroll-x-contain pb-3 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-current={tab === key ? "page" : undefined}
              className={cn(
                "inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
                tab === key
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
      </PageHeader>

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
          <AgentsTab isSuper={isSuper} />
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
    {
      label: "Users",
      value: data.users.total,
      sub: `${data.users.onboarded} onboarded`,
    },
    {
      label: "Suspended users",
      value: data.users.suspended,
      sub: "account holds",
      warn: data.users.suspended > 0,
    },
    {
      label: "Workspaces",
      value: data.workspaces.total,
      sub: `${data.workspaces.suspended} suspended`,
      warn: data.workspaces.suspended > 0,
    },
    {
      label: "Agents",
      value: data.agents.total,
      sub: `${data.agents.online} online now`,
    },
    { label: "Paused agents", value: data.agents.paused, sub: "kill-switched" },
    {
      label: "Agent runs · 24h",
      value: data.runsToday.total,
      sub: `${data.runsToday.failed} failed`,
      warn: data.runsToday.failed > 0,
    },
  ];

  return (
    <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((t) => (
        <StaggerItem key={t.label}>
          <Card className="gap-2 py-5">
            <CardHeader className="px-5">
              <CardDescription className="text-xs font-semibold uppercase tracking-wider">
                {t.label}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <p
                className={cn(
                  "text-3xl font-bold tabular-nums tracking-tight",
                  t.warn && "text-destructive",
                )}
              >
                <AnimatedNumber value={t.value} />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t.sub}</p>
            </CardContent>
          </Card>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const users = useQuery(api.admin.listUsers, { search: search || undefined });
  const suspend = useMutation(api.admin.suspendUser);
  const reactivate = useMutation(api.admin.reactivateUser);
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Search users by email or name…"
      />
      {users === undefined ? (
        <SkeletonRows />
      ) : users.length === 0 ? (
        <Empty label="No users match." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Workspaces</TableHead>
                <TableHead>Credits</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow
                  key={u._id}
                  className={cn(
                    "cursor-pointer",
                    selected === u.clerkId && "bg-accent/40",
                  )}
                  onClick={() =>
                    setSelected((cur) =>
                      cur === u.clerkId ? null : u.clerkId,
                    )
                  }
                >
                  <TableCell className="whitespace-normal">
                    <div className="flex items-center gap-3">
                      <Avatar name={u.name ?? u.email} img={u.imageUrl} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {u.name ?? u.email.split("@")[0]}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {u.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.workspaceCount} workspace
                    {u.workspaceCount === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {u.creditBalance.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timeAgo(u.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {u.suspendedAt ? (
                        <Badge variant="destructive">Suspended</Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          Active
                        </Badge>
                      )}
                      {u.complimentary && (
                        <Badge className="border-transparent bg-pastel-yellow text-foreground dark:text-black">
                          Complimentary
                        </Badge>
                      )}
                    </div>
                    {u.suspendedReason && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {u.suspendedReason}
                      </p>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
      {selected && <UserAccountPanel clerkId={selected} />}
    </div>
  );
}

function UserAccountPanel({ clerkId }: { clerkId: string }) {
  const account = useQuery(api.admin.getUserAccount, { clerkId });
  const grant = useMutation(api.admin.grantCredits);
  const refund = useMutation(api.admin.refundCredits);
  const debit = useMutation(api.admin.debitCredits);
  const me = useQuery(api.admin.me, {});
  const { toast } = useToast();
  const isSuper = me?.role === "superadmin";
  const [credits, setCredits] = useState("1000");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("personal");
  const [pending, setPending] = useState<"grant" | "refund" | "debit" | null>(
    null,
  );

  if (account === undefined) return <SkeletonRows />;

  const scope =
    target === "personal"
      ? { scopeType: "user" as const, scopeId: account.clerkId }
      : { scopeType: "workspace" as const, scopeId: target };

  async function run(
    kind: "grant" | "refund" | "debit",
    fn: () => Promise<{ applied: number }>,
  ) {
    if (!reason.trim()) {
      toast("A reason is required", { kind: "error" });
      return;
    }
    setPending(kind);
    try {
      const result = await fn();
      toast(
        `${kind === "debit" ? "Debited" : kind === "refund" ? "Refunded" : "Granted"} ${result.applied.toLocaleString()} credits`,
      );
      setReason("");
    } catch (e) {
      toast(errMsg(e), { kind: "error" });
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">
            {account.name ?? account.email}
          </CardTitle>
          <CardDescription className="mt-0.5">{account.email}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {account.complimentary && (
            <Badge className="border-transparent bg-pastel-yellow text-foreground dark:text-black">
              Complimentary · unlimited
            </Badge>
          )}
          {account.adminRole && (
            <Badge variant="outline" className="capitalize">
              {account.adminRole}
            </Badge>
          )}
        </div>
      </div>

      {account.complimentary && (
        <p className="mt-3 text-sm text-muted-foreground">
          This is an owner-admin account: unpaid, no agent cap, no workspace
          cap, no action-budget cap, and no credit metering.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Personal credits
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {account.personal.creditBalance.toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Personal agents
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {account.personal.agentCount}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Workspaces
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {account.workspaces.length}
          </p>
        </div>
      </div>

      {account.workspaces.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Workspaces
          </h3>
          <ul className="divide-y divide-border rounded-xl bg-muted/30">
            {account.workspaces.map((w) => (
              <li
                key={w._id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">
                  {w.name}
                  {w.owner ? " · owner" : ` · ${w.role}`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {w.agentCount} agent{w.agentCount === 1 ? "" : "s"} ·{" "}
                  {w.creditBalance.toLocaleString()} credits
                  {w.complimentary ? " · complimentary" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Separator className="my-5" />

      <h3 className="text-sm font-semibold">Credits</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Grants and refunds are complimentary top-ups. Every adjustment is
        audited. Debits (clawbacks) are superadmin only.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Wallet
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="personal">Personal space</option>
            {account.workspaces.map((w) => (
              <option key={w._id} value={w._id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Credits
          </span>
          <Input
            type="number"
            min={1}
            value={credits}
            onChange={(e) => setCredits(e.currentTarget.value)}
            className="w-28"
          />
        </label>
        <label className="block min-w-52 flex-1">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Reason (audited)
          </span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            placeholder="Goodwill, failed top-up, support ticket…"
          />
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!reason.trim() || pending !== null}
          onClick={() =>
            run("grant", () =>
              grant({
                ...scope,
                credits: Number(credits) || 0,
                reason: reason.trim(),
              }),
            )
          }
        >
          {pending === "grant" ? "…" : "Give credits"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!reason.trim() || pending !== null}
          onClick={() =>
            run("refund", () =>
              refund({
                ...scope,
                credits: Number(credits) || 0,
                reason: reason.trim(),
              }),
            )
          }
        >
          {pending === "refund" ? "…" : "Issue refund"}
        </Button>
        {isSuper && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="hover:border-destructive/40 hover:text-destructive"
            disabled={!reason.trim() || pending !== null}
            onClick={() =>
              run("debit", () =>
                debit({
                  ...scope,
                  credits: Number(credits) || 0,
                  reason: reason.trim(),
                }),
              )
            }
          >
            {pending === "debit" ? "…" : "Debit"}
          </Button>
        )}
      </form>

      {account.payments.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent payments
          </h3>
          <ul className="divide-y divide-border text-sm">
            {account.payments.slice(0, 8).map((p) => (
              <li
                key={p._id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  {p.scopeType} · {p.creditsGranted.toLocaleString()} credits
                  <span className="text-muted-foreground"> · {p.status}</span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(p.createdAt)}
                  </span>
                  {p.status === "settled" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending !== null}
                      onClick={() => {
                        const why = reason.trim() || "Refund of settled payment";
                        run("refund", () =>
                          refund({ paymentId: p._id, reason: why }),
                        );
                      }}
                    >
                      Refund
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {account.adjustments.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Staff adjustments
          </h3>
          <ul className="divide-y divide-border text-sm">
            {account.adjustments.slice(0, 8).map((a) => (
              <li
                key={a._id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  <span className="capitalize">{a.kind}</span>{" "}
                  {a.kind === "debit" ? "−" : "+"}
                  {a.credits.toLocaleString()}
                  <span className="text-muted-foreground">
                    {" "}
                    · {a.reason}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {timeAgo(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ── Workspaces ───────────────────────────────────────────────────────────

function WorkspacesTab() {
  const [search, setSearch] = useState("");
  const rows = useQuery(api.admin.listWorkspaces, {
    search: search || undefined,
  });
  const suspend = useMutation(api.admin.suspendWorkspace);
  const reactivate = useMutation(api.admin.reactivateWorkspace);
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Search workspaces…"
      />
      {rows === undefined ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <Empty label="No workspaces match." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => (
                <TableRow key={w._id}>
                  <TableCell className="whitespace-normal">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                      </span>
                      <p className="truncate text-sm font-medium">{w.name}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {w.memberCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {w.agentCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timeAgo(w.createdAt)}
                  </TableCell>
                  <TableCell>
                    {w.suspendedAt ? (
                      <Badge variant="destructive">Suspended</Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground"
                      >
                        Active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </div>
  );
}

// ── Agents ───────────────────────────────────────────────────────────────

function AgentsTab({ isSuper }: { isSuper: boolean }) {
  const rows = useQuery(api.admin.listAgents, {});
  const setStatus = useMutation(api.admin.setAgentStatus);
  const { toast } = useToast();

  if (rows === undefined) return <SkeletonRows />;
  if (rows.length === 0)
    return <Empty label="No agents on the platform yet." />;

  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Keys</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <TableRow key={a._id}>
              <TableCell className="whitespace-normal">
                <div className="flex items-center gap-3">
                  <ActorGlyph seed={a._id} name={a.name} size="sm" isAgent />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium">
                      {a.name}
                      <Badge
                        className={cn(
                          "border-transparent",
                          a.status === "paused"
                            ? "bg-muted text-muted-foreground"
                            : a.online
                              ? "bg-pastel-green text-foreground dark:text-black"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {a.status === "paused"
                          ? "Paused"
                          : a.online
                            ? "Online"
                            : "Offline"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="uppercase tracking-wider text-muted-foreground"
                      >
                        {a.role}
                      </Badge>
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {a.parentType}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {a.activeKeys} active key{a.activeKeys === 1 ? "" : "s"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {a.lastSeenAt ? timeAgo(a.lastSeenAt) : "Never connected"}
              </TableCell>
              <TableCell className="text-right">
                {isSuper ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const next = a.status === "active" ? "paused" : "active";
                      try {
                        await setStatus({ agentId: a._id, status: next });
                        toast(
                          `${next === "paused" ? "Paused" : "Resumed"} ${a.name}`,
                        );
                      } catch (e) {
                        toast(errMsg(e), { kind: "error" });
                      }
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
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Superadmin only
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}

// ── Audit log ────────────────────────────────────────────────────────────

const ACTION_STYLE: Record<string, string> = {
  suspended: "bg-pastel-red text-foreground dark:text-black",
  reactivated: "bg-pastel-green text-foreground dark:text-black",
  granted: "bg-pastel-blue text-foreground dark:text-black",
  revoked: "bg-pastel-yellow text-foreground dark:text-black",
  break_glass: "bg-pastel-yellow text-foreground dark:text-black",
};

function auditTone(action: string): string {
  for (const [k, v] of Object.entries(ACTION_STYLE)) {
    if (action.includes(k)) return v;
  }
  return "bg-muted text-muted-foreground";
}

const AUDIT_PAGE_SIZE = 25;

function AuditTab() {
  const rows = useQuery(api.admin.auditLog, { limit: 200 });
  // Local rather than in the URL, unlike the projects directory: the admin
  // tabs are not addressable per-page, so a ?page= here would be a parameter
  // that outlives the tab it belongs to.
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil((rows?.length ?? 0) / AUDIT_PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = (rows ?? []).slice(
    (current - 1) * AUDIT_PAGE_SIZE,
    current * AUDIT_PAGE_SIZE,
  );
  if (rows === undefined) return <SkeletonRows />;
  if (rows.length === 0)
    return <Empty label="No admin actions recorded yet." />;
  return (
    <>
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>Actor &amp; detail</TableHead>
            <TableHead className="text-right">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((r) => (
            <TableRow key={r._id}>
              <TableCell>
                <Badge
                  className={cn("border-transparent", auditTone(r.action))}
                >
                  {r.action}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-normal">
                <span className="font-medium">{r.actorEmail}</span>
                {r.summary && (
                  <span className="text-muted-foreground"> · {r.summary}</span>
                )}
                {r.reason && (
                  <span className="text-muted-foreground">
                    , &ldquo;{r.reason}&rdquo;
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {timeAgo(r.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
    <Pagination
      count={pageCount}
      page={current}
      label="Audit log"
      onPageChange={setPage}
      className="pt-3"
    />
    </>
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
        <SkeletonGrid n={4} />
        <Card className="h-40 animate-pulse bg-muted/30" />
      </div>
    );
  }

  const { metering, pricing } = data;

  return (
    <div className="space-y-6">
      <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <StaggerItem>
          <Card className="gap-1 p-4">
            <CardDescription className="text-tiny font-medium uppercase tracking-wider">
              Credits sold
            </CardDescription>
            <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
              <AnimatedNumber value={data.totalCreditsSold} />
            </p>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card className="gap-1 p-4">
            <CardDescription className="text-tiny font-medium uppercase tracking-wider">
              Settled payments
            </CardDescription>
            <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
              <AnimatedNumber value={data.settledCount} />
            </p>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card className="gap-1 p-4">
            <CardDescription className="text-tiny font-medium uppercase tracking-wider">
              Funded wallets
            </CardDescription>
            <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
              <AnimatedNumber value={data.walletCount} />
            </p>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card className="gap-1 p-4">
            <CardDescription className="text-tiny font-medium uppercase tracking-wider">
              Metering
            </CardDescription>
            <p className="mt-2 text-lg font-semibold">
              {metering.enabled ? "On" : "Off"}
            </p>
            <p className="text-xs text-muted-foreground">
              {metering.actionCredits} credit
              {metering.actionCredits === 1 ? "" : "s"}/action
            </p>
          </Card>
        </StaggerItem>
      </Stagger>

      <Card className="p-5">
        <CardTitle className="text-sm font-semibold">Help a wallet</CardTitle>
        <CardDescription className="mt-1 text-sm">
          Open a user on the Users tab to give credits, issue a refund, or
          claw back a mistaken grant. Every adjustment is audited.
        </CardDescription>
      </Card>

      {/* Metering config, superadmin only, since it changes what every
          agent is charged platform-wide. */}
      <Card className="p-5">
        <CardTitle className="text-sm font-semibold">Metering</CardTitle>
        <CardDescription className="mt-1 text-sm">
          When on, each metered agent write action consumes credits from its
          scope wallet. Agents top up via x402. Priced in {pricing.assetSymbol}{" "}
          on {pricing.network}.
        </CardDescription>
        {!pricing.available && (
          <div className="mt-3 rounded-md bg-pastel-red px-3 py-2 text-sm text-foreground dark:text-black">
            Payment setup incomplete: {pricing.configurationIssue}. Metering
            cannot be enabled until the facilitator and receiving wallet are
            configured.
          </div>
        )}
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
                disabled={!pricing.available && !metering.enabled}
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
                  "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  metering.enabled ? "bg-foreground" : "bg-border",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
                    metering.enabled
                      ? "translate-x-[1.375rem]"
                      : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
            <Separator />
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
      </Card>

      {/* Recent settlements */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent settlements
        </h3>
        {data.recent.length === 0 ? (
          <Empty label="No payments yet." />
        ) : (
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scope</TableHead>
                  <TableHead>Credits</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent.map((p, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">
                      {p.scopeType}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {p.status === "settled"
                        ? `+${p.creditsGranted.toLocaleString()}`
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          "border-transparent",
                          p.status === "settled"
                            ? "bg-pastel-green text-foreground dark:text-black"
                            : "bg-pastel-red text-foreground dark:text-black",
                        )}
                      >
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {timeAgo(p.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </div>
    </div>
  );
}

// ── Security posture ─────────────────────────────────────────────────────

function SecurityTab({ isSuper }: { isSuper: boolean }) {
  const posture = useQuery(api.admin.securityPosture, {});
  if (posture === undefined) return <SkeletonGrid n={4} />;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Security posture
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {posture.checks.map((c) => (
            <Card key={c.key} className="flex-row items-start gap-3 px-4 py-3">
              <span
                className={cn(
                  "mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full",
                  c.status === "pass"
                    ? "bg-pastel-green text-foreground dark:text-black"
                    : c.status === "warn"
                      ? "bg-pastel-yellow text-foreground dark:text-black"
                      : "bg-pastel-red text-foreground dark:text-black",
                )}
              >
                {c.status === "pass" ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : (
                  <X className="h-3.5 w-3.5" strokeWidth={3} />
                )}
              </span>
              <CardContent className="min-w-0 flex-1 p-0">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {c.detail}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
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
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Platform policy
      </h2>
      <Card className="p-4">
        <div className="space-y-4">
          <NumberSetting
            label="Session idle timeout (minutes)"
            hint="Stored for future use — not yet enforced anywhere in the app."
            value={idle}
            onSave={async (v) => {
              await setSetting({ key: "session_idle_minutes", value: v });
              toast("Session policy saved");
            }}
          />
          <Separator />
          <NumberSetting
            label="Max agents per workspace"
            hint="Applies to personal spaces and workspaces. Unset uses the Starter default of 3. 0 = unlimited for ordinary accounts. Owner-admin scopes are never capped."
            value={maxAgents}
            onSave={async (v) => {
              await setSetting({ key: "max_agents_per_workspace", value: v });
              toast("Agent cap saved");
            }}
          />
        </div>
      </Card>
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
        <Input
          type="number"
          min={0}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          className="w-24"
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
      <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
        Admin accounts are complimentary — unpaid, unlimited agents, and no
        credit metering. A safety ceiling (100,000 actions/day, 600/minute)
        still stops a rogue agent.{" "}
        {!isSuper &&
          "Only superadmins can grant or revoke admin access. You have read access to the roster."}
      </p>

      {isSuper && (
        <Card className="p-4">
          <form
            className="flex flex-wrap items-end gap-2"
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
              <Input
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                placeholder="teammate@company.com"
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
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="support">Support (read + holds)</option>
                <option value="superadmin">Superadmin (full)</option>
              </select>
            </label>
            <Button type="submit" size="sm" disabled={!email.trim()}>
              Grant
            </Button>
          </form>
        </Card>
      )}

      {rows === undefined ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <Empty label="No in-app admins granted. Root admins come from the deployment allowlist." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Admin</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Granted</TableHead>
                {isSuper && (
                  <TableHead className="text-right">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a._id}>
                  <TableCell className="whitespace-normal">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                        <Shield className="h-4 w-4 text-muted-foreground" />
                      </span>
                      <p className="truncate text-sm font-medium">{a.email}</p>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">
                    {a.role}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timeAgo(a.createdAt)}
                  </TableCell>
                  {isSuper && (
                    <TableCell className="text-right">
                      <button
                        type="button"
                        aria-label="Revoke admin"
                        onClick={async () => {
                          try {
                            await revoke({
                              adminId: a._id as Id<"platformAdmins">,
                            });
                            toast(`Revoked ${a.email}`);
                          } catch (err) {
                            toast(errMsg(err), { kind: "error" });
                          }
                        }}
                        className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

// Discrete-card wrapper for a data table — the Square-style shell's
// grammar for tabular content (card surface, full-bleed table inside).
function TableCard({ children }: { children: ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="px-0 py-0">{children}</CardContent>
    </Card>
  );
}

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
        className={cn(
          danger && "hover:border-destructive/40 hover:text-destructive",
        )}
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
      <Input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 sm:w-64"
      />
      <Button
        type="submit"
        size="sm"
        disabled={!reason.trim() || pending}
        className={cn(danger && "bg-destructive hover:bg-destructive/85")}
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
    <div className="relative w-full sm:max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="pl-8"
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
    <span
      style={identityFill(name)}
      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
    >
      {(Array.from(name.trim())[0] ?? "?").toUpperCase()}
    </span>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <Card className="items-center py-10 text-center">
      <CardContent className="text-sm text-muted-foreground">
        {label}
      </CardContent>
    </Card>
  );
}

function SkeletonRows() {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="divide-y divide-border">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="h-8 w-8 flex-shrink-0 animate-pulse rounded-full bg-muted" />
            <div
              className="h-3 animate-pulse rounded-full bg-muted"
              style={{ width: `${55 - i * 8}%` }}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SkeletonGrid({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: n }, (_, i) => (
        <Card key={i} className="h-28 animate-pulse bg-muted/30" />
      ))}
    </div>
  );
}

function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
    "Something went wrong"
  );
}
