"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import {
  AnimatedBar,
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Roadmap tab on the workspace page: workspace projects (lists) slotted
// into the ordered phases of one or more roadmaps ("Now / Next / Later",
// quarters, launch trains…). Phases render as horizontal columns; projects
// move between phases, reorder within one, and fall back to the
// "Not on roadmap" rail at the bottom when unassigned. All data lives in
// convex/roadmaps.ts — this file is pure surface.

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

type RoadmapList = NonNullable<
  NonNullable<ReturnType<typeof useQuery<typeof api.roadmaps.listForWorkspace>>>
>;
type Roadmap = RoadmapList[number];
type Phase = Roadmap["phases"][number];
type RoadmapProject = Roadmap["projects"][number];

// Same pastel language as the projects directory: dark ink stays pinned on
// pastel fills in both themes; "paused" rides the theme-adaptive muted pair.
const STATUS_CHIP: Record<
  NonNullable<RoadmapProject["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green dark:text-neutral-900" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow dark:text-neutral-900" },
  off_track: { label: "Off track", className: "bg-pastel-red dark:text-neutral-900" },
  paused: { label: "Paused", className: "bg-muted text-muted-foreground" },
};

function fmtTarget(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

export function RoadmapPanel({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const roadmaps = useQuery(api.roadmaps.listForWorkspace, { workspaceId });
  // The sidebar tree is already subscribed by the workspace page, so this
  // costs nothing extra — it's the source for the "Not on roadmap" rail.
  const tree = useQuery(api.sidebar.tree, {});
  const createRoadmap = useMutation(api.roadmaps.create);
  const updateRoadmap = useMutation(api.roadmaps.update);
  const removeRoadmap = useMutation(api.roadmaps.remove);
  const addPhase = useMutation(api.roadmaps.addPhase);
  const removePhase = useMutation(api.roadmaps.removePhase);
  const { toast } = useToast();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [addingPhase, setAddingPhase] = useState(false);
  // Hidden while their undo toasts are live — deletes commit on expiry.
  const [hiddenRoadmapIds, setHiddenRoadmapIds] = useState<Set<string>>(
    new Set(),
  );
  const [hiddenPhaseIds, setHiddenPhaseIds] = useState<Set<string>>(new Set());

  // Workspace projects not assigned to any roadmap, for the bottom rail.
  const unassigned = useMemo(() => {
    const ws = tree?.workspaces.find((w) => w._id === workspaceId);
    if (!ws) return [];
    const rows: {
      listId: Id<"lists">;
      name: string;
      color?: string;
      spaceName: string;
    }[] = [];
    for (const sp of ws.spaces) {
      const lists = [...sp.lists, ...sp.folders.flatMap((f) => f.lists)];
      for (const l of lists) {
        if (l.roadmapId !== undefined) continue;
        rows.push({
          listId: l._id,
          name: l.name,
          color: l.color,
          spaceName: sp.name,
        });
      }
    }
    return rows;
  }, [tree, workspaceId]);

  if (roadmaps === undefined || tree === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 animate-pulse rounded-full bg-muted/40" />
        <div className="flex gap-3 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-56 w-72 flex-shrink-0 animate-pulse rounded-2xl bg-muted/30"
            />
          ))}
        </div>
      </div>
    );
  }
  if (roadmaps === null) return null;

  const visible = roadmaps.filter((r) => !hiddenRoadmapIds.has(r._id));
  const active = visible.find((r) => r._id === activeId) ?? visible[0];

  async function submitCreate(name: string) {
    try {
      const id = await createRoadmap({ workspaceId, name });
      setActiveId(id);
      setCreating(false);
    } catch (e) {
      toast(errorMessage(e, "Couldn't create roadmap"), { kind: "error" });
    }
  }

  if (!active) {
    return (
      <div className="rounded-2xl panel px-6 py-14 text-center">
        <p className="text-sm font-semibold">Plan the arc of the work</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          A roadmap lines this workspace&apos;s projects up into phases — Now,
          Next, Later — so everyone can see what ships when.
        </p>
        <div className="mt-4 flex justify-center">
          {creating ? (
            <InlineCreate
              placeholder="Roadmap name…"
              className="w-64"
              onCancel={() => setCreating(false)}
              onSubmit={submitCreate}
            />
          ) : (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New roadmap
            </Button>
          )}
        </div>
      </div>
    );
  }

  function deleteRoadmap(rm: Roadmap) {
    setHiddenRoadmapIds((prev) => new Set(prev).add(rm._id));
    toast(`${rm.name} deleted — projects stay put`, {
      action: {
        label: "Undo",
        onClick: () =>
          setHiddenRoadmapIds((prev) => {
            const next = new Set(prev);
            next.delete(rm._id);
            return next;
          }),
      },
      onExpire: () =>
        void removeRoadmap({ roadmapId: rm._id }).catch((e) =>
          toast(errorMessage(e, "Couldn't delete roadmap"), { kind: "error" }),
        ),
    });
  }

  function deletePhase(rm: Roadmap, phase: Phase) {
    setHiddenPhaseIds((prev) => new Set(prev).add(phase.id));
    const count = rm.projects.filter((p) => p.phaseId === phase.id).length;
    toast(
      count > 0
        ? `${phase.name} deleted — ${count} project${count === 1 ? "" : "s"} return to Not on roadmap`
        : `${phase.name} deleted`,
      {
        action: {
          label: "Undo",
          onClick: () =>
            setHiddenPhaseIds((prev) => {
              const next = new Set(prev);
              next.delete(phase.id);
              return next;
            }),
        },
        onExpire: () =>
          void removePhase({ roadmapId: rm._id, phaseId: phase.id }).catch(
            (e) =>
              toast(errorMessage(e, "Couldn't delete phase"), {
                kind: "error",
              }),
          ),
      },
    );
  }

  const phases = active.phases.filter((p) => !hiddenPhaseIds.has(p.id));
  const totalTasks = active.projects.reduce((sum, p) => sum + p.total, 0);
  const totalDone = active.projects.reduce((sum, p) => sum + p.done, 0);

  return (
    <div className="space-y-4">
      {/* Switcher: which roadmap, plus the affordance for another one. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.length > 1 &&
          visible.map((rm) => (
            <button
              key={rm._id}
              type="button"
              onClick={() => {
                setActiveId(rm._id);
                setRenaming(false);
                setAddingPhase(false);
              }}
              aria-current={rm._id === active._id ? "true" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm transition-colors",
                rm._id === active._id
                  ? "bg-foreground font-medium text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {rm.name}
            </button>
          ))}
        {creating ? (
          <InlineCreate
            placeholder="Roadmap name…"
            className="w-52"
            onCancel={() => setCreating(false)}
            onSubmit={submitCreate}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full panel px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            + roadmap
          </button>
        )}
      </div>

      {/* Active roadmap header: inline rename, delete, rollup. */}
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <InlineCreate
            placeholder="Roadmap name…"
            initialValue={active.name}
            className="w-64"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await updateRoadmap({ roadmapId: active._id, name });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename roadmap"), {
                  kind: "error",
                });
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename roadmap"
            onClick={() => setRenaming(true)}
            className="max-w-full truncate text-left text-base font-semibold hover:underline"
          >
            {active.name}
          </button>
        )}
        {totalTasks > 0 && (
          <span className="text-xs text-muted-foreground">
            {totalDone}/{totalTasks} tasks done · {active.projects.length}{" "}
            project{active.projects.length === 1 ? "" : "s"}
          </span>
        )}
        <button
          type="button"
          title="Delete roadmap (projects are kept)"
          onClick={() => deleteRoadmap(active)}
          className="tap-target ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {active.description && (
        <p className="-mt-2 text-sm text-muted-foreground">
          {active.description}
        </p>
      )}

      {/* Phase columns — horizontal scroll, like the other pill rows. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
        <Stagger key={active._id} className="flex items-start gap-3">
          {phases.map((phase) => (
            <StaggerItem key={phase.id} className="w-64 flex-shrink-0 sm:w-72">
              <PhaseColumn
                roadmap={active}
                phase={phase}
                projects={active.projects.filter(
                  (p) => p.phaseId === phase.id,
                )}
                onDelete={() => deletePhase(active, phase)}
              />
            </StaggerItem>
          ))}
          <div className="w-64 flex-shrink-0 pt-1">
            {addingPhase ? (
              <InlineCreate
                placeholder="Phase name…"
                onCancel={() => setAddingPhase(false)}
                onSubmit={async (name) => {
                  try {
                    await addPhase({ roadmapId: active._id, name });
                    setAddingPhase(false);
                  } catch (e) {
                    toast(errorMessage(e, "Couldn't add phase"), {
                      kind: "error",
                    });
                  }
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingPhase(true)}
                className="w-full rounded-2xl panel px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                + Add phase
              </button>
            )}
          </div>
        </Stagger>
      </div>

      <UnassignedRail projects={unassigned} roadmap={active} />
    </div>
  );
}

// ── Phase column ─────────────────────────────────────────────────────────

function PhaseColumn({
  roadmap,
  phase,
  projects,
  onDelete,
}: {
  roadmap: Roadmap;
  phase: Phase;
  projects: RoadmapProject[];
  onDelete: () => void;
}) {
  const reorder = useMutation(api.roadmaps.reorderPhase);
  const assign = useMutation(api.roadmaps.assignProject);
  const updatePhase = useMutation(api.roadmaps.updatePhase);
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);

  // Optimistic order: render the just-clicked order immediately, then let
  // the server's order take back over once it catches up (or the phase's
  // membership changes under us).
  const [override, setOverride] = useState<string[] | null>(null);
  const serverKey = projects.map((p) => p.listId as string).join(",");
  useEffect(() => {
    setOverride((cur) => {
      if (!cur) return cur;
      const serverIds = serverKey ? serverKey.split(",") : [];
      const sameSet =
        cur.length === serverIds.length &&
        cur.every((id) => serverIds.includes(id));
      if (!sameSet || cur.join(",") === serverKey) return null;
      return cur;
    });
  }, [serverKey]);

  const ordered = useMemo(() => {
    if (!override) return projects;
    const byId = new Map(projects.map((p) => [p.listId as string, p]));
    const out: RoadmapProject[] = [];
    for (const id of override) {
      const p = byId.get(id);
      if (p) {
        out.push(p);
        byId.delete(id);
      }
    }
    out.push(...byId.values());
    return out;
  }, [projects, override]);

  function move(index: number, dir: -1 | 1) {
    const ids = ordered.map((p) => p.listId);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setOverride(ids as string[]);
    void reorder({
      roadmapId: roadmap._id,
      phaseId: phase.id,
      orderedIds: ids,
    }).catch((e) => {
      setOverride(null);
      toast(errorMessage(e, "Couldn't reorder projects"), { kind: "error" });
    });
  }

  function moveToPhase(project: RoadmapProject, targetId: string) {
    const action =
      targetId === "__remove"
        ? assign({ listId: project.listId, roadmapId: null })
        : assign({
            listId: project.listId,
            roadmapId: roadmap._id,
            phaseId: targetId,
          });
    void action.catch((e) =>
      toast(errorMessage(e, "Couldn't move project"), { kind: "error" }),
    );
  }

  const done = projects.reduce((sum, p) => sum + p.done, 0);
  const total = projects.reduce((sum, p) => sum + p.total, 0);
  const pct = total > 0 ? (done / total) * 100 : 0;
  const overdue =
    phase.targetDate !== undefined &&
    phase.targetDate < Date.now() &&
    done < total;

  const moveOptions = [
    ...roadmap.phases
      .filter((p) => p.id !== phase.id)
      .map((p) => ({ id: p.id, label: p.name, hint: "phase" })),
    { id: "__remove", label: "Remove from roadmap" },
  ];

  return (
    <div className="rounded-2xl panel p-3">
      <div className="flex items-center gap-2">
        {renaming ? (
          <InlineCreate
            placeholder="Phase name…"
            initialValue={phase.name}
            className="min-w-0 flex-1"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await updatePhase({
                  roadmapId: roadmap._id,
                  phaseId: phase.id,
                  name,
                });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename phase"), {
                  kind: "error",
                });
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename phase"
            onClick={() => setRenaming(true)}
            className="min-w-0 truncate text-sm font-semibold hover:underline"
          >
            {phase.name}
          </button>
        )}
        <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
          {done}/{total}
        </span>
        <PhaseMenu
          roadmap={roadmap}
          phase={phase}
          onRename={() => setRenaming(true)}
          onDelete={onDelete}
        />
      </div>
      {phase.targetDate !== undefined && (
        <p
          className={cn(
            "mt-0.5 text-[11px] uppercase tracking-wider",
            overdue ? "font-medium text-danger" : "text-muted-foreground",
          )}
        >
          Target {fmtTarget(phase.targetDate)}
        </p>
      )}
      <AnimatedBar
        pct={pct}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        barClassName="h-full rounded-full bg-foreground/70"
      />

      <div className="mt-3 space-y-2">
        {ordered.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            Nothing in this phase yet — move a project here.
          </p>
        )}
        <AnimatePresence initial={false}>
          {ordered.map((project, i) => (
            <motion.div
              key={project.listId}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <ProjectCard
                project={project}
                canUp={i > 0}
                canDown={i < ordered.length - 1}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                moveOptions={moveOptions}
                onMoveTo={(target) => moveToPhase(project, target)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Phase options menu ───────────────────────────────────────────────────

function PhaseMenu({
  roadmap,
  phase,
  onRename,
  onDelete,
}: {
  roadmap: Roadmap;
  phase: Phase;
  onRename: () => void;
  onDelete: () => void;
}) {
  const updatePhase = useMutation(api.roadmaps.updatePhase);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function setTarget(value: string) {
    void updatePhase({
      roadmapId: roadmap._id,
      phaseId: phase.id,
      targetDate: fromDateInputValue(value) ?? null,
    }).catch((e) =>
      toast(errorMessage(e, "Couldn't set target date"), { kind: "error" }),
    );
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        aria-label={`Options for ${phase.name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
          >
            <label className="block px-1.5 pt-1">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Target date
              </span>
              <input
                type="date"
                value={
                  phase.targetDate !== undefined
                    ? toDateInputValue(phase.targetDate)
                    : ""
                }
                onChange={(e) => setTarget(e.currentTarget.value)}
                className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
              />
            </label>
            {phase.targetDate !== undefined && (
              <button
                type="button"
                onClick={() => setTarget("")}
                className="mt-1 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Clear target date
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              className="mt-1 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              Rename phase
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-accent"
            >
              Delete phase
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Project card ─────────────────────────────────────────────────────────

function ProjectCard({
  project,
  canUp,
  canDown,
  onUp,
  onDown,
  moveOptions,
  onMoveTo,
}: {
  project: RoadmapProject;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  moveOptions: { id: string; label: string; hint?: string }[];
  onMoveTo: (targetId: string) => void;
}) {
  const chip = project.projectStatus
    ? STATUS_CHIP[project.projectStatus]
    : null;

  return (
    <div className="bento-tile p-3">
      <div className="flex items-start gap-2">
        {project.color && (
          <span
            aria-hidden
            className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
        )}
        <Link
          href={`/dashboard/l/${project.listId}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          title={project.name}
        >
          {project.name}
        </Link>
        <div className="flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-label={`Move ${project.name} up`}
            disabled={!canUp}
            onClick={onUp}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${project.name} down`}
            disabled={!canDown}
            onClick={onDown}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {chip && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              chip.className,
            )}
          >
            {chip.label}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {project.done}/{project.total} done
        </span>
        {project.targetDate !== undefined && (
          <span className="text-xs text-muted-foreground">
            {fmtTarget(project.targetDate)}
          </span>
        )}
        <Picker
          label="Move"
          options={moveOptions}
          onSelect={onMoveTo}
          className="ml-auto"
        />
      </div>
    </div>
  );
}

// ── "Not on roadmap" rail ────────────────────────────────────────────────

function UnassignedRail({
  projects,
  roadmap,
}: {
  projects: { listId: Id<"lists">; name: string; color?: string; spaceName: string }[];
  roadmap: Roadmap;
}) {
  const assign = useMutation(api.roadmaps.assignProject);
  const { toast } = useToast();

  return (
    <section className="rounded-2xl panel p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Not on roadmap
      </p>
      {projects.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Every project in this workspace is on a roadmap.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          <AnimatePresence initial={false}>
            {projects.map((p) => (
              <motion.li
                key={p.listId}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-1 py-1"
              >
                {p.color && (
                  <span
                    aria-hidden
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                )}
                <Link
                  href={`/dashboard/l/${p.listId}`}
                  className="min-w-0 truncate text-sm font-medium hover:underline"
                  title={p.name}
                >
                  {p.name}
                </Link>
                <span className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
                  {p.spaceName}
                </span>
                <Picker
                  label="+ Add to phase…"
                  dashed
                  className="ml-auto"
                  options={roadmap.phases.map((ph) => ({
                    id: ph.id,
                    label: ph.name,
                  }))}
                  onSelect={(phaseId) =>
                    void assign({
                      listId: p.listId,
                      roadmapId: roadmap._id,
                      phaseId,
                    }).catch((e) =>
                      toast(errorMessage(e, "Couldn't add to roadmap"), {
                        kind: "error",
                      }),
                    )
                  }
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
