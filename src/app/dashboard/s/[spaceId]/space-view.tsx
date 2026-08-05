"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  FolderInput,
  LayoutGrid,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  AnimatedBar,
  SPRING,
  Stagger,
  StaggerItem,
  motion,
} from "@/components/motion";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Monogram } from "@/components/dashboard/monogram";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { Tabs } from "@/components/interior/tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { TemplatePicker } from "@/components/dashboard/template-picker";
import { Button } from "@/components/ui/button";
import { Picker, type PickerOption } from "@/components/ui/picker";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { useProjectExpanded } from "@/lib/project-collapse";

// The Space page: a ClickUp-style Space now has identity (name/color/
// description), privacy (creator/owner-governed membership), an archive
// state, and default statuses for new lists. Two tabs — Overview (what's
// inside) and Settings (identity + governance) — driven by local state, no
// URL param needed since neither is deep-linkable content.

type Overview = NonNullable<
  ReturnType<typeof useQuery<typeof api.spaces.overview>>
>;
type SpaceDoc = Overview["space"];
type ListRollup = Overview["lists"][number];
type MemberRow = Overview["members"][number];
type StatusCategory = "open" | "in_progress" | "complete" | "closed";
type DefaultStatus = { name: string; color: string; category: StatusCategory };

// The 8 sanctioned swatch hexes — pastel accent tokens plus ink, used for
// both a Space's identity color and (cycled) new default-status colors.
const SWATCHES = [
  "#a9c6f2",
  "#f2b3ab",
  "#f2c291",
  "#c9e8b8",
  "#d9c9f2",
  "#f2c9e4",
  "#c9ccd4",
  "#101012",
];

const STATUS_CHIP: Record<
  NonNullable<ListRollup["projectStatus"]>,
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

const CATEGORY_LABEL: Record<StatusCategory, string> = {
  open: "Open",
  in_progress: "In progress",
  complete: "Complete",
  closed: "Closed",
};

