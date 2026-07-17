"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";
import { api } from "@convex/_generated/api";
import {
  AnimatedBar,
  AnimatedNumber,
  AnimatePresence,
  EASE,
  motion,
  PresenceDot,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { InviteCards } from "@/components/dashboard/invite-cards";
import { NewWorkspaceDialog } from "@/components/dashboard/new-workspace-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { eventLabel } from "@/lib/event-labels";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import TextType from "@/components/text-type";

// Home: the first thing a signed-in user sees. A live bento dashboard —
// every tile is driven by a single reactive query (homeOverview.get), so
// the page updates itself the moment a task completes, an agent
// heartbeats, or a comment lands. No polling, no refresh button.

type Overview = NonNullable<
  ReturnType<typeof useQuery<typeof api.homeOverview.get>>
>;
type Project = Overview["projects"][number];
type AgentRow = Overview["agents"][number];
type TickerItem = Overview["ticker"][number];

const STATUS_CHIP: Record<
  NonNullable<Project["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow" },
  off_track: { label: "Off track", className: "bg-pastel-red" },
  paused: { label: "Paused", className: "bg-muted" },
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function formatTargetDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function DashboardHome() {
  const overview = useQuery(api.homeOverview.get, {});
  // Kept solely for the "waiting to connect" card — homeOverview doesn't
  // expose lastSeenAt, and "never connected" is the one signal that query
  // doesn't carry.
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const { user } = useUser();
  const [wsDialog, setWsDialog] = useState(false);

  if (overview === undefined) {
    return <DashboardSkeleton />;
  }
  if (overview === null) {
    return null;
  }

  const waiting = agents
    ? [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)].filter(
        (a) => a.status === "active" && a.lastSeenAt === undefined,
      )
    : [];

  const needsAttention = overview.me.overdue + overview.me.dueToday;
  const extraProjects = overview.totalProjects - overview.projects.length;

  return (
    <div className="space-y-8">
      <WelcomeReveal />

      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {greeting()}
          {user?.firstName ? `, ${user.firstName}` : ""}.
        </h1>
        <TextType
          as="p"
          className="mt-1 text-sm text-muted-foreground"
          text={
            needsAttention > 0
              ? `${needsAttention} thing${needsAttention === 1 ? "" : "s"} need${
                  needsAttention === 1 ? "s" : ""
                } you today.`
              : "Everything's moving. Here's where it stands."
          }
          typingSpeed={28}
          loop={false}
          hideCursorWhileTyping={false}
          cursorBlinkDuration={0.6}
        />
      </header>

      <InviteCards />

      {/* AnimatePresence so the card resolves with a satisfying collapse
          the moment the agent's first heartbeat lands (live via Convex). */}
      <AnimatePresence initial={false}>
        {waiting.length > 0 && (
          <motion.div
            key="waiting-card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, height: 0, marginTop: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="overflow-hidden"
          >
            <Link
              href="/dashboard/agents"
              className="lift flex items-center gap-4 rounded-2xl bento p-5 hover:border-foreground/25"
            >
              <span className="relative inline-flex h-12 w-12 flex-shrink-0" aria-hidden>
                <span className="absolute inset-0 animate-ping rounded-full bg-pastel-blue opacity-60" />
                <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-lg font-semibold text-white">
                  {waiting[0].name.charAt(0).toUpperCase()}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {waiting[0].name} is waiting to connect
                </span>
                <span className="block text-sm text-muted-foreground">
                  Copy its ready-made setup from the Agents page. The dot turns
                  green the moment it checks in.
                </span>
              </span>
              <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Today: the three numbers that matter right now, spring-animated
          on every change. */}
      <section aria-label="Today">
        <Stagger className="grid grid-cols-3 gap-3">
          <StaggerItem>
            <Link
              href="/dashboard/my-work"
              className="lift block rounded-2xl bento-sm p-4"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Open
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                <AnimatedNumber value={overview.me.open} />
              </p>
            </Link>
          </StaggerItem>
          <StaggerItem>
            <div className="rounded-2xl bento-sm p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Due today
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                <AnimatedNumber value={overview.me.dueToday} />
              </p>
            </div>
          </StaggerItem>
          <StaggerItem>
            <div className="rounded-2xl bento-sm p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Overdue
              </p>
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums",
                  overview.me.overdue > 0 && "text-danger",
                )}
              >
                <AnimatedNumber value={overview.me.overdue} />
              </p>
            </div>
          </StaggerItem>
        </Stagger>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Projects
            </h2>
            <button
              type="button"
              onClick={() => setWsDialog(true)}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              New workspace
            </button>
          </div>

          {overview.projects.length === 0 ? (
            <div className="mt-3 rounded-2xl bento">
              <EmptyState
                compact
                title="No projects yet"
                message="Create a list inside your personal space or a workspace and it'll show up here, live."
              />
            </div>
          ) : (
            <>
              <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {overview.projects.map((project) => (
                  <StaggerItem key={project.listId}>
                    <ProjectCard project={project} />
                  </StaggerItem>
                ))}
              </Stagger>
              {extraProjects > 0 && (
                <Link
                  href="/dashboard/personal"
                  className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
                >
                  …and {extraProjects} more
                </Link>
              )}
            </>
          )}
        </section>

        <aside className="space-y-6">
          <AgentsTile agents={overview.agents} />
          <LiveTile ticker={overview.ticker} />
        </aside>
      </div>

      <NewWorkspaceDialog open={wsDialog} onClose={() => setWsDialog(false)} />
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const pct = project.total > 0 ? (project.done / project.total) * 100 : 0;
  const chip = project.projectStatus ? STATUS_CHIP[project.projectStatus] : null;

  return (
    <Link
      href={`/dashboard/l/${project.listId}`}
      className="lift block rounded-2xl bento p-5 hover:border-foreground/25"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{project.name}</p>
          <p className="truncate text-xs text-muted-foreground">{project.place}</p>
        </div>
        {chip && (
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-foreground",
              chip.className,
            )}
          >
            {chip.label}
          </span>
        )}
      </div>

      {project.description && (
        <p className="mt-2 line-clamp-1 text-sm text-muted-foreground">
          {project.description}
        </p>
      )}

      <div className="mt-4">
        <AnimatedBar
          pct={pct}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          barClassName="block h-full rounded-full bg-foreground"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {project.done} of {project.total} done
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {project.overdue > 0 && (
          <span className="text-danger">{project.overdue} overdue</span>
        )}
        {project.dueSoon > 0 && <span>{project.dueSoon} due soon</span>}
        {project.targetDate !== undefined && (
          <span>Target {formatTargetDate(project.targetDate)}</span>
        )}
      </div>
    </Link>
  );
}

