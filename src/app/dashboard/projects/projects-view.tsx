"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderKanban, Star } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Stagger, StaggerItem } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { Tabs } from "@/components/interior/tabs";
import { Pagination } from "@/components/interior/pagination";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NotchCard } from "@/components/dashboard/notch-card";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";

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

const PROJECTS_PANEL_ID = "projects-directory-panel";

// 24 divides by 2, 3 and 4, so the last row of the grid is full at every
// breakpoint the cards lay out at.
const PAGE_SIZE = 24;

type StatusFilter = "" | "on_track" | "at_risk" | "off_track" | "paused";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "", label: "All" },
  { key: "on_track", label: "On track" },
  { key: "at_risk", label: "At risk" },
  { key: "off_track", label: "Off track" },
  { key: "paused", label: "Paused" },
];

// Outlined chip + status dot — the one chip language, matching Home.
const STATUS_CHIP: Record<
  NonNullable<ProjectRow["projectStatus"]>,
  { label: string; dot: string }
> = {
  on_track: {
    label: "On track",
    dot: "bg-pastel-green",
  },
  at_risk: {
    label: "At risk",
    dot: "bg-pastel-yellow",
  },
  off_track: {
    label: "Off track",
    dot: "bg-pastel-red",
  },
  paused: { label: "Paused", dot: "bg-muted-foreground/50" },
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
  const pathname = usePathname();
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");

  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "name";
  const groupParam = searchParams.get("group");
  const group: GroupKey = isGroupKey(groupParam) ? groupParam : "none";

  // Defaults ("name" / "none") drop out of the URL so the bare
  // /dashboard/projects link stays clean.
  function setParam(
    key: "sort" | "group" | "page",
    value: string,
    defaultValue: string,
  ) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === defaultValue) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  // Narrowing the set returns you to its start. Without this, searching while
  // on page 4 leaves you on page 4 of a one-page result — the clamp above
  // stops it rendering empty, but landing mid-list after a search you just
  // typed reads as the search having failed.
  const resetPage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("page")) return;
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const data = useQuery(api.projectsDirectory.list, {
    search: debounced || undefined,
    status: status || undefined,
  });
  const favorites = useQuery(api.favorites.listForCurrentUser, {});
  const toggleFavorite = useMutation(api.favorites.toggle);
  const { toast } = useToast();

  const favoritedProjectIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of favorites ?? []) {
      if (f.entityType === "project") set.add(f.entityId);
    }
    return set;
  }, [favorites]);

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.rows].sort((a, b) => compareProjects(a, b, sort));
  }, [data, sort]);

  // Paging is over the SORTED FLAT list, and groups are built from the page
  // rather than the page from the groups. One rule for both modes: a page is
  // always PAGE_SIZE rows, and a group heading appears on whichever page its
  // rows fell on. Paging per-group instead would mean a page whose size
  // depends on which groups it happens to span.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  // Clamped, not trusted: ?page=99 arrives from a shared link and from
  // pressing back after the filter narrowed. An out-of-range page must show
  // the last page, never an empty screen under a full-looking header.
  const pageParam = Number(searchParams.get("page") ?? 1);
  const page = Math.min(
    Math.max(1, Number.isFinite(pageParam) ? Math.trunc(pageParam) : 1),
    pageCount,
  );
  const paged = useMemo(
    () => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sorted, page],
  );

  const groups = useMemo(
    () => (group === "none" ? null : groupProjects(paged, group)),
    [paged, group],
  );

  // The one signal-colour moment on this page: exactly one card, chosen by
  // urgency — most overdue open work, then nearest target date — never by
  // position. Computed over the whole visible page so grouping never splits
  // the highlight across sections. Mirrors Home's ProjectCards rule.
  const urgentProjectId = useMemo(
    () => pickUrgentProjectId(paged),
    [paged],
  );

  async function onToggleFavorite(listId: Id<"projects">, wasFavorited: boolean) {
    try {
      await toggleFavorite({ entityType: "project", entityId: listId });
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
        eyebrow="What you are running"
        description="Every board across every space, in one directory you can sort and group."
        icon={FolderKanban}
        title="Projects"
        context={
          data === undefined
            ? undefined
            : `${data.totalCount} project${data.totalCount === 1 ? "" : "s"}`
        }
      >
        {/* Two rows, and the split is the point. Search and sort/group are
            *controls* — they change how the set is drawn. Health is a
            *place* — it changes which set you are looking at. They used to
            share one wrapping row, where the filter buttons read as three
            more widgets among five and the strip could never sit flush.

            Controls first, then the tab strip alone on the header's bottom
            edge, so the rule under the selected tab and the header's own
            border are one line. */}
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Input
            value={raw}
            onChange={(e) => {
              setRaw(e.currentTarget.value);
              resetPage();
            }}
            placeholder="Search projects…"
            className="h-8 w-40 sm:w-56"
          />
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
        <Tabs
          items={STATUS_FILTERS.map((f) => ({
            value: f.key || "all",
            label: f.label,
          }))}
          value={status || "all"}
          onValueChange={(v) => {
            setStatus(v === "all" ? "" : (v as StatusFilter));
            resetPage();
          }}
          label="Filter projects by health"
          // Manual: each change is a refetch and a re-sort of the whole
          // directory, so arrowing across five tabs must not fire five of
          // them. The reader picks, then presses.
          activation="manual"
          panelId={PROJECTS_PANEL_ID}
        />
      </PageHeader>


      {/* The strip's panel, named rather than nested: the results are a page
          of content under a sticky header, not something that can live inside
          the header itself. `aria-controls` still has a real target, which is
          the part that matters to a screen reader. */}
      <div id={PROJECTS_PANEL_ID} role="tabpanel" aria-label="Projects">
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
              projects={paged}
              favoritedProjectIds={favoritedProjectIds}
              onToggleFavorite={onToggleFavorite}
              urgentProjectId={urgentProjectId}
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
                    favoritedProjectIds={favoritedProjectIds}
                    onToggleFavorite={onToggleFavorite}
                    urgentProjectId={urgentProjectId}
                  />
                </section>
              ))}
            </div>
          )}
          <Pagination
            count={pageCount}
            page={page}
            label="Projects"
            onPageChange={(next) => setParam("page", String(next), "1")}
            className="pt-2"
          />
          {/* Only when the SERVER truncated, which is a different condition
              from "this page is one of several" and needs saying separately —
              the pager can reach every row it was given, and these are rows it
              was not given. */}
          {data.totalCount > data.rows.length && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the first {data.rows.length} of {data.totalCount}. Narrow
              your search to reach the rest.
            </p>
          )}
        </>
      )}
      </div>
    </div>
  );
}

