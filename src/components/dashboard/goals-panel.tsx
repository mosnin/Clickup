"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Picker } from "@/components/ui/picker";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

type ParentType = "user" | "workspace";
type TargetType = Doc<"goals">["targetType"];
type GoalStatus = Doc<"goals">["status"];
// Query rows carry `linked` plus DERIVED currentValue/status when the goal
// tracks a project (sourceListId) — the server recomputes both on every
// read, so this component never does its own rollup math.
type GoalList = NonNullable<
  ReturnType<typeof useQuery<typeof api.goals.listForParent>>
>;
type Goal = GoalList[number];

type ProjectOption = { id: string; label: string; hint?: string };

const TARGET_LABEL: Record<TargetType, string> = {
  number: "Number",
  money: "Money",
  boolean: "True/false",
};

const STATUS_LABEL: Record<GoalStatus, string> = {
  open: "Open",
  complete: "Complete",
  abandoned: "Abandoned",
};

// Shared native-<select> chrome — matches the shell's Input/Button grammar
// since there's no vendored Select in play here (options are enums, not
// people/agents/tasks/sprints, so Picker doesn't apply per the house style).
const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

export function GoalsPanel({
  parentType,
  parentId,
}: {
  parentType: ParentType;
  parentId: string;
}) {
  const goals = useQuery(api.goals.listForParent, { parentType, parentId });
  // Already subscribed app-wide by the sidebar — free source for the
  // "Track a project" picker, filtered to this goal scope.
  const tree = useQuery(api.sidebar.tree, {});
  const [showForm, setShowForm] = useState(false);

  const projects = useMemo<ProjectOption[]>(() => {
    if (!tree) return [];
    const spaces =
      parentType === "user"
        ? tree.personal
          ? [tree.personal]
          : []
        : (tree.workspaces.find((w) => w._id === parentId)?.spaces ?? []);
    const rows: ProjectOption[] = [];
    for (const sp of spaces) {
      for (const l of [...sp.lists, ...sp.folders.flatMap((f) => f.lists)]) {
        rows.push({ id: l._id as string, label: l.name, hint: sp.name });
      }
    }
    return rows;
  }, [tree, parentType, parentId]);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.label);
    return map;
  }, [projects]);

  if (goals === undefined) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Card key={i} className="h-20 animate-pulse bg-muted/40" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {goals.length === 0
            ? "Track an outcome: set a target and watch progress roll up as the team works."
            : `${goals.filter((g) => g.status === "open").length} open · ${goals.filter((g) => g.status === "complete").length} complete`}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" /> New goal
        </Button>
      </div>

      {showForm && (
        <CreateGoalForm
          parentType={parentType}
          parentId={parentId}
          projects={projects}
          onDone={() => setShowForm(false)}
        />
      )}

      {goals.length > 0 && (
        <ul className="space-y-2">
          {goals.map((goal) => (
            <li key={goal._id}>
              <GoalRow
                goal={goal}
                projects={projects}
                projectNameById={projectNameById}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateGoalForm({
  parentType,
  parentId,
  projects,
  onDone,
}: {
  parentType: ParentType;
  parentId: string;
  projects: ProjectOption[];
  onDone: () => void;
}) {
  const create = useMutation(api.goals.create);
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("number");
  const [targetValue, setTargetValue] = useState("100");
  const [unit, setUnit] = useState("");
  const [sourceListId, setSourceListId] = useState<Id<"lists"> | null>(null);
  const [pending, setPending] = useState(false);

  // A linked goal counts completed tasks — always a plain number target.
  const effectiveType: TargetType = sourceListId ? "number" : targetType;
  const sourceName = sourceListId
    ? (projects.find((p) => p.id === (sourceListId as string))?.label ??
      "project")
    : null;

  return (
    <Card className="p-4">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || pending) return;
          setPending(true);
          try {
            await create({
              parentType,
              parentId,
              title: title.trim(),
              targetType: effectiveType,
              targetValue:
                effectiveType === "boolean" ? 1 : Number(targetValue) || 0,
              unit: sourceListId ? unit.trim() || "tasks" : unit.trim() || undefined,
              sourceListId: sourceListId ?? undefined,
            });
            onDone();
          } catch (e) {
            toast(errorMessage(e, "Couldn't create goal"), { kind: "error" });
          } finally {
            setPending(false);
          }
        }}
        className="space-y-2"
      >
        <Input
          type="text"
          placeholder="Goal title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {!sourceListId && (
            <select
              value={targetType}
              onChange={(e) =>
                setTargetType(e.currentTarget.value as TargetType)
              }
              className={SELECT_CLASS}
            >
              {(Object.keys(TARGET_LABEL) as TargetType[]).map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABEL[t]}
                </option>
              ))}
            </select>
          )}
          {effectiveType !== "boolean" && (
            <>
              <Input
                type="number"
                inputMode="decimal"
                value={targetValue}
                onChange={(e) => setTargetValue(e.currentTarget.value)}
                className="w-28"
                placeholder="Target"
              />
              <Input
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.currentTarget.value)}
                placeholder={
                  sourceListId
                    ? "tasks"
                    : targetType === "money"
                      ? "USD"
                      : "tasks"
                }
                className="w-28"
              />
            </>
          )}
          <Button
            type="submit"
            size="sm"
            className="ml-auto"
            disabled={!title.trim() || pending}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sourceListId ? (
            <TracksChip
              name={sourceName ?? "project"}
              onClear={() => setSourceListId(null)}
            />
          ) : (
            <Picker
              label="Track a project…"
              dashed
              options={projects}
              onSelect={(id) => setSourceListId(id as Id<"lists">)}
            />
          )}
          <span className="text-xs text-muted-foreground">
            {sourceListId
              ? "Progress counts that project's completed tasks — no manual updates."
              : "Optional: progress moves itself as tasks complete."}
          </span>
        </div>
      </form>
    </Card>
  );
}

