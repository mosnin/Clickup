"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const tree = useQuery(api.sidebar.tree, {});

  if (tree === undefined) {
    return <Skeleton />;
  }
  if (tree === null) return null;

  const workspace = tree.workspaces.find((w) => w._id === workspaceId);

  if (!workspace) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
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
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {workspace.name}
          </h1>
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </div>
      </header>

      {workspace.spaces.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center">
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
                  className="rounded-3xl border border-border bg-background p-5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: space.color ?? "#6366f1" }}
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
            className="h-24 animate-pulse rounded-3xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