// The project that needs attention soonest: most overdue open work, then
// nearest target date. Never "the first one" — a highlight that never moves
// is decoration. The directory doesn't carry a per-project overdue task
// count (unlike Home's rollup), so "most overdue" is read off how far past
// its target date a project with open work still sits.
function pickUrgentProjectId(rows: ProjectRow[]): string | null {
  if (rows.length === 0) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  function overdueBy(p: ProjectRow): number {
    if (p.targetDate === undefined) return 0;
    if (p.total - p.done <= 0) return 0; // no open work left to be late on
    return p.targetDate < today ? today - p.targetDate : 0;
  }
  const urgent = [...rows].sort(
    (a, b) =>
      overdueBy(b) - overdueBy(a) ||
      (a.targetDate ?? Infinity) - (b.targetDate ?? Infinity),
  )[0];
  return urgent.projectId;
}

function HealthChip({ status }: { status: ProjectRow["projectStatus"] }) {
  const chip = status ? STATUS_CHIP[status] : null;
  if (!chip) return null;
  return (
    <span className="ui-chip inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium">
      <span aria-hidden className={cn("size-1.5 rounded-full", chip.dot)} />
      {chip.label}
    </span>
  );
}

function ProjectsGrid({
  projects,
  favoritedProjectIds,
  onToggleFavorite,
  urgentProjectId,
}: {
  projects: ProjectRow[];
  favoritedProjectIds: Set<string>;
  onToggleFavorite: (listId: Id<"projects">, wasFavorited: boolean) => void;
  urgentProjectId: string | null;
}) {
  return (
    <Stagger className="grid auto-rows-fr grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <StaggerItem key={project.projectId} lift className="h-full min-w-0">
          <ProjectCard
            project={project}
            favorited={favoritedProjectIds.has(project.projectId)}
            onToggleFavorite={onToggleFavorite}
            lime={project.projectId === urgentProjectId}
          />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

// Cyberlock notch card, carrying a project instead of a campaign: corner
// scoop holds the favorite toggle, the body splits into a content cell and a
// done/total figure cell, and a footer band holds the open action. Exactly
// one card on the page — the one `urgentProjectId` names — wears signal lime;
// every other card stays the plain panel tone. See Home's ProjectCards.
function ProjectCard({
  project,
  favorited,
  onToggleFavorite,
  lime,
}: {
  project: ProjectRow;
  favorited: boolean;
  onToggleFavorite: (listId: Id<"projects">, wasFavorited: boolean) => void;
  lime: boolean;
}) {
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
    <NotchCard
      tone={lime ? "lime" : "panel"}
      corner={
        <button
          type="button"
          aria-label={
            favorited
              ? `Remove ${project.name} from favorites`
              : `Add ${project.name} to favorites`
          }
          aria-pressed={favorited}
          onClick={() => onToggleFavorite(project.projectId, favorited)}
          className="flex size-9 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-muted"
        >
          <Star
            className={cn("size-4", favorited && "fill-current")}
            aria-hidden
          />
        </button>
      }
      className="h-full"
    >
      <div className="grid grid-cols-[1fr_auto]">
        <div className="min-w-0 p-4 pr-2">
          {/* Clears the notch: the title starts below the scoop's reach so a
              long name never runs under the favorite control. */}
          <div className="flex items-center gap-1.5 pr-10">
            {project.color && (
              <span
                aria-hidden
                className="size-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: project.color }}
              />
            )}
            <p className="line-clamp-2 font-title text-base font-bold leading-snug">
              {project.name}
            </p>
          </div>
          <p className={cn("mt-1 truncate text-xs", lime ? "opacity-60" : "text-muted-foreground")}>
            {project.place}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {project.projectStatus && <HealthChip status={project.projectStatus} />}
            {overdue && (
              <span
                className={cn(
                  "ui-chip px-2 py-0.5 text-[11px] font-medium",
                  !lime && "border-danger/40 text-danger",
                )}
              >
                Past target
              </span>
            )}
            {project.roadmapName && (
              <span className={cn("ui-chip max-w-full truncate px-2 py-0.5 text-[11px]", !lime && "text-muted-foreground")}>
                {project.roadmapName}
                {project.phaseName ? ` · ${project.phaseName}` : ""}
              </span>
            )}
            {project.targetDate !== undefined && (
              <span className={cn("ui-chip ui-figure px-2 py-0.5 text-[11px]", !lime && "text-muted-foreground")}>
                {formatTargetDate(project.targetDate)}
              </span>
            )}
          </div>
        </div>
        <div
          className={cn(
            // pt-14, not centred: the scoop owns the cell's top 56px, and a
            // centred figure on a short card lands exactly under it.
            "flex min-w-[6.5rem] flex-col items-center justify-start border-l px-3 pb-4 pt-14",
            lime ? "border-current/15" : "border-border",
          )}
        >
          <span className="font-title whitespace-nowrap text-2xl font-bold leading-none tracking-tight">
            {project.done}
            <span className="text-sm font-semibold opacity-50">
              /{project.total}
            </span>
          </span>
          <span className={cn("mt-1 text-[10px] font-medium uppercase tracking-wider", lime ? "opacity-60" : "text-muted-foreground")}>
            done
          </span>
        </div>
      </div>
      <div className={cn("flex items-center justify-between gap-3 border-t px-4 py-2.5", lime ? "border-current/15" : "border-border")}>
        <span className={cn("truncate text-[11px]", lime ? "opacity-60" : "text-muted-foreground")}>
          active {timeAgo(project.activityAt)}
        </span>
        <Link
          href={`/dashboard/p/${project.projectId}`}
          className={cn(
            "flex-shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-[1.03]",
            lime
              ? "bg-signal-ink text-signal-lime"
              : "bg-primary text-primary-foreground",
          )}
        >
          Open project
        </Link>
      </div>
    </NotchCard>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-2xl border border-border bg-card p-5">
          <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-muted/60" />
          <div className="mt-6 h-8 w-1/4 animate-pulse rounded-full bg-muted" />
          <div className="mt-2 h-3 w-1/4 animate-pulse rounded-full bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
