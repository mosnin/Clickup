"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

type ParentType = "user" | "workspace";
type TargetType = Doc<"goals">["targetType"];
type GoalStatus = Doc<"goals">["status"];

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

export function GoalsPanel({
  parentType,
  parentId,
}: {
  parentType: ParentType;
  parentId: string;
}) {
  const goals = useQuery(api.goals.listForParent, { parentType, parentId });
  const [showForm, setShowForm] = useState(false);

  if (goals === undefined) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl bg-muted/40"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {goals.length === 0
            ? "No goals yet."
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
          onDone={() => setShowForm(false)}
        />
      )}

      {goals.length > 0 && (
        <ul className="space-y-2">
          {goals.map((goal) => (
            <li key={goal._id}>
              <GoalRow goal={goal} />
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
  onDone,
}: {
  parentType: ParentType;
  parentId: string;
  onDone: () => void;
}) {
  const create = useMutation(api.goals.create);
  const [title, setTitle] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("number");
  const [targetValue, setTargetValue] = useState("100");
  const [unit, setUnit] = useState("");
  const [pending, setPending] = useState(false);

  return (
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
            targetType,
            targetValue:
              targetType === "boolean" ? 1 : Number(targetValue) || 0,
            unit: unit.trim() || undefined,
          });
          onDone();
        } finally {
          setPending(false);
        }
      }}
      className="space-y-2 rounded-2xl border border-dashed border-border p-3"
    >
      <input
        type="text"
        placeholder="Goal title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <select
          value={targetType}
          onChange={(e) => setTargetType(e.currentTarget.value as TargetType)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-xs"
        >
          {(Object.keys(TARGET_LABEL) as TargetType[]).map((t) => (
            <option key={t} value={t}>
              {TARGET_LABEL[t]}
            </option>
          ))}
        </select>
        {targetType !== "boolean" && (
          <>
            <input
              type="number"
              inputMode="decimal"
              value={targetValue}
              onChange={(e) => setTargetValue(e.currentTarget.value)}
              className="w-28 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
              placeholder="Target"
            />
            <input
              type="text"
              value={unit}
              onChange={(e) => setUnit(e.currentTarget.value)}
              placeholder={targetType === "money" ? "USD" : "tasks"}
              className="w-28 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
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
    </form>
  );
}

function GoalRow({ goal }: { goal: Doc<"goals"> }) {
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

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-background p-3",
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
            value={goal.status}
            onChange={(e) =>
              update({
                goalId: goal._id,
                status: e.currentTarget.value as GoalStatus,
              })
            }
            className="rounded-full border border-border bg-background px-2 py-0.5 text-xs"
          >
            {(Object.keys(STATUS_LABEL) as GoalStatus[]).map((s) => (
              <option key={s} value={s}>
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

      <div className="mt-3">
        {goal.targetType === "boolean" ? (
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
        ) : (
          <ProgressEditor goal={goal} progress={progress} />
        )}
      </div>
    </div>
  );
}

function ProgressEditor({
  goal,
  progress,
}: {
  goal: Doc<"goals">;
  progress: number;
}) {
  const setProgress = useMutation(api.goals.setProgress);
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
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-brand-600 transition-all"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
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
              setProgress({ goalId: goal._id, currentValue: n });
            }
          }}
          className="w-28 rounded-full border border-border bg-background px-3 py-1 text-xs"
        />
        <span className="text-xs text-muted-foreground">
          Update progress
        </span>
      </div>
    </div>
  );
}
