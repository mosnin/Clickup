"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Comments } from "@/components/dashboard/comments";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { GoalsPanel } from "@/components/dashboard/goals-panel";
import { ReportsPanel } from "@/components/dashboard/reports-panel";
import { SprintsPanel } from "@/components/dashboard/sprints-panel";
import { OperationsPanel } from "@/components/dashboard/operations-panel";
import { PortfolioTimeline } from "@/components/dashboard/portfolio-timeline";
import { RoadmapPanel } from "@/components/dashboard/roadmap-panel";
import { TeamHub } from "@/components/dashboard/team-hub";
import { WorkspaceSettings } from "@/components/dashboard/workspace-settings";
import { FieldLibraryPanel } from "@/components/dashboard/field-library-panel";
import { ActivityFeed } from "@/app/dashboard/agents/agents-view";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  DeelTabs,
  EmptyBlob,
  KvCard,
  NameLink,
  deelTabClass,
} from "@/components/dashboard/deel-ui";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EASE, motion, Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";

type Tab =
  | "overview"
  | "team"
  | "chat"
  | "sprints"
  | "operations"
  | "portfolio"
  | "roadmap"
  | "activity"
  | "goals"
  | "reports"
  | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "team", label: "Team" },
  { key: "chat", label: "Chat" },
  { key: "sprints", label: "Sprints" },
  { key: "operations", label: "Operations" },
  { key: "portfolio", label: "Portfolio" },
  { key: "roadmap", label: "Roadmap" },
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
  const members = useQuery(api.workspaces.listMembers, {
    workspaceId: workspaceId as Id<"workspaces">,
  });
  const searchParams = useSearchParams();
  const rawTab: Tab = (() => {
    const raw = searchParams.get("tab");
    if (
      raw === "chat" ||
      raw === "sprints" ||
      raw === "operations" ||
      raw === "portfolio" ||
      raw === "roadmap" ||
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
  // Archived spaces don't count either way — they're not part of active
  // work, so they shouldn't be able to hide (or keep visible) a tab.
  const activeSpaces = spaces?.filter((s) => s.archivedAt === undefined);
  const sprintsHidden =
    !!activeSpaces &&
    activeSpaces.length > 0 &&
    activeSpaces.every((s) => s.features?.sprints === false);
  const goalsHidden =
    !!activeSpaces &&
    activeSpaces.length > 0 &&
    activeSpaces.every((s) => s.features?.goals === false);

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
      <div className="rounded-2xl bg-muted/30 p-10 text-center">
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
      <PageHeader
        description="Everyone in it, everything they are running, and how it is going."
        title={workspace.name}
        context={
          <>
            {members !== undefined && (
              <span>
                {members.length} member{members.length === 1 ? "" : "s"}
              </span>
            )}
            <Badge variant="outline">{workspace.role}</Badge>
          </>
        }
      >
        {/* Scrolls horizontally on narrow screens instead of wrapping into a
            two-row pile, the negative margin lets the row bleed to the
            header's own edge padding. */}
        <DeelTabs label="Workspace">
          {visibleTabs.map(({ key, label }) => (
            <Link
              key={key}
              href={
                key === "overview"
                  ? `/dashboard/w/${workspace._id}`
                  : `/dashboard/w/${workspace._id}?tab=${key}`
              }
              aria-current={tab === key ? "page" : undefined}
              className={deelTabClass(tab === key)}
            >
              {label}
            </Link>
          ))}
        </DeelTabs>
      </PageHeader>

      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
      {tab === "overview" ? (
        workspace.spaces.length === 0 ? (
          <EmptyBlob
            title="No spaces yet"
            message={`Use the + next to ${workspace.name} in the sidebar to add one.`}
          />
        ) : (
          <section>
            <h2 className="text-sm font-semibold text-foreground">Spaces</h2>
            <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workspace.spaces.map((space) => {
                const lists = [
                  ...space.lists,
                  ...space.projects.flatMap((f) => f.lists),
                ];
                return (
                  <StaggerItem key={space._id}>
                    <div id={space._id}>
                    <KvCard
                      title={
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="inline-block size-2 rounded-full"
                            style={{ backgroundColor: space.color ?? "#a9c6f2" }}
                          />
                          {space.name}
                        </span>
                      }
                    >
                      {lists.length === 0 ? (
                        <p className="px-5 py-3 text-sm text-muted-foreground">
                          No lists yet, add one from the sidebar.
                        </p>
                      ) : (
                        <ul>
                          {lists.map((list) => (
                            <li key={list._id} className="deel-kv-row !grid-cols-1">
                              <NameLink href={`/dashboard/l/${list._id}`}>
                                {list.name}
                              </NameLink>
                            </li>
                          ))}
                        </ul>
                      )}
                    </KvCard>
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
          <ChatWithChannels
            workspaceId={workspace._id as Id<"workspaces">}
            canManageChannels={
              workspace.role === "owner" || workspace.role === "admin"
            }
          />
        </section>
      ) : tab === "sprints" ? (
        <section>
          <SprintsPanel workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "operations" ? (
        <section>
          <OperationsPanel workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "portfolio" ? (
        <section>
          <PortfolioTimeline workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      ) : tab === "roadmap" ? (
        <section>
          <RoadmapPanel workspaceId={workspace._id as Id<"workspaces">} />
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
        <section className="space-y-6">
          <WorkspaceSettings
            workspaceId={workspace._id as Id<"workspaces">}
          />
          <FieldLibraryPanel workspaceId={workspace._id as Id<"workspaces">} />
        </section>
      )}
      </motion.div>
    </div>
  );
}

// Main workspace chat plus topic channels (where agents hold threaded
// discussions). ?channel=<id> selects a channel; the row of pills lets
// humans hop between them and open new ones. `canManageChannels` gates the
// delete affordance to owner/admin in the UI — the backend (channels.remove)
// only requires workspace membership, so a non-owner/admin who somehow hits
// the mutation directly is still refused there, but the button itself is
// hidden from plain members.
function ChatWithChannels({
  workspaceId,
  canManageChannels,
}: {
  workspaceId: Id<"workspaces">;
  canManageChannels: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const channels = useQuery(api.channels.listForScope, {
    scopeType: "workspace",
    scopeId: workspaceId,
  });
  const createChannel = useMutation(api.channels.create);
  const removeChannel = useMutation(api.channels.remove);
  const activeChannel = searchParams.get("channel");
  const [addingChannel, setAddingChannel] = useState(false);
  const [hiddenChannelIds, setHiddenChannelIds] = useState<Set<string>>(
    new Set(),
  );
  const { toast } = useToast();

  const base = `/dashboard/w/${workspaceId}?tab=chat`;

  function deleteChannel(channelId: string, name: string) {
    setHiddenChannelIds((prev) => new Set(prev).add(channelId));
    if (activeChannel === channelId) router.push(base);
    toast(`#${name} deleted`, {
      action: {
        label: "Undo",
        onClick: () =>
          setHiddenChannelIds((prev) => {
            const next = new Set(prev);
            next.delete(channelId);
            return next;
          }),
      },
      onExpire: () =>
        void removeChannel({ channelId: channelId as Id<"channels"> }).catch(
          (e) => toast(errorMessage(e, "Couldn't delete channel"), {
            kind: "error",
          }),
        ),
    });
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
        {(channels ?? [])
          .filter((c) => !hiddenChannelIds.has(c._id))
          .map((c) => (
            <div key={c._id} className="group/channel relative flex items-center">
              <Link
                href={`${base}&channel=${c._id}`}
                className={cn(
                  "rounded-full px-3 py-1 text-sm transition-colors",
                  canManageChannels && "pr-6",
                  activeChannel === c._id
                    ? "bg-foreground font-medium text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                # {c.name}
              </Link>
              {canManageChannels && (
                <button
                  type="button"
                  aria-label={`Delete #${c.name}`}
                  title={`Delete #${c.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    deleteChannel(c._id, c.name);
                  }}
                  className={cn(
                    "tap-target absolute right-0.5 flex size-5 flex-shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover/channel:opacity-100 focus-visible:opacity-100",
                    activeChannel === c._id
                      ? "text-background/70 hover:bg-background/20 hover:text-background"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        {addingChannel ? (
          <InlineCreate
            placeholder="channel-name…"
            className="w-52"
            onCancel={() => setAddingChannel(false)}
            onSubmit={async (name) => {
              try {
                const channelId = await createChannel({
                  scopeType: "workspace",
                  scopeId: workspaceId,
                  name,
                });
                setAddingChannel(false);
                router.push(`${base}&channel=${channelId}`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create channel"), {
                  kind: "error",
                });
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAddingChannel(true)}
            className="rounded-full panel px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
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
            className="h-24 animate-pulse rounded-2xl bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