// "Tracks {project}" chip with a clear (x). Same voice in create and row.
function TracksChip({
  name,
  onClear,
}: {
  name: string;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs font-medium">
      Tracks {name}
      <button
        type="button"
        aria-label={`Stop tracking ${name}`}
        onClick={onClear}
        className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function GoalRow({
  goal,
  projects,
  projectNameById,
}: {
  goal: Goal;
  projects: ProjectOption[];
  projectNameById: Map<string, string>;
}) {
  const setProgress = useMutation(api.goals.setProgress);
  const update = useMutation(api.goals.update);
  const remove = useMutation(api.goals.remove);
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  if (deleting) return null;

  const progress =
    goal.targetValue > 0
      ? Math.min(1, Math.max(0, goal.currentValue / goal.targetValue))
      : 0;

  const sourceName = goal.sourceListId
    ? (projectNameById.get(goal.sourceListId as string) ?? "a project")
    : null;

  function link(listId: string) {
    void update({
      goalId: goal._id,
      sourceListId: listId as Id<"lists">,
    }).catch((e) =>
      toast(errorMessage(e, "Couldn't link this goal"), { kind: "error" }),
    );
  }

  function unlink() {
    void update({ goalId: goal._id, sourceListId: null }).catch((e) =>
      toast(errorMessage(e, "Couldn't unlink this goal"), { kind: "error" }),
    );
  }

  return (
    <Card
      className={cn(
        "p-4",
        goal.status === "complete" && "border-green-500/40",
        goal.status === "abandoned" && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{goal.title}</h3>
          {goal.description && (
            <p className="text-xs text-muted-foreground">{goal.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <select
            aria-label="Goal status"
            value={goal.status}
            title={
              goal.linked
                ? "Status follows the tracked project; only Abandoned can be set by hand."
                : undefined
            }
            onChange={(e) =>
              update({
                goalId: goal._id,
                status: e.currentTarget.value as GoalStatus,
              })
            }
            className={cn(SELECT_CLASS, "h-7 px-2 py-0.5 text-xs")}
          >
            {(Object.keys(STATUS_LABEL) as GoalStatus[]).map((s) => (
              <option
                key={s}
                value={s}
                // A linked goal derives open/complete on every read — writing
                // them would silently snap back. Abandoned (and the current
                // derived value) stay selectable.
                disabled={
                  goal.linked && s !== "abandoned" && s !== goal.status
                }
              >
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Delete goal"
            onClick={() => {
              setDeleting(true);
              toast(`"${goal.title}" deleted`, {
                action: { label: "Undo", onClick: () => setDeleting(false) },
                onExpire: () => remove({ goalId: goal._id }),
              });
            }}
            className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {goal.linked ? (
          <TracksChip name={sourceName ?? "a project"} onClear={unlink} />
        ) : (
          // Only number goals can track a project (the server refuses the
          // rest — a money/boolean goal deriving a task count is nonsense).
          goal.status !== "abandoned" &&
          goal.targetType === "number" && (
            <Picker
              label="Track a project…"
              dashed
              options={projects}
              onSelect={link}
            />
          )
        )}
        {goal.linked && (
          <span className="text-xs text-muted-foreground">
            Progress updates itself as tasks complete.
          </span>
        )}
      </div>

      <div className="mt-3">
        {goal.targetType === "boolean" ? (
          goal.linked ? (
            <p className="text-sm">
              {goal.currentValue >= 1 ? "Done" : "Not done"}
            </p>
          ) : (
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={goal.currentValue >= 1}
                onChange={(e) =>
                  setProgress({
                    goalId: goal._id,
                    currentValue: e.currentTarget.checked ? 1 : 0,
                  })
                }
              />
              {goal.currentValue >= 1 ? "Done" : "Not done"}
            </label>
          )
        ) : (
          <ProgressEditor goal={goal} progress={progress} />
        )}
      </div>
    </Card>
  );
}

function ProgressEditor({
  goal,
  progress,
}: {
  goal: Goal;
  progress: number;
}) {
  const setProgress = useMutation(api.goals.setProgress);
  const { toast } = useToast();
  const [draft, setDraft] = useState(goal.currentValue.toString());

  const moneyPrefix =
    goal.targetType === "money" ? `${goal.unit ?? "$"} ` : "";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {moneyPrefix}
          {goal.currentValue}
          <span className="mx-1">/</span>
          {moneyPrefix}
          {goal.targetValue}
          {goal.unit && goal.targetType !== "money" && ` ${goal.unit}`}
        </span>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      <Progress value={progress * 100} className="h-2" />
      {/* Linked goals derive the number from the project's rollup — the
          server refuses manual setProgress, so no input to offer. */}
      {!goal.linked && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => {
              const n = Number(draft);
              if (!Number.isFinite(n)) {
                setDraft(goal.currentValue.toString());
                return;
              }
              if (n !== goal.currentValue) {
                void setProgress({
                  goalId: goal._id,
                  currentValue: n,
                }).catch((e) => {
                  setDraft(goal.currentValue.toString());
                  toast(errorMessage(e, "Couldn't update progress"), {
                    kind: "error",
                  });
                });
              }
            }}
            className="w-28"
          />
          <span className="text-xs text-muted-foreground">
            Update progress
          </span>
        </div>
      )}
    </div>
  );
}
