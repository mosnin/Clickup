"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderKanban, Star } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Stagger, StaggerItem } from "@/components/motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

// All-projects directory: every list the current user can access, across
// their personal space and every workspace they belong to, in one
// searchable grid — the escape hatch from the sidebar tree once an
// account accumulates more projects than fit comfortably in it. Sort and
// group-by live in the URL (?sort=, ?group=) so a curated view — "group
// by workspace, problems first" — is shareable and survives reload, same
// pattern as the list views' ?view=/?lane= params.

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
  on_track: {
    label: "On track",
    className: "bg-pastel-green dark:text-neutral-900",
  },
  at_risk: {
    label: "At risk",
    className: "bg-pastel-yellow dark:text-neutral-900",
  },
  off_track: {
    label: "Off track",
    className: "bg-pastel-red dark:text-neutral-900",
  },
  paused: { label: "Paused", className: "bg-muted" },
};

// ── Sort ─────────────────────────────────────────────────────────────
// "health" floats problems to the top: off track → at risk → paused →
// on track → no status, so a fleet review starts with what's burning.

type SortKey = "name" | "manual" | "target" | "health";

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "manual", label: "Manual order" },
  { id: "target", label: "Target date" },
  { id: "health", label: "Health" },
];

function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.id === value);
}

const HEALTH_RANK: Record<NonNullable<ProjectRow["projectStatus"]>, number> = {
  off_track: 0,
  at_risk: 1,
  paused: 2,
  on_track: 3,
};

function compareProjects(a: ProjectRow, b: ProjectRow, sort: SortKey): number {
  switch (sort) {
    case "manual": {
      // Sidebar order. Positions are per-parent, so this reads most
      // naturally combined with group-by Space; name breaks ties across
      // parents.
      if (a.position !== b.position) return a.position - b.position;
      break;
    }
    case "target": {
      // Soonest target first; projects without a target sink to the end.
      const at = a.targetDate ?? Number.POSITIVE_INFINITY;
      const bt = b.targetDate ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      break;
    }
    case "health": {
      const ar = a.projectStatus ? HEALTH_RANK[a.projectStatus] : 4;
      const br = b.projectStatus ? HEALTH_RANK[b.projectStatus] : 4;
      if (ar !== br) return ar - br;
      break;
    }
  }
  return a.name.localeCompare(b.name);
}

// ── Group ────────────────────────────────────────────────────────────

type GroupKey = "none" | "workspace" | "space";

const GROUP_OPTIONS: { id: GroupKey; label: string }[] = [
  { id: "none", label: "None" },
  { id: "workspace", label: "Workspace" },
  { id: "space", label: "Space" },
];

function isGroupKey(value: unknown): value is GroupKey {
  return GROUP_OPTIONS.some((o) => o.id === value);
}

function groupProjects(
  rows: ProjectRow[],
  group: GroupKey,
): { label: string; rows: ProjectRow[] }[] {
  const buckets = new Map<string, ProjectRow[]>();
  for (const row of rows) {
    const label = group === "workspace" ? row.workspaceName : row.place;
    const bucket = buckets.get(label);
    if (bucket) bucket.push(row);
    else buckets.set(label, [row]);
  }
  // Personal first, then workspaces alphabetically — matches the sidebar.
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      const aPersonal = a === "Personal" || a.startsWith("Personal · ");
      const bPersonal = b === "Personal" || b.startsWith("Personal · ");
      if (aPersonal !== bPersonal) return aPersonal ? -1 : 1;
      return a.localeCompare(b);
    })
    .map(([label, groupRows]) => ({ label, rows: groupRows }));
}

function formatTargetDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ProjectsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");

  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "name";
  const groupParam = searchParams.get("group");
  const group: GroupKey = isGroupKey(groupParam) ? groupParam : "none";

  // Defaults ("name" / "none") drop out of the URL so the bare
  // /dashboard/projects link stays clean.
  function setParam(key: "sort" | "group", value: string, defaultValue: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === defaultValue) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

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

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.rows].sort((a, b) => compareProjects(a, b, sort));
  }, [data, sort]);

  const groups = useMemo(
    () => (group === "none" ? null : groupProjects(sorted, group)),
    [sorted, group],
  );

  async function onToggleFavorite(listId: Id<"lists">, wasFavorited: boolean) {
    try {
      await toggleFavorite({ entityType: "list", entityId: listId });
      toast(wasFavorited ? "Removed from favorites" : "Added to favorites");
    } catch {
      toast("Couldn't update favorites", { kind: "error" });
    }
  }

  const sortLabel = SORT_OPTIONS.find((o) => o.id === sort)?.label ?? "Name";
  const groupLabel = GROUP_OPTIONS.find((o) => o.id === group)?.label ?? "None";

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderKanban}
        title="Projects"
        context={
          data === undefined
            ? undefined
            : `${data.totalCount} project${data.totalCount === 1 ? "" : "s"}`
        }
      >
        {/* Search + health filter + sort/group live in the header's own
            row (not the actions cluster, which sits flush beside the title
            with no wrap) so they wrap under the title instead of
            overflowing the page horizontally on narrow screens. */}
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Input
            value={raw}
            onChange={(e) => setRaw(e.currentTarget.value)}
            placeholder="Search projects…"
            className="h-8 w-40 sm:w-56"
          />
          <nav
            aria-label="Health filter"
            className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key || "all"}
                type="button"
                onClick={() => setStatus(f.key)}
                aria-pressed={status === f.key}
                className={cn(
                  "flex-shrink-0 rounded-md px-3 py-1.5 transition-colors",
                  status === f.key
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              options={SORT_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
              selectedId={sort}
              onSelect={(id) => {
                if (isSortKey(id)) setParam("sort", id, "name");
              }}
              label={`Sort · ${sortLabel}`}
            />
            <Picker
              options={GROUP_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
              selectedId={group}
              onSelect={(id) => {
                if (isGroupKey(id)) setParam("group", id, "none");
              }}
              label={`Group · ${groupLabel}`}
            />
          </div>
        </div>
      </PageHeader>

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
          {groups === null ? (
            <ProjectsGrid
              projects={sorted}
              favoritedListIds={favoritedListIds}
              onToggleFavorite={onToggleFavorite}
            />
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {g.label}
                    <span className="ml-2 normal-case tracking-normal">
                      {g.rows.length}
                    </span>
                  </h2>
                  <ProjectsGrid
                    projects={g.rows}
                    favoritedListIds={favoritedListIds}
                    onToggleFavorite={onToggleFavorite}
                  />
                </section>
              ))}
            </div>
          )}
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

function ProjectsGrid({
  projects,
  favoritedListIds,
  onToggleFavorite,
}: {
  projects: ProjectRow[];
  favoritedListIds: Set<string>;
  onToggleFavorite: (listId: Id<"lists">, wasFavorited: boolean) => void;
}) {
  return (
    <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <StaggerItem key={project.listId}>
          <ProjectCard
            project={project}
            favorited={favoritedListIds.has(project.listId)}
            onToggleFavorite={onToggleFavorite}
          />
        </StaggerItem>
      ))}
    </Stagger>
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
  // targetDate is a local-midnight day stamp: only overdue once the whole
  // target day has passed, not the instant the clock crosses midnight.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const overdue =
    project.targetDate !== undefined &&
    project.targetDate < startOfToday.getTime() &&
    hasOpenWork;

  return (
    <Link href={`/dashboard/l/${project.listId}`} className="lift block">
      <Card className="gap-0 rounded-2xl py-5">
        <CardContent className="px-5">
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
                <Badge className={cn("text-[10px] text-foreground", chip.className)}>
                  {chip.label}
                </Badge>
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

          {project.roadmapName && (
            <Badge
              className={cn(
                "mt-2 max-w-full text-[10px] text-foreground",
                "bg-pastel-purple dark:text-neutral-900",
              )}
            >
              <span className="truncate">
                {project.roadmapName}
                {project.phaseName ? ` · ${project.phaseName}` : ""}
              </span>
            </Badge>
          )}

          <div className="mt-4">
            <Progress value={pct} className="h-1.5" />
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
        </CardContent>
      </Card>
    </Link>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-2xl panel p-5">
          <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-muted/60" />
          <div className="mt-6 h-1.5 w-full animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/4 animate-pulse rounded-full bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