export function SpaceView({ spaceId }: { spaceId: string }) {
  const id = spaceId as Id<"spaces">;
  const overview = useQuery(api.spaces.overview, { spaceId: id });
  const router = useRouter();
  const SPACE_PANEL_ID = "space-section-panel";
  const [tab, setTab] = useState<"overview" | "settings">("overview");
  const [templateOpen, setTemplateOpen] = useState(false);

  if (overview === undefined) {
    return <PageSkeleton />;
  }
  if (overview === null) {
    return (
      <div className="rounded-2xl panel p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This Space doesn&apos;t exist or you don&apos;t have access to it.
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

  const { space, lists, projects, pages, whiteboards, members, canGovern } =
    overview;
  const spaceName = space.name;
  const showWhiteboards = space.features?.whiteboards !== false;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={"Space"}
        description={space.description || "The projects, lists and pages inside this space."}
        icon={Boxes}
        title={space.name}
        context={
          (space.private || space.archivedAt) && (
            <>
              {space.private && (
                <Badge variant="outline" className="gap-1">
                  <Lock className="h-3 w-3" /> Private
                </Badge>
              )}
              {space.archivedAt && (
                <Badge variant="outline" className="uppercase tracking-wider">
                  Archived
                </Badge>
              )}
            </>
          )
        }
        actions={
          tab === "overview" && !space.archivedAt ? (
            <div className="flex items-center gap-2">
              {/* The customiser lives at a route inside the space, so opening
                  it previews this space's look across the whole shell. */}
              <Button size="sm" variant="outline" asChild>
                <Link href={`/dashboard/s/${space._id}/appearance`}>Look</Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTemplateOpen(true)}
              >
                <LayoutTemplate className="h-4 w-4" />
                Use template
              </Button>
            </div>
          ) : undefined
        }
      >
        <Tabs
          items={[
            { value: "overview", label: "Overview" },
            { value: "settings", label: "Settings" },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as "overview" | "settings")}
          label="Space sections"
          activation="automatic"
          panelId={SPACE_PANEL_ID}
        />
      </PageHeader>

      <div id={SPACE_PANEL_ID} role="tabpanel" aria-label="Space">
      {tab === "overview" ? (
        <OverviewTab
          spaceId={id}
          spaceName={spaceName}
          lists={lists}
          projects={projects}
          pages={pages}
          scopeType={space.parentType}
          scopeId={space.parentId}
          whiteboards={whiteboards}
          showWhiteboards={showWhiteboards}
        />
      ) : (
        <SettingsTab
          spaceId={id}
          space={space}
          members={members}
          canGovern={canGovern}
        />
      )}
      </div>
      <TemplatePicker
        open={templateOpen}
        parent={{ kind: "space", spaceId: id }}
        onClose={() => setTemplateOpen(false)}
        onCreated={(listId) => {
          setTemplateOpen(false);
          router.push(`/dashboard/l/${listId}`);
        }}
      />
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab({
  spaceId,
  spaceName,
  lists,
  projects,
  pages,
  scopeType,
  scopeId,
  whiteboards,
  showWhiteboards,
}: {
  spaceId: Id<"spaces">;
  spaceName: string;
  lists: Overview["lists"];
  projects: Overview["projects"];
  pages: Overview["pages"];
  scopeType: "user" | "workspace";
  scopeId: string;
  whiteboards: Overview["whiteboards"];
  showWhiteboards: boolean;
}) {
  const rollupsById = useMemo(
    () => new Map(lists.map((l) => [l.listId as string, l])),
    [lists],
  );
  // Destination catalogue for "move a project", shared by every card on
  // the page: the Space itself plus each of its projects. The row filters
  // out wherever the project already lives.
  const dest = useMemo(
    () => ({ spaceId, spaceName, projects }),
    [spaceId, spaceName, projects],
  );

  return (
    <div className="space-y-6">
      {/* Ordering rule (mirrored in the sidebar tree): projects first, then
          the Space's own projects — each by position, createdAt tiebreak,
          sorted server-side. */}
      <div className="flex flex-wrap items-center gap-2">
        <NewProjectControl spaceId={spaceId} />
      </div>

      {projects.map((f) => (
        <ProjectSection
          key={f.projectId}
          project={f}
          spaceName={spaceName}
          hasLists={lists.some((l) => l.projectId === f.projectId)}
          rollupsById={rollupsById}
          fallback={lists.filter((l) => l.projectId === f.projectId)}
          dest={dest}
        />
      ))}

      <ListSection
        title="Lists"
        parentType="space"
        parentId={spaceId}
        rollupsById={rollupsById}
        fallback={lists.filter((l) => l.projectId === null)}
        dest={dest}
        emptyMessage={`Lists created straight in ${spaceName} live here. Group them into a project whenever it helps.`}
      />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {showWhiteboards ? "Pages & boards" : "Pages"}
        </h2>
        {pages.length === 0 && (!showWhiteboards || whiteboards.length === 0) ? (
          <div className="mt-3 rounded-2xl panel">
            <EmptyState
              compact
              title="Nothing here yet"
              message={
                showWhiteboards
                  ? "Write a page or sketch a board to start capturing what this Space is for."
                  : "Write a page to start capturing what this Space is for."
              }
            />
          </div>
        ) : (
          <div
            className={cn(
              "mt-3 grid gap-3",
              showWhiteboards && "sm:grid-cols-2",
            )}
          >
            <PageList
              spaceId={spaceId}
              scopeType={scopeType}
              scopeId={scopeId}
              pages={pages}
            />
            {showWhiteboards && (
              <WhiteboardList spaceId={spaceId} whiteboards={whiteboards} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// One reorderable card grid under a single lists-parent (the space itself,
// or one of its projects). Ordering truth comes from the raw lists rows
// (position asc, createdAt tiebreak) fetched per parent; the overview
// rollups are joined in by id. Reorders apply optimistically via a local
// order override, then persist through api.lists.reorder — on refusal the
// override reverts and the server's reason surfaces as an error toast.
function ListSection({
  title,
  parentType,
  parentId,
  rollupsById,
  fallback,
  hideProjectLine,
  dest,
  emptyMessage,
}: {
  /** Omit to let the caller (a project header) own the heading. */
  title?: string;
  parentType: "space" | "project";
  parentId: string;
  rollupsById: Map<string, ListRollup>;
  fallback: ListRollup[];
  hideProjectLine?: boolean;
  dest: MoveDest;
  emptyMessage: string;
}) {
  const raw = useQuery(api.lists.listForParent, { parentType, parentId });
  const reorder = useMutation(api.lists.reorder);
  const { toast } = useToast();
  const [override, setOverride] = useState<Id<"lists">[] | null>(null);

  const serverIds = useMemo(() => {
    if (raw === undefined) return null;
    return [...raw]
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
      .map((l) => l._id);
  }, [raw]);

  // Once the server order converges with (or diverges in membership from)
  // the override, drop it — otherwise a later reorder by someone else would
  // stay masked behind our stale local order forever.
  const serverKey = serverIds?.join(",") ?? null;
  useEffect(() => {
    if (serverKey === null) return;
    setOverride((cur) => {
      if (!cur) return cur;
      const ids = serverKey === "" ? [] : serverKey.split(",");
      const curIds = cur.map((id) => id as string);
      const sameSet =
        curIds.length === ids.length && ids.every((id) => curIds.includes(id));
      if (!sameSet || curIds.join(",") === serverKey) return null;
      return cur;
    });
  }, [serverKey]);

  // The override only holds while it's a permutation of the server's id
  // set; a list created/deleted elsewhere invalidates it automatically.
  const orderedIds = useMemo(() => {
    if (serverIds === null) return null;
    if (
      override !== null &&
      override.length === serverIds.length &&
      serverIds.every((id) => override.includes(id))
    ) {
      return override;
    }
    return serverIds;
  }, [serverIds, override]);

  function move(listId: Id<"lists">, dir: -1 | 1) {
    if (orderedIds === null) return;
    const idx = orderedIds.indexOf(listId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[idx], next[j]] = [next[j], next[idx]];
    const prev = orderedIds;
    setOverride(next);
    reorder({ parentType, parentId, orderedIds: next }).catch((e) => {
      setOverride(prev);
      toast(errorMessage(e, "Couldn't reorder"), { kind: "error" });
    });
  }

  // Until the raw rows arrive, fall back to the overview's rollups (their
  // relative order is close enough for a single paint) without affordances.
  const rows: ListRollup[] =
    orderedIds === null
      ? fallback
      : orderedIds.flatMap((id) => rollupsById.get(id as string) ?? []);

  return (
    <section>
      {title && (
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="truncate">{title}</span>
        </h2>
      )}
      {rows.length === 0 ? (
        <div className="mt-3 rounded-2xl panel">
          <EmptyState
            compact
            title="No lists yet"
            message={emptyMessage}
            action={
              <NewListControl parentType={parentType} parentId={parentId} />
            }
          />
        </div>
      ) : (
        <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((list, i) => (
            <StaggerItem key={list.listId}>
              <motion.div layout transition={SPRING} className="h-full">
                <ProjectCard
                  list={list}
                  hideProjectLine={hideProjectLine}
                  parent={{ type: parentType, id: parentId }}
                  dest={dest}
                  reorder={
                    orderedIds !== null
                      ? {
                          canUp: i > 0,
                          canDown: i < rows.length - 1,
                          onMove: (dir) => move(list.listId, dir),
                        }
                      : undefined
                  }
                />
              </motion.div>
            </StaggerItem>
          ))}
          <StaggerItem>
            <NewListCard parentType={parentType} parentId={parentId} />
          </StaggerItem>
        </Stagger>
      )}
    </section>
  );
}

// ── Projects ───────────────────────────────────────────────────────────────
//
// A project is a sibling of the Space's own projects, not a different kind
// of thing: same card grid inside, collapsible header outside, rename and
// delete on the header's overflow menu. Deleting one keeps every project —
// the server moves them up to the Space (convex/projects.ts).

type MoveDest = {
  spaceId: Id<"spaces">;
  spaceName: string;
  projects: Overview["projects"];
};

function moveOptions(
  dest: MoveDest,
  parent: { type: "space" | "project"; id: string },
): PickerOption[] {
  const out: PickerOption[] = [];
  if (parent.type !== "space") {
    out.push({
      id: `space:${dest.spaceId}`,
      label: dest.spaceName,
      hint: "space",
    });
  }
  for (const f of dest.projects) {
    if (parent.type === "project" && parent.id === f.projectId) continue;
    out.push({ id: `project:${f.projectId}`, label: f.name, hint: "project" });
  }
  return out;
}

function ProjectSection({
  project,
  spaceName,
  hasLists,
  rollupsById,
  fallback,
  dest,
}: {
  project: Overview["projects"][number];
  spaceName: string;
  hasLists: boolean;
  rollupsById: Map<string, ListRollup>;
  fallback: ListRollup[];
  dest: MoveDest;
}) {
  const [expanded, setExpanded] = useProjectExpanded(project.projectId);
  const [renaming, setRenaming] = useState(false);
  const [hidden, setHidden] = useState(false);
  const renameProject = useMutation(api.projects.rename);
  const removeProject = useMutation(api.projects.remove);
  const { toast } = useToast();

  // Deferred delete: the section disappears immediately and the mutation
  // only runs when the undo window closes.
  if (hidden) return null;

  return (
    <section>
      <div className="group/project flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded()}
          className="tap-target -ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </button>
        {renaming ? (
          <InlineCreate
            placeholder="Project name…"
            initialValue={project.name}
            className="min-w-0 flex-1"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await renameProject({ projectId: project.projectId, name });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename project"), {
                  kind: "error",
                });
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Link
                href={`/dashboard/p/${project.projectId}`}
                className="hover:text-foreground"
              >
                {project.name}
              </Link>
            </h2>
            <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Project
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Project actions for ${project.name}`}
                  className="tap-target flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-focus-within/project:opacity-100 sm:group-hover/project:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  Rename project
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setHidden(true);
                    toast(
                      hasLists
                        ? `"${project.name}" deleted — its lists moved to ${spaceName}`
                        : `"${project.name}" deleted`,
                      {
                        action: {
                          label: "Undo",
                          onClick: () => setHidden(false),
                        },
                        onExpire: () =>
                          void removeProject({ projectId: project.projectId }),
                      },
                    );
                  }}
                >
                  Delete project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {expanded && (
        <div className="mt-1">
          <ListSection
            parentType="project"
            parentId={project.projectId}
            rollupsById={rollupsById}
            fallback={fallback}
            dest={dest}
            hideProjectLine
            emptyMessage={`Nothing in ${project.name} yet. Add a list here, or move an existing one in from ${spaceName}.`}
          />
        </div>
      )}
    </section>
  );
}

function NewProjectControl({ spaceId }: { spaceId: Id<"spaces"> }) {
  const [adding, setAdding] = useState(false);
  const createProject = useMutation(api.projects.create);
  const { toast } = useToast();

  if (adding) {
    return (
      <InlineCreate
        placeholder="Project name…"
        className="w-full max-w-xs"
        onCancel={() => setAdding(false)}
        onSubmit={async (name) => {
          try {
            await createProject({ spaceId, name });
            setAdding(false);
          } catch (e) {
            toast(errorMessage(e, "Couldn't create project"), { kind: "error" });
            setAdding(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="inline-flex min-h-9 items-center gap-1 rounded-full border border-dashed border-border px-3 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      <Plus className="h-3.5 w-3.5" /> New project
    </button>
  );
}

function ProjectCard({
  list,
  hideProjectLine,
  parent,
  dest,
  reorder,
}: {
  list: ListRollup;
  hideProjectLine?: boolean;
  parent: { type: "space" | "project"; id: string };
  dest: MoveDest;
  reorder?: {
    canUp: boolean;
    canDown: boolean;
    onMove: (dir: -1 | 1) => void;
  };
}) {
  const pct = list.total > 0 ? (list.done / list.total) * 100 : 0;
  const chip = list.projectStatus ? STATUS_CHIP[list.projectStatus] : null;
  const [moving, setMoving] = useState(false);
  const moveList = useMutation(api.lists.move);
  const { toast } = useToast();
  const options = moveOptions(dest, parent);

  // The card is one big <Link>; every control inside it swallows the click
  // (preventDefault + stopPropagation) so pressing a button never also
  // navigates. The Picker's popover is portaled to <body>, so its own
  // clicks never reach this subtree at all.
  function swallow(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <Link
      href={`/dashboard/l/${list.listId}`}
      className="lift group block h-full rounded-2xl panel p-5 hover:border-foreground/25"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{list.name}</p>
          {!hideProjectLine && list.project !== null && (
            <p className="truncate text-xs text-muted-foreground">
              in {list.project}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
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
          {reorder && (
            <span className="-my-1 -mr-2 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              {options.length > 0 && (
                <button
                  type="button"
                  aria-label={`Move ${list.name} to another project`}
                  title="Move to…"
                  onClick={(e) => {
                    swallow(e);
                    setMoving((v) => !v);
                  }}
                  className="tap-target rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                aria-label={`Move ${list.name} earlier`}
                disabled={!reorder.canUp}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  reorder.onMove(-1);
                }}
                className="tap-target rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${list.name} later`}
                disabled={!reorder.canDown}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  reorder.onMove(1);
                }}
                className="tap-target rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      </div>

      {moving && (
        <div
          onClick={swallow}
          className="mt-3 flex min-w-0 flex-wrap items-center gap-2"
        >
          <Picker
            dashed
            className="min-w-0"
            label="Move to…"
            options={options}
            onSelect={async (value) => {
              const [type, id] = value.split(":");
              setMoving(false);
              try {
                await moveList({
                  listId: list.listId,
                  parentType: type === "project" ? "project" : "space",
                  parentId: id,
                });
                toast(`"${list.name}" moved`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't move list"), {
                  kind: "error",
                });
              }
            }}
          />
          <button
            type="button"
            onClick={(e) => {
              swallow(e);
              setMoving(false);
            }}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {list.description && (
        <p className="mt-2 line-clamp-1 text-sm text-muted-foreground">
          {list.description}
        </p>
      )}

      <div className="mt-4">
        <AnimatedBar
          pct={pct}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          barClassName="block h-full rounded-full bg-foreground"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {list.done} of {list.total} done
        </p>
      </div>

      {list.overdue > 0 && (
        <p className="mt-3 text-xs text-danger">{list.overdue} overdue</p>
      )}
    </Link>
  );
}

// Pill variant of "new list", for the single action slot an EmptyState
// allows. Same behaviour as NewListCard, different shell.
function NewListControl({
  parentType,
  parentId,
}: {
  parentType: "space" | "project";
  parentId: string;
}) {
  const [adding, setAdding] = useState(false);
  const createList = useMutation(api.lists.create);
  const router = useRouter();
  const { toast } = useToast();

  if (adding) {
    return (
      <InlineCreate
        placeholder="List name…"
        className="w-full max-w-xs"
        onCancel={() => setAdding(false)}
        onSubmit={async (name) => {
          try {
            const listId = await createList({ name, parentType, parentId });
            router.push(`/dashboard/l/${listId}`);
          } catch (e) {
            toast(errorMessage(e, "Couldn't create list"), { kind: "error" });
            setAdding(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="inline-flex min-h-9 items-center gap-1 rounded-full bg-foreground px-4 text-sm font-medium text-background"
    >
      <Plus className="h-3.5 w-3.5" /> New list
    </button>
  );
}

function NewListCard({
  parentType,
  parentId,
}: {
  parentType: "space" | "project";
  parentId: string;
}) {
  const [adding, setAdding] = useState(false);
  const createList = useMutation(api.lists.create);
  const router = useRouter();
  const { toast } = useToast();

  if (adding) {
    return (
      <div className="flex h-full min-h-[152px] flex-col justify-center rounded-2xl panel p-5">
        <InlineCreate
          placeholder="List name…"
          onCancel={() => setAdding(false)}
          onSubmit={async (name) => {
            try {
              const listId = await createList({
                name,
                parentType,
                parentId,
              });
              router.push(`/dashboard/l/${listId}`);
            } catch (e) {
              toast(errorMessage(e, "Couldn't create list"), {
                kind: "error",
              });
              setAdding(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="lift flex h-full min-h-[152px] w-full flex-col items-center justify-center gap-2 rounded-2xl bento-tile p-5 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <Plus className="h-4 w-4" />
      New list
    </button>
  );
}

function PageList({
  spaceId,
  scopeType,
  scopeId,
  pages,
}: {
  spaceId: Id<"spaces">;
  scopeType: "user" | "workspace";
  scopeId: string;
  pages: Overview["pages"];
}) {
  const [adding, setAdding] = useState(false);
  const createPage = useMutation(api.pages.create);
  const router = useRouter();
  const { toast } = useToast();

  return (
    <div className="rounded-2xl panel p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Pages
      </h3>
      <ul className="mt-2 space-y-0.5">
        {pages.map((d) => (
          <li key={d.pageId}>
            <Link
              href={`/dashboard/pages/${d.pageId}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
            >
              <FileText
                className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{d.title}</span>
              {d.pinned && (
                <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  context
                </span>
              )}
            </Link>
          </li>
        ))}
        {pages.length === 0 && !adding && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No pages yet.
          </li>
        )}
      </ul>
      {adding ? (
        <div className="mt-1.5">
          <InlineCreate
            placeholder="Page title…"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              try {
                // Started from this space, so it belongs to this space —
                // the starting point decides, not a second dialog.
                const pageId = await createPage({
                  scopeType,
                  scopeId,
                  title,
                  attachTo: { targetType: "space", targetId: spaceId },
                });
                router.push(`/dashboard/pages/${pageId}`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create the page"), {
                  kind: "error",
                });
                setAdding(false);
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> New page
        </button>
      )}
    </div>
  );
}

function WhiteboardList({
  spaceId,
  whiteboards,
}: {
  spaceId: Id<"spaces">;
  whiteboards: Overview["whiteboards"];
}) {
  const [adding, setAdding] = useState(false);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const router = useRouter();
  const { toast } = useToast();

  return (
    <div className="rounded-2xl panel p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Whiteboards
      </h3>
      <ul className="mt-2 space-y-0.5">
        {whiteboards.map((w) => (
          <li key={w.whiteboardId}>
            <Link
              href={`/dashboard/wb/${w.whiteboardId}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
            >
              <LayoutGrid
                className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{w.title}</span>
            </Link>
          </li>
        ))}
        {whiteboards.length === 0 && !adding && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No whiteboards yet.
          </li>
        )}
      </ul>
      {adding ? (
        <div className="mt-1.5">
          <InlineCreate
            placeholder="Whiteboard title…"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              try {
                const wbId = await createWhiteboard({
                  parentType: "space",
                  parentId: spaceId,
                  title,
                });
                router.push(`/dashboard/wb/${wbId}`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create whiteboard"), {
                  kind: "error",
                });
                setAdding(false);
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> New whiteboard
        </button>
      )}
    </div>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────

function SettingsTab({
  spaceId,
  space,
  members,
  canGovern,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
  members: MemberRow[];
  canGovern: boolean;
}) {
  return (
    <div className="space-y-6">
      <IdentityCard spaceId={spaceId} space={space} />
      <DefaultStatusesCard spaceId={spaceId} space={space} />
      <FeaturesCard spaceId={spaceId} space={space} />
      {space.parentType === "workspace" && (
        <PrivacyCard
          spaceId={spaceId}
          space={space}
          members={members}
          canGovern={canGovern}
        />
      )}
      <DangerCard spaceId={spaceId} space={space} />
    </div>
  );
}

function IdentityCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");

  async function commit(patch: Record<string, unknown>, revert: () => void) {
    try {
      await update({ spaceId, ...patch });
      toast("Saved");
    } catch (e) {
      revert();
      toast(errorMessage(e, "Couldn't save"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Identity
      </h2>

      <label className="mt-4 block text-xs font-medium text-muted-foreground">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (!trimmed || trimmed === space.name) {
              setName(space.name);
              return;
            }
            commit({ name: trimmed }, () => setName(space.name));
          }}
          className="soft-field mt-1 block w-full px-3 py-2 text-sm text-foreground focus:outline-none"
        />
      </label>

      <div className="mt-4">
        <p className="text-xs font-medium text-muted-foreground">Color</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Use ${hex}`}
              aria-pressed={(space.color ?? SWATCHES[0]) === hex}
              onClick={() => commit({ color: hex }, () => {})}
              style={{ backgroundColor: hex }}
              className={cn(
                "h-7 w-7 flex-shrink-0 rounded-full transition-transform",
                (space.color ?? SWATCHES[0]) === hex
                  ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                  : "hover:scale-110",
              )}
            />
          ))}
        </div>
      </div>

      <label className="mt-4 block text-xs font-medium text-muted-foreground">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          onBlur={() => {
            const trimmed = description.trim();
            if (trimmed === (space.description ?? "")) return;
            commit({ description: trimmed || null }, () =>
              setDescription(space.description ?? ""),
            );
          }}
          rows={2}
          placeholder="What is this Space for?"
          className="soft-field mt-1 block w-full resize-none px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
    </section>
  );
}

function DefaultStatusesCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const statuses = (space.defaultStatuses ?? []) as DefaultStatus[];
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] = useState<StatusCategory>("open");

  async function save(next: DefaultStatus[] | null) {
    try {
      await update({ spaceId, defaultStatuses: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save statuses"), { kind: "error" });
    }
  }

  function removeAt(i: number) {
    save(statuses.filter((_, idx) => idx !== i));
  }

  async function addStatus() {
    const trimmed = draftName.trim();
    if (!trimmed) return;
    const color = SWATCHES[statuses.length % SWATCHES.length];
    await save([...statuses, { name: trimmed, color, category: draftCategory }]);
    setDraftName("");
    setDraftCategory("open");
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Default statuses
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        New lists in this Space start with these statuses instead of the
        defaults. Changes here only affect lists created after you save.
      </p>

      {space.defaultStatuses === undefined ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Using the standard four statuses.
        </p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {statuses.map((s, i) => (
            <li
              key={`${s.name}-${i}`}
              className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm"
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {CATEGORY_LABEL[s.category]}
              </span>
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                onClick={() => removeAt(i)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addStatus();
            }
          }}
          placeholder="New status name"
          className="soft-field flex-1 px-3 py-1.5 text-sm focus:outline-none"
        />
        <select
          value={draftCategory}
          onChange={(e) =>
            setDraftCategory(e.currentTarget.value as StatusCategory)
          }
          className="soft-field px-3 py-1.5 text-xs focus:outline-none"
        >
          {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void addStatus()}
          disabled={!draftName.trim()}
          className="inline-flex h-9 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {space.defaultStatuses !== undefined && (
        <button
          type="button"
          onClick={() => save(null)}
          className="mt-3 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Reset to defaults
        </button>
      )}
    </section>
  );
}

type SpaceFeatures = NonNullable<SpaceDoc["features"]>;
type FeatureKey = keyof SpaceFeatures;

const FEATURE_ROWS: { key: FeatureKey; label: string; description: string }[] = [
  { key: "sprints", label: "Sprints", description: "Timebox work into sprints." },
  { key: "goals", label: "Goals", description: "Set and measure goals." },
  {
    key: "whiteboards",
    label: "Whiteboards",
    description: "Collaborative whiteboards.",
  },
];

function FeaturesCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const features: SpaceFeatures = space.features ?? {};

  async function toggle(key: FeatureKey, checked: boolean) {
    try {
      await update({ spaceId, features: { ...features, [key]: checked } });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save features"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Features
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Turning a feature off hides it for this Space. Nothing is deleted.
        {space.parentType === "workspace" &&
          " For Sprints and Goals, if every Space in the workspace turns the feature off, the workspace-level tab is hidden too."}
      </p>
      <ul className="mt-4 space-y-3">
        {FEATURE_ROWS.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.description}</p>
            </div>
            <input
              type="checkbox"
              checked={features[row.key] !== false}
              onChange={(e) => toggle(row.key, e.currentTarget.checked)}
              aria-label={row.label}
              className="h-4 w-4 flex-shrink-0 accent-[var(--color-foreground)]"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrivacyCard({
  spaceId,
  space,
  members,
  canGovern,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
  members: MemberRow[];
  canGovern: boolean;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const workspaceId = space.parentId as Id<"workspaces">;
  const workspaceMembers = useQuery(
    api.workspaces.listMembers,
    canGovern && space.private ? { workspaceId } : "skip",
  );

  async function setPrivate(next: boolean) {
    try {
      await update({ spaceId, private: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't change privacy"), { kind: "error" });
    }
  }

  async function setMembers(ids: string[]) {
    try {
      await update({ spaceId, memberClerkIds: ids });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't update members"), { kind: "error" });
    }
  }

  const addable = (workspaceMembers ?? [])
    .filter((u) => !members.some((m) => m.clerkId === u.clerkId))
    .map((u) => ({ id: u.clerkId, label: u.name || u.email || "Member" }));

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Privacy
      </h2>

      <label className="mt-4 flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={!!space.private}
          disabled={!canGovern}
          onChange={(e) => setPrivate(e.currentTarget.checked)}
          className="h-4 w-4 accent-[var(--color-foreground)] disabled:opacity-50"
        />
        Private Space
      </label>

      {!canGovern && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the Space creator or workspace owner can change privacy.
        </p>
      )}

      {space.private && (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Members
          </p>
          <ul className="space-y-1">
            {members.map((m) => (
              <li
                key={m.clerkId}
                className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-sm"
              >
                <Monogram name={m.name} size="sm" />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {canGovern && (
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    onClick={() =>
                      setMembers(
                        members
                          .filter((x) => x.clerkId !== m.clerkId)
                          .map((x) => x.clerkId),
                      )
                    }
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canGovern && (
            <Picker
              label="+ Add member…"
              options={addable}
              onSelect={(id) => setMembers([...members.map((m) => m.clerkId), id])}
              dashed
              className="mt-2"
            />
          )}
        </div>
      )}
    </section>
  );
}

function DangerCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const archived = !!space.archivedAt;

  async function toggleArchive() {
    const next = !archived;
    try {
      await update({ spaceId, archived: next });
      if (next) {
        toast("Space archived", {
          action: {
            label: "Undo",
            onClick: () => {
              update({ spaceId, archived: false }).catch(() => {});
            },
          },
        });
      } else {
        toast("Space restored");
      }
    } catch (e) {
      toast(errorMessage(e, "Couldn't update Space"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {archived
          ? "This Space is archived — it's hidden from the sidebar and Home, but this page stays reachable by URL and nothing inside it is deleted."
          : "Archiving hides this Space from the sidebar and Home. Nothing inside it is deleted, and this page stays reachable by URL."}
      </p>
      <button
        type="button"
        onClick={toggleArchive}
        className="mt-3 inline-flex h-9 items-center rounded-full bg-muted px-4 text-sm font-medium text-foreground hover:bg-border"
      >
        {archived ? "Unarchive Space" : "Archive Space"}
      </button>
    </section>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="flex gap-1 rounded-full border border-border p-1">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-7 w-24 animate-pulse rounded-full bg-muted/60"
          />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
