"use client";

import { useState } from "react";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { Mail, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/dashboard/toast";

type MemberRole = "owner" | "admin" | "member" | "viewer";
type InviteRole = Exclude<MemberRole, "owner">;

const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

const INVITE_ROLES: InviteRole[] = ["admin", "member", "viewer"];

export function WorkspaceSettings({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  return (
    <div className="space-y-10">
      <MembersSection workspaceId={workspaceId} />
      <IntegrationsSection workspaceId={workspaceId} />
    </div>
  );
}

// --- Members + Invitations ------------------------------------------------

function MembersSection({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const members = useQuery(api.workspaces.listMembers, { workspaceId });
  const invitations = useQuery(api.invitations.listForWorkspace, {
    workspaceId,
  });

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Members
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Invite teammates by email. Owners and admins can change roles and
        remove members; the owner can transfer ownership.
      </p>

      <div className="mt-4 space-y-4">
        <InviteForm workspaceId={workspaceId} />

        {invitations && invitations.length > 0 && (
          <PendingInvites invitations={invitations} />
        )}

        <MemberList workspaceId={workspaceId} members={members ?? []} />
      </div>
    </section>
  );
}

function InviteForm({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const create = useMutation(api.invitations.create);
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!email.trim()) return;
        setPending(true);
        setError(null);
        try {
          await create({
            workspaceId,
            email: email.trim(),
            role,
          });
          toast.show({ label: `Invite sent to ${email.trim()}` });
          setEmail("");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to invite");
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-col gap-2 rounded-3xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
    >
      <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
        placeholder="teammate@example.com"
        className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.currentTarget.value as InviteRole)}
        className="rounded-full border border-border bg-background px-3 py-1.5 text-xs"
      >
        {INVITE_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={!email.trim() || pending}>
        {pending ? "Sending…" : "Invite"}
      </Button>
      {error && (
        <p className="text-xs text-red-700 sm:basis-full">{error}</p>
      )}
    </form>
  );
}

function PendingInvites({
  invitations,
}: {
  invitations: Doc<"invitations">[];
}) {
  const revoke = useMutation(api.invitations.revoke);
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Pending invites
      </h3>
      <ul className="mt-2 space-y-2">
        {invitations.map((inv) => (
          <li
            key={inv._id}
            className="flex items-center gap-3 rounded-3xl border border-border bg-background p-3"
          >
            <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{inv.email}</p>
              <p className="text-xs text-muted-foreground">
                {ROLE_LABEL[inv.role as InviteRole]} · expires{" "}
                {new Date(inv.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <button
              type="button"
              aria-label="Revoke invite"
              onClick={() => revoke({ invitationId: inv._id })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Member = Doc<"users"> & { role: MemberRole };

function MemberList({
  workspaceId,
  members,
}: {
  workspaceId: Id<"workspaces">;
  members: Member[];
}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const changeRole = useMutation(api.workspaces.changeRole);
  const removeMember = useMutation(api.workspaces.removeMember);
  const transferOwnership = useMutation(api.workspaces.transferOwnership);

  if (!isAuthenticated || !user) return null;
  const meClerkId = user.id;
  const me = members.find((m) => m.clerkId === meClerkId);
  const meRole: MemberRole = me?.role ?? "member";

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members ({members.length})
      </h3>
      <ul className="mt-2 space-y-2">
        {members.map((m) => {
          const isMe = m.clerkId === meClerkId;
          const canEdit =
            !isMe &&
            (meRole === "owner" ||
              (meRole === "admin" && m.role !== "owner" && m.role !== "admin"));
          const canTransfer = meRole === "owner" && m.role !== "owner";
          const canBeRemoved = isMe ? m.role !== "owner" : canEdit;

          return (
            <li
              key={m.clerkId}
              className="flex items-center gap-3 rounded-3xl border border-border bg-background p-3"
            >
              <Avatar name={m.name ?? m.email} clerkId={m.clerkId} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name ?? m.email}
                  {isMe && (
                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.email}
                </p>
              </div>
              <select
                value={m.role}
                disabled={!canEdit || m.role === "owner"}
                onChange={(e) =>
                  changeRole({
                    workspaceId,
                    targetClerkId: m.clerkId,
                    role: e.currentTarget.value as InviteRole,
                  })
                }
                className="rounded-full border border-border bg-background px-2 py-1 text-xs disabled:opacity-60"
              >
                {(Object.keys(ROLE_LABEL) as MemberRole[]).map((r) => (
                  <option
                    key={r}
                    value={r}
                    disabled={r === "owner" && m.role !== "owner"}
                  >
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              {canTransfer && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Transfer ownership to ${m.name ?? m.email}? You'll be demoted to admin.`,
                      )
                    ) {
                      transferOwnership({
                        workspaceId,
                        newOwnerClerkId: m.clerkId,
                      });
                    }
                  }}
                  className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Make owner
                </button>
              )}
              {canBeRemoved && (
                <button
                  type="button"
                  aria-label={isMe ? "Leave workspace" : "Remove member"}
                  onClick={() => {
                    const ok = window.confirm(
                      isMe
                        ? "Leave this workspace?"
                        : `Remove ${m.name ?? m.email}?`,
                    );
                    if (ok) {
                      removeMember({
                        workspaceId,
                        targetClerkId: m.clerkId,
                      });
                    }
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Avatar({ name, clerkId }: { name: string; clerkId: string }) {
  const initial = (name || clerkId).trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-medium text-white"
    >
      {initial}
    </span>
  );
}

// --- Slack integration (kept; just unwrapped from the old top-level) -----

function IntegrationsSection({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const integrations = useQuery(api.integrations.listForWorkspace, {
    workspaceId,
  });
  if (integrations === undefined) {
    return <div className="h-32 animate-pulse rounded-3xl bg-muted/40" />;
  }
  const slack = integrations.find((i) => i.kind === "slack") ?? null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Integrations
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect external services. Currently: Slack incoming webhooks.
      </p>
      <div className="mt-4">
        <SlackIntegration workspaceId={workspaceId} integration={slack} />
      </div>
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

  const [draftUrl, setDraftUrl] = useState(
    integration?.config.webhookUrl ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-3xl border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Slack</h3>
          <p className="mt-1 text-xs text-muted-foreground">
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
          </p>
        </div>
        {integration && (
          <button
            type="button"
            aria-label="Disconnect Slack"
            onClick={() => {
              if (window.confirm("Disconnect Slack from this workspace?")) {
                remove({ integrationId: integration._id });
              }
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
            setError(err instanceof Error ? err.message : "Failed to save");
          } finally {
            setPending(false);
          }
        }}
        className="mt-3 space-y-2"
      >
        <input
          type="url"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.currentTarget.value)}
          placeholder="https://hooks.slack.com/services/T0…"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm font-mono"
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
          {integration && (
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
    </div>
  );
}
