"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";
import { api } from "@convex/_generated/api";
import {
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Home: the first thing a signed-in user sees. Greets them by name,
// surfaces any agent that's still waiting to connect, and lays out their
// spaces. Arriving with ?welcome=1 (from onboarding) plays a one-time
// full-screen reveal.

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function DashboardHome() {
  const tree = useQuery(api.sidebar.tree, {});
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const { user } = useUser();

  if (tree === undefined) {
    return <DashboardSkeleton />;
  }
  if (tree === null) {
    return null;
  }

  // Agents that have never heartbeat — the "waiting to connect" nudge.
  const waiting = agents
    ? [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)].filter(
        (a) => a.status === "active" && a.lastSeenAt === undefined,
      )
    : [];

  return (
    <div className="space-y-10">
      <WelcomeReveal />

      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {greeting()}
          {user?.firstName ? `, ${user.firstName}` : ""}.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {waiting.length > 0
            ? "Your mission control is live — one thing left: bring your agent online."
            : "Here's where everything lives."}
        </p>
      </header>

      {waiting.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.15 }}
        >
          <Link
            href="/dashboard/agents"
            className="lift flex items-center gap-4 rounded-2xl border border-border bg-background p-5 hover:border-foreground/25"
          >
            <span className="relative inline-flex text-3xl" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-pastel-blue opacity-60" />
              <span className="relative">{waiting[0].emoji ?? "🤖"}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {waiting[0].name} is waiting to connect
              </span>
              <span className="block text-sm text-muted-foreground">
                Point your runtime at the MCP endpoint with its key — the dot
                turns green the moment it heartbeats.
              </span>
            </span>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </Link>
        </motion.div>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Personal
        </h2>
        <Stagger className="mt-3 grid gap-3 sm:grid-cols-2">
          {tree.personal ? (
            <StaggerItem>
              <Link
                href="/dashboard/personal"
                className="lift block rounded-2xl border border-border bg-background p-5 hover:border-foreground/25"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: tree.personal.color ?? "#a9c6f2" }}
                  />
                  <span className="font-medium">{tree.personal.name}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {tree.personal.lists.length +
                    tree.personal.folders.reduce(
                      (n, f) => n + f.lists.length,
                      0,
                    )}{" "}
                  lists · {tree.personal.folders.length} folders
                </p>
              </Link>
            </StaggerItem>
          ) : (
            <StaggerItem className="rounded-2xl border border-dashed border-border bg-muted/30 p-5 text-sm text-muted-foreground">
              Setting up your personal space…
            </StaggerItem>
          )}
        </Stagger>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Team workspaces
          </h2>
          <Link
            href="/onboarding"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            New workspace →
          </Link>
        </div>
        <Stagger className="mt-3 grid gap-3 sm:grid-cols-2">
          {tree.workspaces.length === 0 && (
            <StaggerItem className="rounded-2xl border border-dashed border-border bg-muted/30 p-5 text-sm text-muted-foreground sm:col-span-2">
              You&apos;re not in any team workspaces yet.{" "}
              <Link
                href="/onboarding"
                className="font-medium text-brand-600 hover:underline"
              >
                Create one
              </Link>
              .
            </StaggerItem>
          )}
          {tree.workspaces.map((ws) => (
            <StaggerItem key={ws._id}>
              <Link
                href={`/dashboard/w/${ws._id}`}
                className="lift block rounded-2xl border border-border bg-background p-5 hover:border-foreground/25"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{ws.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {ws.role}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {ws.spaces.length} space{ws.spaces.length === 1 ? "" : "s"}
                </p>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
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
    <div className="space-y-6">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
