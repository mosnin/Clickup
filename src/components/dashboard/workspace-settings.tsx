"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  Bot,
  Copy,
  Download,
  LogOut,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Monogram } from "@/components/dashboard/monogram";
import { useToast } from "@/components/toast";
import { ImportDialog } from "@/components/dashboard/import-dialog";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// Native-<select> chrome for the invite-role picker — matches Input/Button
// grammar; Picker is reserved for people/agents/tasks/sprints per house
// style, and "admin | member" is a plain enum.
const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function WorkspaceSettings({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const integrations = useQuery(api.integrations.listForWorkspace, {
    workspaceId,
  });

  if (integrations === undefined) {
    return <Card className="h-32 animate-pulse bg-muted/40" />;
  }

  const slack = integrations.find((i) => i.kind === "slack") ?? null;

  return (
    <div className="space-y-8">
      <ExecutionPolicySection workspaceId={workspaceId} />

      <MembersSection workspaceId={workspaceId} />

      <ImportSection />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Integrations
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace owners and admins can connect external services here.
        </p>
        <div className="mt-4">
          <SlackIntegration
            workspaceId={workspaceId}
            integration={slack}
          />
        </div>
      </section>

      <ExportSection workspaceId={workspaceId} />
    </div>
  );
}

function ExecutionPolicySection({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const result = useQuery(api.executionPolicy.getForWorkspace, {
    workspaceId,
  });
  if (result === undefined) {
    return <Card className="h-64 animate-pulse bg-muted/40" />;
  }
  return (
    <ExecutionPolicyForm
      key={result.policy.version}
      workspaceId={workspaceId}
      policy={result.policy}
      canEdit={result.canEdit}
    />
  );
}

function ExecutionPolicyForm({
  workspaceId,
  policy,
  canEdit,
}: {
  workspaceId: Id<"workspaces">;
  policy: {
    mode: "supervised" | "bounded_autonomous";
    version: number;
    maxPlanTasks: number;
    maxTasksPerWave: number;
    dailyTaskLimit: number;
  };
  canEdit: boolean;
}) {
  const updatePolicy = useMutation(api.executionPolicy.update);
  const { toast } = useToast();
  const [mode, setMode] = useState(policy.mode);
  const [maxPlanTasks, setMaxPlanTasks] = useState(policy.maxPlanTasks);
  const [maxTasksPerWave, setMaxTasksPerWave] = useState(
    policy.maxTasksPerWave,
  );
  const [dailyTaskLimit, setDailyTaskLimit] = useState(
    policy.dailyTaskLimit,
  );
  const [acknowledged, setAcknowledged] = useState(
    policy.mode === "bounded_autonomous",
  );
  const [pending, setPending] = useState(false);
  const enteringAutonomous =
    policy.mode !== "bounded_autonomous" &&
    mode === "bounded_autonomous";
  const changed =
    mode !== policy.mode ||
    maxPlanTasks !== policy.maxPlanTasks ||
    maxTasksPerWave !== policy.maxTasksPerWave ||
    dailyTaskLimit !== policy.dailyTaskLimit;

  async function save() {
    setPending(true);
    try {
      await updatePolicy({
        workspaceId,
        mode,
        maxPlanTasks,
        maxTasksPerWave,
        dailyTaskLimit,
      });
      toast(
        mode === "bounded_autonomous"
          ? "Bounded autonomy policy activated."
          : "Supervised execution policy activated.",
        { kind: "success" },
      );
    } catch (error) {
      toast(errorMessage(error, "Couldn't update execution policy"), {
        kind: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Execution authority
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Decide where humans approve the plan and where agents may proceed
            inside explicit limits. Only workspace owners can change this
            boundary.
          </p>
        </div>
        <Badge variant="outline" className="uppercase tracking-wider">
          Policy v{policy.version}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <button
          type="button"
          disabled={!canEdit}
          aria-pressed={mode === "supervised"}
          onClick={() => setMode("supervised")}
          className={cn(
            "rounded-2xl border p-5 text-left transition disabled:cursor-default",
            mode === "supervised"
              ? "border-brand-500 bg-brand-500/[0.06] ring-2 ring-brand-500/15"
              : "border-border bg-card hover:border-brand-500/40",
          )}
        >
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-pastel-blue text-neutral-900">
              <Users className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Supervised</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Every new execution plan waits for an owner or admin.
              </span>
            </span>
          </span>
        </button>
        <button
          type="button"
          disabled={!canEdit}
          aria-pressed={mode === "bounded_autonomous"}
          onClick={() => setMode("bounded_autonomous")}
          className={cn(
            "rounded-2xl border p-5 text-left transition disabled:cursor-default",
            mode === "bounded_autonomous"
              ? "border-brand-500 bg-brand-500/[0.06] ring-2 ring-brand-500/15"
              : "border-border bg-card hover:border-brand-500/40",
          )}
        >
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-pastel-green text-neutral-900">
              <Bot className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-sm font-semibold">
                Bounded autonomous
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Clean, low-risk plans may start inside owner-set limits.
              </span>
            </span>
          </span>
        </button>
      </div>

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600 dark:text-brand-400" />
          <div>
            <p className="text-sm font-medium">Non-negotiable safety gates</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Open questions and approval-gated tasks always require a human.
              Policy-authorized plans are invalidated when these limits change.
              Human approval can re-authorize a plan without weakening the
              workspace policy.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Tasks per autonomous plan</span>
            <Input
              type="number"
              min={1}
              max={100}
              disabled={!canEdit}
              value={maxPlanTasks}
              onChange={(event) =>
                setMaxPlanTasks(Number(event.currentTarget.value))
              }
            />
            <span className="block text-[11px] text-muted-foreground">
              1–100
            </span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Tasks per dispatch wave</span>
            <Input
              type="number"
              min={1}
              max={25}
              disabled={!canEdit}
              value={maxTasksPerWave}
              onChange={(event) =>
                setMaxTasksPerWave(Number(event.currentTarget.value))
              }
            />
            <span className="block text-[11px] text-muted-foreground">
              1–25
            </span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Tasks per rolling 24 hours</span>
            <Input
              type="number"
              min={1}
              max={1000}
              disabled={!canEdit}
              value={dailyTaskLimit}
              onChange={(event) =>
                setDailyTaskLimit(Number(event.currentTarget.value))
              }
            />
            <span className="block text-[11px] text-muted-foreground">
              1–1,000
            </span>
          </label>
        </div>

        {enteringAutonomous && (
          <label className="mt-5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-xs leading-5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) =>
                setAcknowledged(event.currentTarget.checked)
              }
              className="mt-0.5"
            />
            <span>
              I understand that eligible plans can dispatch without a separate
              human approval, within these limits and the agents&apos; own
              permissions.
            </span>
          </label>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {canEdit
              ? "Saving creates a new policy version and revalidates policy-authorized plans."
              : "Read only. Ask a workspace owner to change execution authority."}
          </p>
          {canEdit && (
            <Button
              type="button"
              size="sm"
              disabled={
                !changed ||
                pending ||
                (enteringAutonomous && !acknowledged)
              }
              onClick={() => void save()}
            >
              {pending ? "Saving…" : "Save execution policy"}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}

// Discrete-card wrapper for a data table — same grammar as the admin
// console's TableCard: card surface, full-bleed table inside.
function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="px-0 py-0">{children}</CardContent>
    </Card>
  );
}

// Members & invites. Everyone in the workspace sees the roster; owners and
// admins additionally get the invite form and pending-invite management. The
// pending-invite query throws for plain members (requireManageAccess), so we
// only subscribe to it when the current user manages the workspace.
function MembersSection({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const { user } = useUser();
  const router = useRouter();
  const members = useQuery(api.workspaces.listMembers, { workspaceId });
  const updateMemberRole = useMutation(api.workspaces.updateMemberRole);
  const removeMember = useMutation(api.workspaces.removeMember);
  const leaveWorkspace = useMutation(api.workspaces.leaveWorkspace);
  const { toast } = useToast();

  const myRole = members?.find((m) => m.clerkId === user?.id)?.role;
  const canManage = myRole === "owner" || myRole === "admin";
  const ownerCount = members?.filter((m) => m.role === "owner").length ?? 0;

  const invites = useQuery(
    api.invites.listForWorkspace,
    canManage ? { workspaceId } : "skip",
  );

  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  function hide(memberId: string) {
    setHiddenIds((prev) => new Set(prev).add(memberId));
  }
  function unhide(memberId: string) {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(memberId);
      return next;
    });
  }

  async function onChangeRole(
    memberClerkId: string,
    role: "owner" | "admin" | "member",
  ) {
    try {
      await updateMemberRole({ workspaceId, memberClerkId, role });
      toast("Saved");
    } catch (err) {
      toast(errorMessage(err, "Couldn't change role"), { kind: "error" });
    }
  }

  function onRemove(memberClerkId: string, name: string) {
    hide(memberClerkId);
    toast(`${name} removed from the workspace`, {
      action: { label: "Undo", onClick: () => unhide(memberClerkId) },
      onExpire: async () => {
        try {
          await removeMember({ workspaceId, memberClerkId });
        } catch (err) {
          unhide(memberClerkId);
          toast(errorMessage(err, "Couldn't remove member"), {
            kind: "error",
          });
        }
      },
    });
  }

  async function onLeave() {
    try {
      await leaveWorkspace({ workspaceId });
      toast("You left the workspace");
      router.push("/dashboard");
    } catch (err) {
      toast(errorMessage(err, "Couldn't leave the workspace"), {
        kind: "error",
      });
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Members
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {canManage
          ? "Invite teammates by email and manage who has access."
          : "People with access to this workspace."}
      </p>

      {canManage && <InviteForm workspaceId={workspaceId} />}

      <div className="mt-4">
        {members === undefined ? (
          <Card className="h-12 animate-pulse bg-muted/40" />
        ) : (
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="text-right">Role</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members
                  .filter((m) => !hiddenIds.has(m.clerkId))
                  .map((m) => {
                    const isSelf = m.clerkId === user?.id;
                    // Owners/admins may retarget anyone else's role, but
                    // only an owner may touch another owner's role — same
                    // gate the server enforces in workspaces.updateMemberRole.
                    const canEditThisRole =
                      canManage &&
                      !isSelf &&
                      (myRole === "owner" || m.role !== "owner");
                    const isLastOwner = m.role === "owner" && ownerCount <= 1;
                    return (
                      <TableRow key={m._id}>
                        <TableCell className="whitespace-normal">
                          <div className="flex items-center gap-3">
                            <Monogram name={m.name || m.email} size="md" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {m.name || m.email}
                                {isSelf && (
                                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                    (you)
                                  </span>
                                )}
                              </p>
                              {m.name && (
                                <p className="truncate text-xs text-muted-foreground">
                                  {m.email}
                                </p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {canEditThisRole ? (
                            <select
                              value={m.role}
                              onChange={(e) =>
                                onChangeRole(
                                  m.clerkId,
                                  e.currentTarget.value as
                                    | "owner"
                                    | "admin"
                                    | "member",
                                )
                              }
                              className={SELECT_CLASS}
                              aria-label={`Role for ${m.name || m.email}`}
                            >
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                              {myRole === "owner" && (
                                <option value="owner">Owner</option>
                              )}
                            </select>
                          ) : (
                            <Badge
                              variant="outline"
                              className="uppercase tracking-wider text-muted-foreground"
                            >
                              {m.role}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isSelf ? (
                            <button
                              type="button"
                              aria-label="Leave workspace"
                              title={
                                isLastOwner
                                  ? "You're the only owner — promote someone else first"
                                  : "Leave workspace"
                              }
                              disabled={isLastOwner}
                              onClick={onLeave}
                              className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <LogOut className="h-4 w-4" />
                            </button>
                          ) : (
                            canEditThisRole && (
                              <button
                                type="button"
                                aria-label={`Remove ${m.name || m.email}`}
                                title={
                                  isLastOwner
                                    ? "Can't remove the last owner"
                                    : "Remove from workspace"
                                }
                                disabled={isLastOwner}
                                onClick={() =>
                                  onRemove(m.clerkId, m.name || m.email)
                                }
                                className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </div>

      {canManage && invites && invites.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pending invites
          </h3>
          <div className="mt-2">
            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((inv) => (
                    <PendingInviteRow
                      key={inv._id}
                      inviteId={inv._id}
                      email={inv.email}
                      role={inv.role}
                      token={inv.token}
                    />
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          </div>
        </div>
      )}
    </section>
  );
}

function InviteForm({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const createInvite = useMutation(api.invites.create);
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await createInvite({ workspaceId, email: email.trim(), role });
      toast(`Invite sent to ${email.trim()}`);
      setEmail("");
    } catch (err) {
      toast(
        err instanceof Error
          ? err.message.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Couldn't send invite"
          : "Couldn't send invite",
        { kind: "error" },
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-center gap-2">
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
        placeholder="teammate@company.com"
        className="min-w-0 flex-1"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.currentTarget.value as "admin" | "member")}
        className={SELECT_CLASS}
        aria-label="Invite role"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      <Button type="submit" size="sm" disabled={!email.trim() || pending}>
        <UserPlus className="h-3.5 w-3.5" />
        {pending ? "Sending…" : "Invite"}
      </Button>
    </form>
  );
}

function PendingInviteRow({
  inviteId,
  email,
  role,
  token,
}: {
  inviteId: Id<"invites">;
  email: string;
  role: string;
  token: string;
}) {
  const revoke = useMutation(api.invites.revoke);
  const { toast } = useToast();
  const [revoked, setRevoked] = useState(false);
  if (revoked) return null;

  async function copyLink() {
    const link = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied");
    } catch {
      toast("Couldn't copy the link", { kind: "error" });
    }
  }

  return (
    <TableRow>
      <TableCell className="whitespace-normal text-sm">{email}</TableCell>
      <TableCell className="capitalize text-muted-foreground">
        {role}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label={`Copy invite link for ${email}`}
            title="Copy invite link — useful if the invite email never arrives"
            onClick={copyLink}
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`Revoke invite for ${email}`}
            onClick={() => {
              setRevoked(true);
              toast("Invite revoked", {
                action: { label: "Undo", onClick: () => setRevoked(false) },
                onExpire: () => revoke({ inviteId }),
              });
            }}
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// CSV import: opens the mapping dialog; the mutation enforces list access.
function ImportSection() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Import
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Bring work in from ClickUp or any CSV export.
      </p>
      <Card className="mt-4 flex-row items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium">Import tasks from CSV</p>
          <p className="text-xs text-muted-foreground">
            Map your columns, preview, and import into any list.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Upload className="h-3.5 w-3.5" /> Import CSV
        </Button>
      </Card>
      <ImportDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

// On-demand data export (owners/admins only, enforced server-side). Uses a
// one-shot query on click rather than a reactive subscription, then hands
// the browser a JSON download.
function ExportSection({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const convex = useConvex();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  async function onExport() {
    setPending(true);
    try {
      const data = await convex.query(api.dataExport.exportWorkspace, {
        workspaceId,
      });
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.workspace.slug || "workspace"}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Export downloaded");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      toast(raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || "Export failed", {
        kind: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Data & compliance
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Export this workspace&apos;s spaces, lists, tasks, sprints, and agent
        configuration as a JSON document. Secrets and API keys are never
        included.
      </p>
      <Card className="mt-4 flex-row items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium">Export workspace data</p>
          <p className="text-xs text-muted-foreground">
            Owners and admins only. Portable, human-readable JSON.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={pending} onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          {pending ? "Preparing…" : "Export JSON"}
        </Button>
      </Card>
    </section>
  );
}

function SlackIntegration({
  workspaceId,
  integration,
}: {
  workspaceId: Id<"workspaces">;
  integration: Doc<"integrations"> | null;
}) {
  const upsert = useMutation(api.integrations.upsertSlack);
  const setEnabled = useMutation(api.integrations.setEnabled);
  const remove = useMutation(api.integrations.remove);
  const { toast } = useToast();
  const [disconnecting, setDisconnecting] = useState(false);

  // The stored webhook URL is a secret (anyone holding it can post to the
  // channel), so it is never rendered back. Empty field = unchanged.
  const [draftUrl, setDraftUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <CardTitle className="text-sm font-semibold">Slack</CardTitle>
          <CardDescription className="mt-1 text-xs">
            When a task is assigned, post a message to a Slack channel via
            an{" "}
            <a
              href="https://api.slack.com/messaging/webhooks"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              incoming webhook
            </a>
            .
          </CardDescription>
        </div>
        {integration && !disconnecting && (
          <button
            type="button"
            aria-label="Disconnect Slack"
            onClick={() => {
              setDisconnecting(true);
              toast("Slack disconnected", {
                action: {
                  label: "Undo",
                  onClick: () => setDisconnecting(false),
                },
                onExpire: () => remove({ integrationId: integration._id }),
              });
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            await upsert({
              workspaceId,
              webhookUrl: draftUrl.trim(),
            });
          } catch (err) {
            setError(
              err instanceof Error ? err.message : "Failed to save",
            );
          } finally {
            setPending(false);
          }
        }}
        className="mt-3 space-y-2"
      >
        <Input
          type="url"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.currentTarget.value)}
          placeholder={
            integration
              ? "Connected. Paste a new URL to replace it."
              : "https://hooks.slack.com/services/T0…"
          }
          className="font-mono"
        />
        {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!draftUrl.trim() || pending}
          >
            {pending
              ? "Saving…"
              : integration
                ? "Update webhook"
                : "Connect Slack"}
          </Button>
          {integration && !disconnecting && (
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={integration.enabled}
                onChange={(e) =>
                  setEnabled({
                    integrationId: integration._id,
                    enabled: e.currentTarget.checked,
                  })
                }
              />
              Enabled
            </label>
          )}
        </div>
      </form>
    </Card>
  );
}
