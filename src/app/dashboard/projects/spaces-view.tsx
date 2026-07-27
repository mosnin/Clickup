"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { FileText, Folder, LayoutGrid, List, Lock, Shapes } from "lucide-react";
import { api } from "@convex/_generated/api";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Orb } from "@/components/dashboard/orb";
import { PageHeader } from "@/components/dashboard/page-header";
import { Stagger, StaggerItem } from "@/components/motion";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type SpaceRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.spacesDirectory.list>>
>["rows"][number];

export function SpacesView() {
  const [raw, setRaw] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(raw.trim()), 250);
    return () => clearTimeout(timer);
  }, [raw]);
  const data = useQuery(api.spacesDirectory.list, {
    search: search || undefined,
  });
  const groups = useMemo(() => {
    const buckets = new Map<string, SpaceRow[]>();
    for (const row of data?.rows ?? []) {
      const bucket = buckets.get(row.workspaceName);
      if (bucket) bucket.push(row);
      else buckets.set(row.workspaceName, [row]);
    }
    return [...buckets.entries()].sort(([a], [b]) => {
      if (a === "Personal") return -1;
      if (b === "Personal") return 1;
      return a.localeCompare(b);
    });
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Shapes}
        title="Spaces"
        context={
          data === undefined
            ? undefined
            : `${data.totalCount} space${data.totalCount === 1 ? "" : "s"}`
        }
      >
        <div className="space-y-2 pb-2">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Spaces organize work inside a workspace. Each space holds lists,
            optional projects, docs, and whiteboards.
          </p>
          <p className="text-xs font-medium text-foreground/80">
            Workspace → Space → Project → List → Task
          </p>
          <Input
            value={raw}
            onChange={(event) => setRaw(event.currentTarget.value)}
            placeholder="Search spaces…"
            className="h-8 w-48 sm:w-64"
          />
        </div>
      </PageHeader>

      {data === undefined ? (
        <SpacesSkeleton />
      ) : data.rows.length === 0 ? (
        <EmptyState
          title={search ? "No spaces match" : "No spaces yet"}
          message={
            search
              ? "Try a different search term."
              : "Create a space from the workspace menu, then add lists or start from a template."
          }
        />
      ) : (
        <div className="space-y-8">
          {groups.map(([workspaceName, spaces]) => (
            <section key={workspaceName} aria-label={workspaceName}>
              <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {workspaceName}
                <span className="ml-2 normal-case tracking-normal">
                  {spaces.length}
                </span>
              </h2>
              <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {spaces.map((space) => (
                  <StaggerItem key={space.spaceId}>
                    <SpaceCard space={space} />
                  </StaggerItem>
                ))}
              </Stagger>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SpaceCard({ space }: { space: SpaceRow }) {
  const progress =
    space.totalTasks > 0
      ? (space.completedTasks / space.totalTasks) * 100
      : 0;
  return (
    <Link href={`/dashboard/s/${space.spaceId}`} className="lift block h-full">
      <Card className="h-full gap-0 rounded-2xl py-5">
        <CardContent className="px-5">
          <div className="flex items-start gap-3">
            <Orb
              seed={space.spaceId}
              label={space.name}
              color={space.color}
              shape="squircle"
              size="md"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate font-semibold">{space.name}</h3>
                {space.private && (
                  <Lock
                    className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                    aria-label="Private space"
                  />
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {space.workspaceName}
              </p>
            </div>
          </div>

          {space.description && (
            <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">
              {space.description}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <Stat icon={List} value={space.listCount} label="list" />
            <Stat icon={Folder} value={space.projectCount} label="project" />
            <Stat icon={FileText} value={space.docCount} label="doc" />
            <Stat
              icon={LayoutGrid}
              value={space.whiteboardCount}
              label="board"
            />
          </div>

          <div className="mt-4">
            <Progress value={progress} className="h-1.5" />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {space.completedTasks} of {space.totalTasks} tasks complete
            </p>
          </div>
          <p className="mt-4 text-xs font-medium">
            Open space
            <span aria-hidden className="ml-1">
              →
            </span>
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

function Stat({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof List;
  value: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {value} {label}
      {value === 1 ? "" : "s"}
    </span>
  );
}

function SpacesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-2xl panel p-5">
          <div className="h-9 w-9 animate-pulse rounded-xl bg-muted" />
          <div className="mt-4 h-4 w-2/3 animate-pulse rounded-full bg-muted" />
          <div className="mt-6 h-1.5 w-full animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}