function AgentsTile({ agents }: { agents: AgentRow[] }) {
  return (
    <div className="rounded-2xl bento p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Agents right now
      </h2>
      {agents.length === 0 ? (
        <EmptyState
          compact
          title="No agents yet"
          message="Bring an agent online to see live presence here."
          action={
            <Link
              href="/dashboard/agents"
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              Go to Agents
            </Link>
          }
        />
      ) : (
        <Stagger className="mt-3 space-y-1">
          {agents.map((a) => (
            <StaggerItem key={a.agentId}>
              <Link
                href={`/dashboard/agents/${a.agentId}`}
                className="lift flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
              >
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                  {a.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <PresenceDot online={a.online} />
                  </span>
                  {a.statusText && (
                    <span className="block truncate text-xs italic text-muted-foreground">
                      {a.statusText}
                    </span>
                  )}
                </span>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function LiveTile({ ticker }: { ticker: TickerItem[] }) {
  const visible = ticker.slice(0, 8);
  return (
    <div className="rounded-2xl bento p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Live
      </h2>
      {visible.length === 0 ? (
        <EmptyState
          compact
          title="It's quiet"
          message="Activity across your projects will land here the moment it happens."
        />
      ) : (
        <ul className="mt-3 space-y-3">
          <AnimatePresence initial={false}>
            {visible.map((e) => {
              const key = `${e.createdAt}-${e.type}-${e.entityTitle ?? ""}`;
              const body = (
                <>
                  <span className="font-medium">{e.actorName}</span>{" "}
                  {eventLabel(e.type)}
                  {e.entityTitle ? (
                    <>
                      {" "}
                      <span className="font-medium">{e.entityTitle}</span>
                    </>
                  ) : null}
                </>
              );
              return (
                <motion.li
                  key={key}
                  layout
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="text-sm leading-snug"
                >
                  {e.listId ? (
                    <Link href={`/dashboard/l/${e.listId}`} className="hover:underline">
                      {body}
                    </Link>
                  ) : (
                    <span>{body}</span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {timeAgo(e.createdAt)}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

// One-time reveal after onboarding: the mark breathes in, one line lands,
// then the curtain lifts to the greeting. Click anywhere to skip.
function WelcomeReveal() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const arrived = searchParams.get("welcome") === "1";
  const [show, setShow] = useState(arrived);

  const dismiss = useMemo(
    () => () => {
      setShow(false);
      router.replace("/dashboard");
    },
    [router],
  );

  useEffect(() => {
    if (!arrived) return;
    const t = setTimeout(dismiss, 2600);
    return () => clearTimeout(t);
  }, [arrived, dismiss]);

  return (
    <AnimatePresence>
      {show && (
        <motion.button
          type="button"
          aria-label="Continue"
          onClick={dismiss}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, filter: "blur(6px)" }}
          transition={{ duration: 0.6, ease: EASE }}
          className="fixed inset-0 z-[60] flex cursor-default flex-col items-center justify-center gap-6 bg-background"
        >
          <motion.span
            aria-hidden
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 18 }}
            className="inline-block h-8 w-8 rounded-[8px] bg-foreground"
          />
          <motion.p
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.35 }}
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            Your mission control is ready.
          </motion.p>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="h-8 w-64 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-48 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted/60" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted/60" />
          ))}
        </div>
        <div className="space-y-6">
          <div className="h-48 animate-pulse rounded-2xl bg-muted/60" />
          <div className="h-64 animate-pulse rounded-2xl bg-muted/60" />
        </div>
      </div>
    </div>
  );
}
