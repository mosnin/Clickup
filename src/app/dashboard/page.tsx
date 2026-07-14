"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Stagger, StaggerItem } from "@/components/motion";

export default function DashboardHome() {
  const tree = useQuery(api.sidebar.tree, {});

  if (tree === undefined) {
    return <DashboardSkeleton />;
  }
  if (tree === null) {
    return null;
  }

  return (
    <div className="space-y-10">
      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Home
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Jump back into your spaces and team workspaces.
        </p>
      </header>

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
