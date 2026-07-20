"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Comments } from "@/components/dashboard/comments";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { GoalsPanel } from "@/components/dashboard/goals-panel";
import { ReportsPanel } from "@/components/dashboard/reports-panel";
import { SprintsPanel } from "@/components/dashboard/sprints-panel";
import { PortfolioTimeline } from "@/components/dashboard/portfolio-timeline";
import { TeamHub } from "@/components/dashboard/team-hub";
import { WorkspaceSettings } from "@/components/dashboard/workspace-settings";
import { ActivityFeed } from "@/app/dashboard/agents/agents-view";
import { cn } from "@/lib/utils";
import { EASE, motion, Stagger, StaggerItem } from "@/components/motion";

type Tab =
  | "overview"
  | "team"
  | "chat"
  | "sprints"
  | "portfolio"
  | "activity"
  | "goals"
  | "reports"
  | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "team", label: "Team" },
  { key: "chat", label: "Chat" },
  { key: "sprints", label: "Sprints" },
  { key: "portfolio", label: "Portfolio" },
  { key: "activity", label: "Activity" },
  { key: "goals", label: "Goals" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings" },
];

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const tree = useQuery(api.sidebar.tree, {});
  const spaces = useQuery(api.spaces.listForWorkspace, {
    workspaceId: workspaceId as Id<"workspaces">,
  });
  const searchParams = useSearchParams();
  const rawTab: Tab = (() => {
    const raw = searchParams.get("tab");
    if (
      raw === "chat" ||
      raw === "sprints" ||
      raw === "portfolio" ||
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

  // A Space's Features settings can turn Sprints/Goals off entirely. Hide
  // the tab only when EVERY space in the workspace has the feature
  // explicitly off — any space still using it keeps the tab visible. No
  // spaces (or the query still loading) defaults to showing everything.
  const sprintsHidden =
    !!spaces &&
    spaces.length > 0 &&
    spaces.every((s) => s.features?.sprints === false);
  const goalsHidden =
    !!spaces &&
    spaces.length > 0 &&
    spaces.every((s) => s.features?.goals === false);

  const visibleTabs = TABS.filter(
    (t) =>
      (t.key !== "sprints" || !sprintsHidden) &&
      (t.key !== "goals" || !goalsHidden),
  );

  // If the active tab's feature just got switched off, fall back to
  // Overview rather than render a gated panel with no matching nav pill.
  const tab: Tab =
    (rawTab === "sprints" && sprintsHidden) ||
    (rawTab === "goals" && goalsHidden)
      ? "overview"
      : rawTab;

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

      {/* Scrolls horizontally on narrow screens instead of wrapping into a
          two-row pile, the full-bleed negative margin lets the row bleed
          to the screen edge. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-8 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <nav
          aria-label="Workspace tabs"
          className="segmented whitespace-nowrap text-sm"
        >
          {visibleTabs.map(({ key, label }) => (
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
                  ? "segmented-on font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </Link>
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
        workspace.spaces.length === 0 ? (
          <div className="rounded-2xl bento p-10 text-center">
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
            <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workspace.spaces.map((space) => {
                const lists = [
                  ...space.lists,
                  ...space.folders.flatMap((f) => f.lists),
                ];
                return (
                  <StaggerItem key={space._id}>
                    <div id={space._id} className="rounded-2xl bento p-5">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ backgroundColor: space.color ?? "#a9c6f2" }}
                        />
                        <span className="font-medium">{space.name}</span>
                      </div>
                      {lists.length === 0 ? (
                        <p className="mt-3 text-xs text-muted-foreground">
                          No lists yet, add one from the sidebar.
                        </p>
                      ) : (
                        <ul className="mt-3 space-y-0.5">
                          {lists.map((list) => (
                            <li key={list._id}>
                              <Link
                                href={`/dashboard/l/${list._id}`}
                                className="group flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                              >
                                <span className="truncate">{list.name}</span>
                                <span className="flex-shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                                  List · Board · Gantt
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </StaggerItem>
                );
              })}
            </Stagger>
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
      ) : tab === "portfolio" ? (
        <section>
          <PortfolioTimeline workspaceId={workspace._id as Id<"workspaces">} />
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
      </motion.div>
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
  const [addingChannel, setAddingChannel] = useState(false);

  const base = `/dashboard/w/${workspaceId}?tab=chat`;

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
        {addingChannel ? (
          <InlineCreate
            placeholder="channel-name…"
            className="w-52"
            onCancel={() => setAddingChannel(false)}
            onSubmit={async (name) => {
              const channelId = await createChannel({
                scopeType: "workspace",
                scopeId: workspaceId,
                name,
              });
              setAddingChannel(false);
              router.push(`${base}&channel=${channelId}`);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAddingChannel(true)}
            className="rounded-full bento px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            + channel
          </button>
        )}
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
