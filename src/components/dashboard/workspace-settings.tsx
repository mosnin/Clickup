"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

export function WorkspaceSettings({
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
    </div>
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
