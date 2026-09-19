"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InlineCreate } from "@/components/dashboard/inline-create";
import {
  DeelBar,
  KvCard,
  KvRow,
  MetricStrip,
  StatusDot,
} from "@/components/dashboard/deel-ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { timeAgo } from "@/lib/time";
import { errorMessage } from "@/lib/errors";

// The Overview surface: what makes a list a real PROJECT. Description +
// notes on the left, at-a-glance metadata on the right. Health, owner and
// target date describe the Project, not this board, and live on the project
// page. Every field blur/click-saves through lists.updateMeta and confirms
// with a quiet toast — there's no separate "save" step anywhere on this page.


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
    <KvCard title="About">
      <div className="space-y-4 px-5 pb-5">
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
          className="w-full bg-transparent text-sm focus:outline-none"
        />
        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">Notes</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            onBlur={() => {
              if (notes !== (list.notes ?? "")) {
                void save({ notes });
              }
            }}
            placeholder="Notes, decisions, links. Everything the team should know."
            className="soft-field min-h-40 w-full p-3 text-sm focus:outline-none"
          />
        </div>
      </div>
    </KvCard>
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
    <KvCard title="Progress">
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
        <div className="space-y-5 px-5 pb-5">
          <MetricStrip
            className="sm:grid-cols-2 lg:grid-cols-4"
            items={[
              { value: stats.total, label: "Total" },
              { value: stats.inProgress, label: "In progress" },
              { value: stats.done, label: "Done" },
              {
                value: stats.overdue,
                label: "Overdue",
                tone: stats.overdue > 0 ? "var(--color-danger)" : undefined,
              },
            ]}
          />
          <DeelBar
            label={`${stats.done} of ${stats.total} task${stats.total === 1 ? "" : "s"} done`}
            value={pct}
            valueLabel={`${Math.round(pct)}%`}
            max={100}
          />
          <div className="space-y-3">
            {byStatus.map(({ status, count }) => (
              <DeelBar
                key={status._id}
                label={
                  <StatusDot color={status.color} label={status.name} />
                }
                value={count}
                max={stats.total}
              />
            ))}
          </div>
        </div>
      )}
    </KvCard>
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
      <KvCard title="Milestones">
        <div className="space-y-2 px-5 pb-5">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      </KvCard>
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
    <KvCard
      title="Milestones"
      action={
        !creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="tap-target text-sm text-muted-foreground hover:text-foreground"
          >
            Add milestone
          </button>
        ) : undefined
      }
    >
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
        <Stagger className="divide-y divide-border">
          {visible.map((m) => (
            <StaggerItem key={m._id}>
              <MilestoneRowCard milestone={m} onDelete={() => deleteMilestone(m)} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {creating && (
        <InlineCreate
          className="px-5 pb-4"
          placeholder="Milestone name…"
          onCancel={() => setCreating(false)}
          onSubmit={submitCreate}
        />
      )}
    </KvCard>
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
    <div className="space-y-3 px-5 py-4">
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
                "deel-name-link block max-w-full truncate text-left text-sm font-medium hover:underline",
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

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            aria-pressed={done}
            onClick={() =>
              void save(
                { status: done ? "open" : "complete" },
                "Couldn't update the milestone",
              )
            }
          >
            <StatusDot
              color={
                done
                  ? "var(--color-success, #16a34a)"
                  : overdue
                    ? "var(--color-danger)"
                    : "var(--color-muted-foreground)"
              }
              label={done ? "Complete" : overdue ? "Overdue" : "Open"}
            />
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

      <DeelBar
        label={`${milestone.done}/${milestone.total}`}
        value={pct}
        valueLabel={`${Math.round(pct)}%`}
        max={100}
      />

      <div className="flex flex-wrap items-center gap-2">
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
    <KvCard title="Details">
      <KvRow label="Created">{created}</KvRow>
      <KvRow label="Tasks">{String(tasks.length)}</KvRow>
      <KvRow label="Statuses">{String(statuses.length)}</KvRow>
    </KvCard>
  );
}
