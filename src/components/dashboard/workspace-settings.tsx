"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useConvex, useMutation, useQuery } from "convex/react";
import { Download, Trash2, Upload, UserPlus } from "lucide-react";
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
  const members = useQuery(api.workspaces.listMembers, { workspaceId });

  const myRole = members?.find((m) => m.clerkId === user?.id)?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  const invites = useQuery(
    api.invites.listForWorkspace,
    canManage ? { workspaceId } : "skip",
  );

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
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m._id}>
                    <TableCell className="whitespace-normal">
                      <div className="flex items-center gap-3">
                        <Monogram name={m.name || m.email} size="md" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {m.name || m.email}
                            {m.clerkId === user?.id && (
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
                      <Badge
                        variant="outline"
                        className="uppercase tracking-wider text-muted-foreground"
                      >
                        {m.role}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
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
}: {
  inviteId: Id<"invites">;
  email: string;
  role: string;
}) {
  const revoke = useMutation(api.invites.revoke);
  const { toast } = useToast();
  const [revoked, setRevoked] = useState(false);
  if (revoked) return null;

  return (
    <TableRow>
      <TableCell className="whitespace-normal text-sm">{email}</TableCell>
      <TableCell className="capitalize text-muted-foreground">
        {role}
      </TableCell>
      <TableCell className="text-right">
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
        {error && <p className="text-xs text-red-700">{error}</p>}
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
