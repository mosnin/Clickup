"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Comments } from "@/components/dashboard/comments";
import { GoalsPanel } from "@/components/dashboard/goals-panel";
import { ReportsPanel } from "@/components/dashboard/reports-panel";
import { SprintsPanel } from "@/components/dashboard/sprints-panel";
import { TeamHub } from "@/components/dashboard/team-hub";
import { WorkspaceSettings } from "@/components/dashboard/workspace-settings";
import { ActivityFeed } from "@/app/dashboard/agents/agents-view";
import { cn } from "@/lib/utils";

type Tab =
  | "overview"
  | "team"
  | "chat"
  | "sprints"
  | "activity"
  | "goals"
  | "reports"
  | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "team", label: "Team" },
  { key: "chat", label: "Chat" },
  { key: "sprints", label: "Sprints" },
  { key: "activity", label: "Activity" },
  { key: "goals", label: "Goals" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings" },
];

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const tree = useQuery(api.sidebar.tree, {});
  const searchParams = useSearchParams();
  const tab: Tab = (() => {
    const raw = searchParams.get("tab");
    if (
      raw === "chat" ||
      raw === "sprints" ||
      raw === "activity" ||
      raw === "goals" ||
      raw === "reports" ||
      raw === "team" ||
      raw === "settings"
    ) {
      return raw;
    }
    return "overview";
  })();

  if (tree === undefined) {
    return <Skeleton />;
  }
  if (tree === null) return null;

  const workspace = tree.workspaces.find((w) => w._id === workspaceId);

  if (!workspace) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This workspace doesn&apos;t exist or you&apos;re not a member.
        </p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="title-rule">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {workspace.name}
          </h1>
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </div>
      </header>

      <nav
        aria-label="Workspace tabs"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-background p-1 text-sm"
      >
        {TABS.map(({ key, label }) => (
          <Link
            key={key}
            href={
              key === "overview"
                ? `/dashboard/w/${workspace._id}`
                : `/dashboard/w/${workspace._id}?tab=${key}`
            }
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-1.5 transition-colors",
              tab === key
                ? "bg-foreground font-medium text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        workspace.spaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No spaces yet. Use the <span className="font-medium">+</span> next
              to <span className="font-medium">{workspace.name}</span> in the
              sidebar to add one.
            </p>
          </div>
        ) : (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Spaces
            </h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workspace.spaces.map((space) => {
                const totalLists =
                  space.lists.length +
                  space.folders.reduce((n, f) => n + f.lists.length, 0);
                return (
                  <li
                    key={space._id}
                    id={space._id}
                    className="rounded-2xl border border-border bg-background p-5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: space.color ?? "#a9c6f2" }}
                      />
                      <span className="font-medium">{space.name}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {totalLists} list{totalLists === 1 ? "" : "s"} ·{" "}
                      {space.folders.length} folder
                      {space.folders.length === 1 ? "" : "s"}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        )
      ) : tab === "team" ? (
        <section>
          <TeamHub workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "chat" ? (
        <section>
          <ChatWithChannels workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "sprints" ? (
        <section>
          <SprintsPanel workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "activity" ? (
        <section>
          <ActivityFeed
            scope={{
              scopeType: "workspace",
              scopeId: workspace._id,
            }}
          />
        </section>
      ) : tab === "goals" ? (
        <section>
          <GoalsPanel
            parentType="workspace"
            parentId={workspace._id as Id<"workspaces">}
          />
        </section>
      ) : tab === "reports" ? (
        <section>
          <ReportsPanel
            workspaceId={workspace._id as Id<"workspaces">}
          />
        </section>
      ) : (
        <section>
          <WorkspaceSettings
            workspaceId={workspace._id as Id<"workspaces">}
          />
        </section>
      )}
    </div>
  );
}

// Main workspace chat plus topic channels (where agents hold threaded
// discussions). ?channel=<id> selects a channel; the row of pills lets
// humans hop between them and open new ones.
function ChatWithChannels({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const channels = useQuery(api.channels.listForScope, {
    scopeType: "workspace",
    scopeId: workspaceId,
  });
  const createChannel = useMutation(api.channels.create);
  const activeChannel = searchParams.get("channel");

  const base = `/dashboard/w/${workspaceId}?tab=chat`;

  async function onNewChannel() {
    const name = window.prompt("Channel name (e.g. sprint-12-planning)");
    if (!name) return;
    const channelId = await createChannel({
      scopeType: "workspace",
      scopeId: workspaceId,
      name,
    });
    router.push(`${base}&channel=${channelId}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={base}
          className={cn(
            "rounded-full px-3 py-1 text-sm transition-colors",
            !activeChannel
              ? "bg-foreground font-medium text-background"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          # general
        </Link>
        {(channels ?? []).map((c) => (
          <Link
            key={c._id}
            href={`${base}&channel=${c._id}`}
            className={cn(
              "rounded-full px-3 py-1 text-sm transition-colors",
              activeChannel === c._id
                ? "bg-foreground font-medium text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            # {c.name}
          </Link>
        ))}
        <button
          type="button"
          onClick={onNewChannel}
          className="rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          + channel
        </button>
      </div>
      {activeChannel ? (
        <Comments
          key={activeChannel}
          parentType="channel"
          parentId={activeChannel}
          emptyHint="No messages in this channel yet."
        />
      ) : (
        <Comments
          parentType="workspace"
          parentId={workspaceId}
          emptyHint="No messages yet. Start the conversation."
        />
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
