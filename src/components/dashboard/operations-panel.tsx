"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { InlineCreate } from "@/components/dashboard/inline-create";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  PriorityChip,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import {
  AnimatedNumber,
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Operations tab on the workspace page: the "is the machine running?"
// surface for a team operating an agent labor force. Three rhythms in one
// view — recurring schedules (what gets created on a clock), routed
// projects (whether new work assigns itself or piles up), and task
// blueprints (the reusable definitions schedules and humans instantiate).
// All data lives in convex/opsOverview.ts + taskBlueprints.ts +
// scheduledTasks.ts — this file is pure surface.

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

type Ops = NonNullable<
  ReturnType<typeof useQuery<typeof api.opsOverview.workspaceOps>>
>;
type Schedule = Ops["schedules"][number];
type RoutedList = Ops["routedLists"][number];
type Blueprint = NonNullable<
  ReturnType<typeof useQuery<typeof api.taskBlueprints.listForScope>>
>[number];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ROUTING_MODE_LABEL: Record<RoutedList["mode"], string> = {
  fixed: "Fixed",
  round_robin: "Round robin",
  least_loaded: "Least loaded",
};

/** "Weekly · Mon · 09:00 UTC" — one voice for a schedule's cadence. */
function cadenceLabel(s: Schedule): string {
  const hour = `${String(s.hourUtc).padStart(2, "0")}:00 UTC`;
  if (s.cadence === "daily") return `Daily · ${hour}`;
  if (s.cadence === "weekly") {
    const day = DOW[(((s.dayOfWeek ?? 1) % 7) + 7) % 7];
    return `Weekly · ${day} · ${hour}`;
  }
  const dom = Math.min(Math.max(s.dayOfMonth ?? 1, 1), 28);
  return `Monthly · day ${dom} · ${hour}`;
}

