"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Picker, type PickerOption } from "@/components/ui/picker";
import { Monogram } from "@/components/dashboard/monogram";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InlineCreate } from "@/components/dashboard/inline-create";
import {
  AnimatedBar,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import Counter, { placesFor } from "@/components/counter";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { timeAgo } from "@/lib/time";
import { errorMessage } from "@/lib/errors";

// The Overview surface: what makes a list a real PROJECT. Description +
// notes on the left, health/owner/target date + at-a-glance metadata on the
// right. Every field blur/click-saves through lists.updateMeta and confirms
// with a quiet toast — there's no separate "save" step anywhere on this page.

type ProjectStatus = "on_track" | "at_risk" | "off_track" | "paused";

const STATUS_CHIPS: { key: ProjectStatus; label: string; className: string }[] = [
  {
    key: "on_track",
    label: "On track",
    className: "bg-pastel-green dark:text-neutral-900",
  },
  {
    key: "at_risk",
    label: "At risk",
    className: "bg-pastel-yellow dark:text-neutral-900",
  },
  {
    key: "off_track",
    label: "Off track",
    className: "bg-pastel-red dark:text-neutral-900",
  },
  { key: "paused", label: "Paused", className: "bg-muted" },
];

export function OverviewView({
  listId,
  list,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div className="min-w-0 space-y-6">
        <AboutCard listId={listId} list={list} />
        <ProgressCard listId={listId} tasks={tasks} statuses={statuses} />
        <MilestonesCard listId={listId} />
      </div>
      <div className="space-y-6">
        <StatusCard listId={listId} list={list} />
        <OwnerCard listId={listId} list={list} />
        <TargetDateCard listId={listId} list={list} />
        <DetailsCard list={list} tasks={tasks} statuses={statuses} />
      </div>
    </div>
  );
}

function AboutCard({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const updateMeta = useMutation(api.lists.updateMeta);
  const { toast } = useToast();
  const [description, setDescription] = useState(list.description ?? "");
  const [notes, setNotes] = useState(list.notes ?? "");

  useEffect(
    () => setDescription(list.description ?? ""),
    [list.description],
  );
  useEffect(() => setNotes(list.notes ?? ""), [list.notes]);

  async function save(patch: { description: string } | { notes: string }) {
    try {
      await updateMeta({ listId, ...patch });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        About
      </span>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        onBlur={() => {
          if (description !== (list.description ?? "")) {
            void save({ description });
          }
        }}
        placeholder="What is this project about?"
        className="mt-2 w-full bg-transparent text-sm focus:outline-none"
      />

      <span className="mt-6 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Notes
      </span>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        onBlur={() => {
          if (notes !== (list.notes ?? "")) {
            void save({ notes });
          }
        }}
        placeholder="Notes, decisions, links. Everything the team should know."
        className="soft-field mt-2 min-h-40 w-full p-3 text-sm focus:outline-none"
      />
    </Card>
  );
}

function StatTile({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <StaggerItem className="bento-tile p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums",
          danger && "text-danger",
        )}
      >
        <Counter
          value={value}
          places={placesFor(value)}
          fontSize={20}
          padding={3}
          fontWeight={700}
        />
      </p>
    </StaggerItem>
  );
}

function ProgressCard({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const stats = useMemo(() => {
    const now = Date.now();
    const doneIds = new Set(
      statuses
        .filter((s) => s.category === "complete" || s.category === "closed")
        .map((s) => s._id),
    );
    const inProgressIds = new Set(
      statuses.filter((s) => s.category === "in_progress").map((s) => s._id),
    );
    let done = 0;
    let inProgress = 0;
    let overdue = 0;
    for (const t of tasks) {
      const isDone = doneIds.has(t.statusId);
      if (isDone) done += 1;
      else if (inProgressIds.has(t.statusId)) inProgress += 1;
      if (!isDone && t.dueDate !== undefined && t.dueDate < now) {
        overdue += 1;
      }
    }
    return { total: tasks.length, done, inProgress, overdue };
  }, [tasks, statuses]);

  const byStatus = useMemo(() => {
    const counts = new Map<Id<"listStatuses">, number>();
    for (const t of tasks) {
      counts.set(t.statusId, (counts.get(t.statusId) ?? 0) + 1);
    }
    return [...statuses]
      .sort((a, b) => a.position - b.position)
      .map((status) => ({ status, count: counts.get(status._id) ?? 0 }));
  }, [tasks, statuses]);

  const pct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Progress
      </span>

      {stats.total === 0 ? (
        <EmptyState
          compact
          title="No tasks yet"
          message="Add tasks from List or Board view to start tracking progress here."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href={`/dashboard/l/${listId}`}>Open List view</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Stagger className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total" value={stats.total} />
            <StatTile label="In progress" value={stats.inProgress} />
            <StatTile label="Done" value={stats.done} />
            <StatTile
              label="Overdue"
              value={stats.overdue}
              danger={stats.overdue > 0}
            />
          </Stagger>

          <div className="mt-5">
            <AnimatedBar
              pct={pct}
              className="h-2 overflow-hidden rounded-full bg-muted"
              barClassName="h-full rounded-full bg-brand-600"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {stats.done} of {stats.total} task
              {stats.total === 1 ? "" : "s"} done
            </p>
          </div>

          <div className="mt-6 space-y-2.5">
            {byStatus.map(({ status, count }) => {
              const rowPct = stats.total > 0 ? (count / stats.total) * 100 : 0;
              return (
                <div key={status._id} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: status.color }}
                  />
                  <span className="w-28 flex-shrink-0 truncate text-xs text-foreground/80">
                    {status.name}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${rowPct}%`,
                        backgroundColor: `${status.color}55`,
                      }}
                    />
                  </div>
                  <span className="w-6 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

// The project's own dated checkpoints. Each row derives its progress from
// the tasks linked to it (tasks.milestoneId), so the bar moves as the work
// does — nothing here is typed in twice.
type MilestoneRow = {
  _id: Id<"milestones">;
  name: string;
  targetDate?: number;
  status: "open" | "complete";
  completedAt?: number;
  total: number;
  done: number;
};

function MilestonesCard({ listId }: { listId: Id<"lists"> }) {
  const milestones = useQuery(api.milestones.listForList, { listId });
  const create = useMutation(api.milestones.create);
  const remove = useMutation(api.milestones.remove);
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  // Deleted rows disappear immediately and the mutation only fires when the
  // undo window closes — the app-wide destructive pattern.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  if (milestones === undefined) {
    return (
      <Card className="rounded-2xl p-5">
        <div className="h-3 w-24 animate-pulse rounded-full bg-muted" />
        <div className="mt-4 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      </Card>
    );
  }

  const visible = (milestones as MilestoneRow[]).filter(
    (m) => !hiddenIds.has(m._id),
  );

  async function submitCreate(name: string) {
    try {
      await create({ listId, name });
      setCreating(false);
    } catch (e) {
      toast(errorMessage(e, "Couldn't add the milestone"), { kind: "error" });
    }
  }

  function deleteMilestone(m: MilestoneRow) {
    const unhide = () =>
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(m._id);
        return next;
      });
    setHiddenIds((prev) => new Set(prev).add(m._id));
    toast(
      m.total > 0
        ? `${m.name} deleted — its ${m.total} task${m.total === 1 ? "" : "s"} stay put`
        : `${m.name} deleted`,
      {
        action: { label: "Undo", onClick: unhide },
        onExpire: () =>
          void remove({ milestoneId: m._id }).catch((e) => {
            // Failed commit: un-hide so the still-existing row reappears.
            unhide();
            toast(errorMessage(e, "Couldn't delete the milestone"), {
              kind: "error",
            });
          }),
      },
    );
  }

  return (
    <Card className="rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Milestones
        </span>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="tap-target text-xs text-muted-foreground hover:text-foreground"
          >
            Add milestone
          </button>
        )}
      </div>

      {visible.length === 0 && !creating ? (
        <EmptyState
          compact
          title="No checkpoints yet"
          message="Milestones are the dated checkpoints inside this project — a beta cut, a design freeze. Link tasks to one and its progress tracks itself."
          action={
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              Add milestone
            </Button>
          }
        />
      ) : (
        <Stagger className="mt-4 space-y-2">
          {visible.map((m) => (
            <StaggerItem key={m._id}>
              <MilestoneRowCard milestone={m} onDelete={() => deleteMilestone(m)} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {creating && (
        <InlineCreate
          className="mt-3"
          placeholder="Milestone name…"
          onCancel={() => setCreating(false)}
          onSubmit={submitCreate}
        />
      )}
    </Card>
  );
}

type MilestonePatch = {
  name?: string;
  description?: string | null;
  targetDate?: number | null;
  status?: "open" | "complete";
};

function MilestoneRowCard({
  milestone,
  onDelete,
}: {
  milestone: MilestoneRow;
  onDelete: () => void;
}) {
  const update = useMutation(api.milestones.update);
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);

  const done = milestone.status === "complete";
  const pct =
    milestone.total > 0 ? (milestone.done / milestone.total) * 100 : done ? 100 : 0;
  const overdue =
    !done &&
    milestone.targetDate !== undefined &&
    milestone.targetDate < Date.now();

  async function save(patch: MilestonePatch, failure: string) {
    try {
      await update({ milestoneId: milestone._id, ...patch });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, failure), { kind: "error" });
    }
  }

  return (
    <div className="bento-tile p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <InlineCreate
              placeholder="Milestone name…"
              initialValue={milestone.name}
              onCancel={() => setRenaming(false)}
              onSubmit={async (name) => {
                await save({ name }, "Couldn't rename the milestone");
                setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setRenaming(true)}
              title="Rename"
              className={cn(
                "block max-w-full truncate text-left text-sm font-medium hover:underline",
                done && "text-muted-foreground line-through",
              )}
            >
              {milestone.name}
            </button>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {done && milestone.completedAt !== undefined
              ? `Reached ${timeAgo(milestone.completedAt)}`
              : milestone.total === 0
                ? "No tasks linked yet"
                : `${milestone.done} of ${milestone.total} task${
                    milestone.total === 1 ? "" : "s"
                  } done`}
            {overdue && " · past its target date"}
          </p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-pressed={done}
            onClick={() =>
              void save(
                { status: done ? "open" : "complete" },
                "Couldn't update the milestone",
              )
            }
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium text-foreground transition-opacity",
              done
                ? "bg-pastel-green dark:text-neutral-900"
                : overdue
                  ? "bg-pastel-red dark:text-neutral-900"
                  : "bg-muted",
            )}
          >
            {done ? "Complete" : overdue ? "Overdue" : "Open"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="tap-target text-xs text-muted-foreground hover:text-foreground"
          >
            Delete
          </button>
        </div>
      </div>

      <AnimatedBar
        pct={pct}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
        barClassName={cn(
          "h-full rounded-full",
          done ? "bg-pastel-green" : "bg-brand-600",
        )}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="date"
          aria-label={`Target date for ${milestone.name}`}
          value={
            milestone.targetDate ? toDateInputValue(milestone.targetDate) : ""
          }
          onChange={(e) =>
            void save(
              {
                targetDate:
                  fromDateInputValue(e.currentTarget.value) ?? null,
              },
              "Couldn't save the target date",
            )
          }
          className="soft-field min-w-0 px-2 py-1 text-xs"
        />
        {milestone.targetDate !== undefined && (
          <button
            type="button"
            onClick={() =>
              void save({ targetDate: null }, "Couldn't clear the target date")
            }
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear date
          </button>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const updateMeta = useMutation(api.lists.updateMeta);
  const { toast } = useToast();

  async function setStatus(key: ProjectStatus) {
    const next = list.projectStatus === key ? null : key;
    try {
      await updateMeta({ listId, projectStatus: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save status"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Status
      </span>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {STATUS_CHIPS.map((chip) => {
          const active = list.projectStatus === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={active}
              onClick={() => void setStatus(chip.key)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium text-foreground transition-opacity",
                chip.className,
                !active && "opacity-45 hover:opacity-80",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function OwnerCard({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const options = useQuery(api.agents.listAssignableForList, { listId });
  const updateMeta = useMutation(api.lists.updateMeta);
  const { toast } = useToast();

  const owner = options?.find((o) => o.id === list.ownerActorId);

  async function setOwner(id: string | null) {
    try {
      await updateMeta({ listId, ownerActorId: id });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save owner"), { kind: "error" });
    }
  }

  const pickerOptions: PickerOption[] = (options ?? []).map((o) => ({
    id: o.id,
    label: o.name,
    hint: o.kind === "agent" ? "agent" : undefined,
  }));

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Owner
      </span>
      <div className="mt-3 space-y-3">
        {owner && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monogram name={owner.name} size="sm" />
              <span className="truncate text-sm font-medium">
                {owner.name}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void setOwner(null)}
              className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              Remove
            </button>
          </div>
        )}
        <Picker
          label={owner ? "Change owner…" : "Assign an owner…"}
          dashed
          selectedId={owner?.id}
          options={pickerOptions}
          onSelect={(id) => void setOwner(id)}
        />
      </div>
    </Card>
  );
}

function TargetDateCard({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const updateMeta = useMutation(api.lists.updateMeta);
  const { toast } = useToast();

  async function setDate(value: number | null) {
    try {
      await updateMeta({ listId, targetDate: value });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save target date"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Target date
        </span>
        {list.targetDate !== undefined && (
          <button
            type="button"
            onClick={() => void setDate(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      <input
        type="date"
        aria-label="Target date"
        value={list.targetDate ? toDateInputValue(list.targetDate) : ""}
        onChange={(e) =>
          void setDate(fromDateInputValue(e.currentTarget.value) ?? null)
        }
        className="soft-field mt-3 w-full px-3 py-2 text-sm"
      />
    </Card>
  );
}

function DetailsCard({
  list,
  tasks,
  statuses,
}: {
  list: Doc<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const created = new Date(list.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="rounded-2xl bento-tile p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Details
      </span>
      <dl className="mt-3 space-y-2 text-sm">
        <DetailRow label="Created" value={created} />
        <DetailRow label="Tasks" value={String(tasks.length)} />
        <DetailRow label="Statuses" value={String(statuses.length)} />
      </dl>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
