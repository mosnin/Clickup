"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Star } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AnimatedBar, Stagger, StaggerItem } from "@/components/motion";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

// All-projects directory: every list the current user can access, across
// their personal space and every workspace they belong to, in one
// searchable grid — the escape hatch from the sidebar tree once an
// account accumulates more projects than fit comfortably in it.

type ProjectRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.projectsDirectory.list>>
>["rows"][number];

type StatusFilter = "" | "on_track" | "at_risk" | "off_track" | "paused";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "", label: "All" },
  { key: "on_track", label: "On track" },
  { key: "at_risk", label: "At risk" },
  { key: "off_track", label: "Off track" },
  { key: "paused", label: "Paused" },
];

const STATUS_CHIP: Record<
  NonNullable<ProjectRow["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow" },
  off_track: { label: "Off track", className: "bg-pastel-red" },
  paused: { label: "Paused", className: "bg-muted" },
};

function formatTargetDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ProjectsView() {
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  const data = useQuery(api.projectsDirectory.list, {
    search: debounced || undefined,
    status: status || undefined,
  });
  const favorites = useQuery(api.favorites.listForCurrentUser, {});
  const toggleFavorite = useMutation(api.favorites.toggle);
  const { toast } = useToast();

  const favoritedListIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of favorites ?? []) {
      if (f.entityType === "list") set.add(f.entityId);
    }
    return set;
  }, [favorites]);

  async function onToggleFavorite(listId: Id<"lists">, wasFavorited: boolean) {
    try {
      await toggleFavorite({ entityType: "list", entityId: listId });
      toast(wasFavorited ? "Removed from favorites" : "Added to favorites");
    } catch {
      toast("Couldn't update favorites", { kind: "error" });
    }
  }

  return (
    <div className="space-y-6">
      <header className="title-rule">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Projects
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data === undefined
            ? "Gathering every project you can see…"
            : `${data.totalCount} project${data.totalCount === 1 ? "" : "s"} across your personal space and workspaces.`}
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={raw}
          onChange={(e) => setRaw(e.currentTarget.value)}
          placeholder="Search projects…"
          className="soft-field w-full px-3.5 py-2 text-sm sm:max-w-xs"
        />
        <nav aria-label="Health filter" className="segmented text-sm">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key || "all"}
              type="button"
              onClick={() => setStatus(f.key)}
              aria-pressed={status === f.key}
              className={cn(
                "rounded-full px-3 py-1.5 transition-colors",
                status === f.key
                  ? "segmented-on font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </nav>
      </div>

      {data === undefined ? (
        <ProjectsSkeleton />
      ) : data.rows.length === 0 ? (
        <EmptyState
          title="No projects match"
          message={
            debounced || status
              ? "Try a different search term or clear the health filter."
              : "Create a list inside your personal space or a workspace and it'll show up here."
          }
        />
      ) : (
        <>
          <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.rows.map((project) => (
              <StaggerItem key={project.listId}>
                <ProjectCard
                  project={project}
                  favorited={favoritedListIds.has(project.listId)}
                  onToggleFavorite={onToggleFavorite}
                />
              </StaggerItem>
            ))}
          </Stagger>
          {data.totalCount > data.rows.length && (
            <p className="text-center text-xs text-muted-foreground">
              Showing {data.rows.length} of {data.totalCount}. Narrow your
              search to see more.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  favorited,
  onToggleFavorite,
}: {
  project: ProjectRow;
  favorited: boolean;
  onToggleFavorite: (listId: Id<"lists">, wasFavorited: boolean) => void;
}) {
  const pct = project.total > 0 ? (project.done / project.total) * 100 : 0;
  const chip = project.projectStatus
    ? STATUS_CHIP[project.projectStatus]
    : null;
  const hasOpenWork = project.total - project.done > 0;
  const overdue =
    project.targetDate !== undefined &&
    project.targetDate < Date.now() &&
    hasOpenWork;

  return (
    <Link
      href={`/dashboard/l/${project.listId}`}
      className="lift block rounded-2xl bento p-5 hover:border-foreground/25"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {project.color && (
              <span
                aria-hidden
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: project.color }}
              />
            )}
            <p className="truncate font-semibold">{project.name}</p>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {project.place}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {chip && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium text-foreground",
                chip.className,
              )}
            >
              {chip.label}
            </span>
          )}
          <button
            type="button"
            aria-label={
              favorited
                ? `Remove ${project.name} from favorites`
                : `Add ${project.name} to favorites`
            }
            aria-pressed={favorited}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleFavorite(project.listId, favorited);
            }}
            className={cn(
              "tap-target inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors",
              favorited
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Star
              className={cn("h-4 w-4", favorited && "fill-current")}
              aria-hidden
            />
          </button>
        </div>
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
          {project.done} of {project.total} task
          {project.total === 1 ? "" : "s"}
        </p>
      </div>

      {project.targetDate !== undefined && (
        <p
          className={cn(
            "mt-3 text-xs",
            overdue ? "font-medium text-danger" : "text-muted-foreground",
          )}
        >
          Target {formatTargetDate(project.targetDate)}
        </p>
      )}
    </Link>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-2xl bento p-5">
          <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-muted/60" />
          <div className="mt-6 h-1.5 w-full animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/4 animate-pulse rounded-full bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
