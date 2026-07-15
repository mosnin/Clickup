"use client";

import { useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { Download, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";

export function WorkspaceSettings({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const integrations = useQuery(api.integrations.listForWorkspace, {
    workspaceId,
  });

  if (integrations === undefined) {
    return <div className="h-32 animate-pulse rounded-2xl bg-muted/40" />;
  }

  const slack = integrations.find((i) => i.kind === "slack") ?? null;

  return (
    <div className="space-y-8">
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
      <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-border bg-background p-4">
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
  const { toast } = useToast();
  const [disconnecting, setDisconnecting] = useState(false);

  const [draftUrl, setDraftUrl] = useState(
    integration?.config.webhookUrl ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-border bg-background p-4">
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
    </div>
  );
}