/** Relative phrasing for a future timestamp ("in 3h"). */
function inTime(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 60_000) return "any minute";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `in ${days}d`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function OperationsPanel({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const ops = useQuery(api.opsOverview.workspaceOps, { workspaceId });
  const blueprints = useQuery(api.taskBlueprints.listForScope, {
    scopeType: "workspace",
    scopeId: workspaceId,
  });
  // The sidebar tree is already subscribed by the workspace page, so this
  // costs nothing extra — it's the source for the "Use…" project picker.
  const tree = useQuery(api.sidebar.tree, {});

  // Projects in this workspace, for instantiating blueprints into.
  const projectOptions = useMemo(() => {
    const ws = tree?.workspaces.find((w) => w._id === workspaceId);
    if (!ws) return [];
    const rows: { id: string; label: string; hint?: string }[] = [];
    for (const sp of ws.spaces) {
      const lists = [...sp.lists, ...sp.folders.flatMap((f) => f.lists)];
      for (const l of lists) {
        rows.push({ id: l._id, label: l.name, hint: sp.name });
      }
    }
    return rows;
  }, [tree, workspaceId]);

  if (ops === undefined || blueprints === undefined || tree === undefined) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl bg-muted/40"
            />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-2xl bg-muted/30" />
        ))}
      </div>
    );
  }
  if (ops === null) {
    return (
      <div className="rounded-2xl panel px-6 py-14 text-center">
        <p className="text-sm text-muted-foreground">
          You don&apos;t have access to this workspace&apos;s operations.
        </p>
      </div>
    );
  }

  const enabledCount = ops.schedules.filter((s) => s.enabled).length;

  return (
    <div className="space-y-4">
      {/* ── Stat row ─────────────────────────────────────────────────── */}
      <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Produced this week"
          value={ops.produced7d}
          subtext={`${ops.producedDone7d} done`}
        />
        <StatTile
          label="Overdue open"
          value={ops.overdueOpen}
          danger={ops.overdueOpen > 0}
          subtext={ops.overdueOpen > 0 ? "needs attention" : "all clear"}
        />
        <StatTile
          label="Routed projects"
          value={ops.routedLists.length}
          subtext={`of ${ops.listCount} project${ops.listCount === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Schedules"
          value={ops.schedules.length}
          subtext={`${enabledCount} enabled`}
        />
      </Stagger>

      <SchedulesSection schedules={ops.schedules} />
      <RoutedSection routedLists={ops.routedLists} />
      <BlueprintsSection
        workspaceId={workspaceId}
        blueprints={blueprints}
        projectOptions={projectOptions}
      />
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  subtext,
  danger = false,
}: {
  label: string;
  value: number;
  subtext?: string;
  danger?: boolean;
}) {
  return (
    <StaggerItem>
      <div className="rounded-2xl panel p-4 sm:p-5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "mt-1.5 text-3xl font-bold tabular-nums tracking-tight",
            danger && "text-danger",
          )}
        >
          <AnimatedNumber value={value} />
        </p>
        {subtext && (
          <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
        )}
      </div>
    </StaggerItem>
  );
}

// ── Icon-free switch ─────────────────────────────────────────────────────

function Switch({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(
        "tap-target relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-foreground" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-background shadow-xs transition-transform",
          checked ? "translate-x-4" : "translate-x-1",
        )}
      />
    </button>
  );
}

// ── Schedules ────────────────────────────────────────────────────────────

function SchedulesSection({ schedules }: { schedules: Schedule[] }) {
  const updateSchedule = useMutation(api.scheduledTasks.update);
  const { toast } = useToast();

  async function toggle(s: Schedule) {
    try {
      await updateSchedule({ scheduledTaskId: s._id, enabled: !s.enabled });
      toast(s.enabled ? `${s.title} paused` : `${s.title} resumed`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't update schedule"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Schedules
        </h2>
        {schedules.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            work the machine creates on a clock
          </span>
        )}
      </div>
      {schedules.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No recurring schedules yet — create one from a project&apos;s
          settings and it will report in here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {schedules.map((s) => (
            <li key={s._id} className="bento-tile p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm font-medium",
                        !s.enabled && "text-muted-foreground",
                      )}
                      title={s.title}
                    >
                      {s.title}
                    </span>
                    {s.blueprintName && (
                      <span
                        className="max-w-40 truncate rounded-full bg-pastel-blue px-2 py-0.5 text-[10px] font-medium dark:text-neutral-900"
                        title={`Blueprint: ${s.blueprintName}`}
                      >
                        {s.blueprintName}
                      </span>
                    )}
                    {!s.enabled && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        Paused
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                    <Link
                      href={`/dashboard/l/${s.listId}`}
                      className="min-w-0 truncate font-medium hover:underline"
                      title={s.listName}
                    >
                      {s.listName}
                    </Link>
                    <span aria-hidden>·</span>
                    <span>{cadenceLabel(s)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {s.lastRunAt !== undefined
                        ? `Last run ${timeAgo(s.lastRunAt)}`
                        : "Never run"}
                    </span>
                    {s.enabled && (
                      <>
                        <span aria-hidden>·</span>
                        <span>Next {inTime(s.nextRunAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <Switch
                  checked={s.enabled}
                  label={
                    s.enabled
                      ? `Pause ${s.title}`
                      : `Resume ${s.title}`
                  }
                  onToggle={() => void toggle(s)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Routed projects ──────────────────────────────────────────────────────

function RoutedSection({ routedLists }: { routedLists: RoutedList[] }) {
  return (
    <section className="rounded-2xl panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Routed projects
        </h2>
        {routedLists.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            new tasks assign themselves
          </span>
        )}
      </div>
      {routedLists.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Set a routing rule in a project&apos;s settings and new tasks assign
          themselves.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {routedLists.map((r) => (
            <li
              key={r.listId}
              className="bento-tile flex flex-wrap items-center gap-x-2 gap-y-1 p-3"
            >
              <Link
                href={`/dashboard/l/${r.listId}`}
                className="min-w-0 truncate text-sm font-medium hover:underline"
                title={r.name}
              >
                {r.name}
              </Link>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {ROUTING_MODE_LABEL[r.mode]}
              </span>
              <span className="text-xs text-muted-foreground">
                {r.assignees} assignee{r.assignees === 1 ? "" : "s"}
              </span>
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium",
                  r.openUnassigned > 0
                    ? "bg-pastel-yellow dark:text-neutral-900"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {r.openUnassigned > 0
                  ? `${r.openUnassigned} waiting`
                  : "None waiting"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Blueprints ───────────────────────────────────────────────────────────

function BlueprintsSection({
  workspaceId,
  blueprints,
  projectOptions,
}: {
  workspaceId: Id<"workspaces">;
  blueprints: Blueprint[];
  projectOptions: { id: string; label: string; hint?: string }[];
}) {
  const createBlueprint = useMutation(api.taskBlueprints.create);
  const removeBlueprint = useMutation(api.taskBlueprints.remove);
  const instantiate = useMutation(api.taskBlueprints.instantiate);
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<Id<"taskBlueprints"> | null>(
    null,
  );
  // Hidden while their undo toasts are live — deletes commit on expiry.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const visible = blueprints.filter((bp) => !hiddenIds.has(bp._id));

  async function submitCreate(name: string) {
    try {
      // The name doubles as the task title until the editor refines it.
      const id = await createBlueprint({
        scopeType: "workspace",
        scopeId: workspaceId,
        name,
        title: name,
      });
      setCreating(false);
      setEditingId(id);
    } catch (e) {
      toast(errorMessage(e, "Couldn't create blueprint"), { kind: "error" });
    }
  }

  function deleteBlueprint(bp: Blueprint) {
    if (editingId === bp._id) setEditingId(null);
    const unhide = () =>
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(bp._id);
        return next;
      });
    setHiddenIds((prev) => new Set(prev).add(bp._id));
    toast(`${bp.name} deleted`, {
      action: { label: "Undo", onClick: unhide },
      onExpire: () =>
        void removeBlueprint({ blueprintId: bp._id }).catch((e) => {
          unhide();
          toast(errorMessage(e, "Couldn't delete blueprint"), {
            kind: "error",
          });
        }),
    });
  }

  async function instantiateBlueprint(bp: Blueprint, listId: string) {
    try {
      await instantiate({
        blueprintId: bp._id,
        listId: listId as Id<"lists">,
      });
      const project = projectOptions.find((p) => p.id === listId);
      toast(
        project
          ? `Task created in ${project.label}`
          : "Task created from blueprint",
      );
    } catch (e) {
      toast(errorMessage(e, "Couldn't create task"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Blueprints
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Reusable task definitions — instantiate one here or attach it to
            a schedule. Pair them with playbooks in the{" "}
            <Link
              href="/dashboard/agents?tab=skills"
              className="font-medium hover:underline"
            >
              skills library
            </Link>
            .
          </p>
        </div>
        <div className="ml-auto flex-shrink-0">
          {creating ? (
            <InlineCreate
              placeholder="Blueprint name…"
              className="w-52"
              onCancel={() => setCreating(false)}
              onSubmit={submitCreate}
            />
          ) : (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New blueprint
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No blueprints yet. Define a task once — title, checklist, approval
          gate — and reuse it forever.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          <AnimatePresence initial={false}>
            {visible.map((bp) => (
              <motion.li
                key={bp._id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="bento-tile p-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="min-w-0 truncate text-sm font-medium"
                    title={bp.name}
                  >
                    {bp.name}
                  </span>
                  {bp.title !== bp.name && (
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={bp.title}
                    >
                      creates &quot;{bp.title}&quot;
                    </span>
                  )}
                  <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                    <Picker
                      label="Use…"
                      dashed
                      options={projectOptions}
                      onSelect={(listId) =>
                        void instantiateBlueprint(bp, listId)
                      }
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setEditingId((cur) =>
                          cur === bp._id ? null : bp._id,
                        )
                      }
                      aria-expanded={editingId === bp._id}
                      className="rounded-full px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {editingId === bp._id ? "Close" : "Edit"}
                    </button>
                    <button
                      type="button"
                      title={`Delete ${bp.name}`}
                      aria-label={`Delete ${bp.name}`}
                      onClick={() => deleteBlueprint(bp)}
                      className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {bp.priority && <PriorityChip priority={bp.priority} />}
                  {bp.estimatePoints !== undefined && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {bp.estimatePoints} pt
                      {bp.estimatePoints === 1 ? "" : "s"}
                    </span>
                  )}
                  {bp.checklist.length > 0 && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {bp.checklist.length} step
                      {bp.checklist.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {bp.requiresApproval && (
                    <span className="rounded-full bg-pastel-yellow px-2 py-0.5 text-[10px] font-medium dark:text-neutral-900">
                      Approval gate
                    </span>
                  )}
                </div>
                <AnimatePresence initial={false}>
                  {editingId === bp._id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: EASE }}
                      className="overflow-hidden"
                    >
                      <BlueprintEditor
                        blueprint={bp}
                        onClose={() => setEditingId(null)}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

// ── Blueprint editor ─────────────────────────────────────────────────────

function BlueprintEditor({
  blueprint,
  onClose,
}: {
  blueprint: Blueprint;
  onClose: () => void;
}) {
  const updateBlueprint = useMutation(api.taskBlueprints.update);
  const { toast } = useToast();

  const [name, setName] = useState(blueprint.name);
  const [title, setTitle] = useState(blueprint.title);
  const [description, setDescription] = useState(blueprint.description ?? "");
  const [checklistText, setChecklistText] = useState(
    blueprint.checklist.join("\n"),
  );
  const [priority, setPriority] = useState<TaskPriority | "">(
    blueprint.priority ?? "",
  );
  const [estimate, setEstimate] = useState(
    blueprint.estimatePoints !== undefined
      ? String(blueprint.estimatePoints)
      : "",
  );
  const [requiresApproval, setRequiresApproval] = useState(
    blueprint.requiresApproval ?? false,
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    const estimateNum =
      estimate.trim() === "" ? null : Number(estimate.trim());
    if (estimateNum !== null && (Number.isNaN(estimateNum) || estimateNum < 0)) {
      toast("Estimate must be a non-negative number", { kind: "error" });
      return;
    }
    setSaving(true);
    try {
      await updateBlueprint({
        blueprintId: blueprint._id,
        name: name.trim(),
        title: title.trim(),
        description: description.trim() === "" ? null : description.trim(),
        priority: priority === "" ? null : priority,
        checklist: checklistText
          .split("\n")
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
        estimatePoints: estimateNum,
        requiresApproval,
      });
      toast("Blueprint saved");
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Couldn't save blueprint"), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Blueprint name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Weekly outreach"
            className="soft-field w-full px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Task title
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Run the weekly outreach checklist"
            className="soft-field w-full px-3 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Description
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          rows={3}
          placeholder="Context the assignee needs to do this well…"
          className="soft-field w-full resize-y px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Checklist — one item per line
        </span>
        <textarea
          value={checklistText}
          onChange={(e) => setChecklistText(e.currentTarget.value)}
          rows={4}
          placeholder={"Draft the list\nSend it\nLog replies"}
          className="soft-field w-full resize-y px-3 py-2 text-sm"
        />
      </label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Priority
          </span>
          <Picker
            label={priority === "" ? "No priority" : PRIORITY_LABEL[priority]}
            selectedId={priority === "" ? "__none" : priority}
            options={[
              { id: "__none", label: "No priority" },
              ...PRIORITY_ORDER.map((p) => ({
                id: p,
                label: PRIORITY_LABEL[p],
              })),
            ]}
            onSelect={(id) =>
              setPriority(id === "__none" ? "" : (id as TaskPriority))
            }
          />
        </div>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Estimate (pts)
          </span>
          <input
            type="number"
            min={0}
            value={estimate}
            onChange={(e) => setEstimate(e.currentTarget.value)}
            placeholder="—"
            className="soft-field w-24 px-3 py-1.5 text-sm"
          />
        </label>
        <div>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Approval gate
          </span>
          <div className="flex min-h-9 items-center gap-2">
            <Switch
              checked={requiresApproval}
              label={
                requiresApproval
                  ? "Remove the approval gate"
                  : "Require human approval to complete"
              }
              onToggle={() => setRequiresApproval((v) => !v)}
            />
            <span className="text-xs text-muted-foreground">
              {requiresApproval
                ? "A human must approve completion"
                : "Completes without sign-off"}
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save blueprint"}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
