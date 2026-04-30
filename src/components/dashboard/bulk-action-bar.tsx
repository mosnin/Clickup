"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { CheckSquare, Trash2, UserPlus, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { useToast } from "@/components/dashboard/toast";

// Pinned bottom bar that pops up while one or more tasks are selected
// in List view. Three actions: complete, assign-to-me, delete. Delete
// shows a single Undo toast for the whole batch (server soft-deletes,
// undo restores each id we just hit).

type Props = {
  selectedIds: Set<Id<"tasks">>;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  onClear: () => void;
};

export function BulkActionBar({
  selectedIds,
  tasks,
  statuses,
  onClear,
}: Props) {
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const restore = useMutation(api.tasks.restore);
  const toast = useToast();
  const { user } = useUser();
  const [pending, setPending] = useState(false);

  if (selectedIds.size === 0) return null;

  const targets = tasks.filter((t) => selectedIds.has(t._id));

  async function complete() {
    if (pending) return;
    setPending(true);
    try {
      // Per-list "complete" status. Different selected tasks could be
      // on the same list so we can resolve once.
      const completeStatus = statuses.find((s) => s.category === "complete");
      if (!completeStatus) return;
      await Promise.all(
        targets
          .filter((t) => t.statusId !== completeStatus._id)
          .map((t) =>
            update({ taskId: t._id, statusId: completeStatus._id }),
          ),
      );
      onClear();
    } finally {
      setPending(false);
    }
  }

  async function assignToMe() {
    if (pending || !user?.id) return;
    setPending(true);
    try {
      await Promise.all(
        targets.map((t) => {
          const next = t.assigneeClerkIds.includes(user.id)
            ? t.assigneeClerkIds
            : [...t.assigneeClerkIds, user.id];
          return update({ taskId: t._id, assigneeClerkIds: next });
        }),
      );
      onClear();
    } finally {
      setPending(false);
    }
  }

  async function deleteSelected() {
    if (pending) return;
    setPending(true);
    try {
      const ids = targets.map((t) => t._id);
      await Promise.all(ids.map((id) => remove({ taskId: id })));
      onClear();
      toast.showUndo({
        label: `Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}`,
        onUndo: () => Promise.all(ids.map((id) => restore({ taskId: id }))),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-foreground px-2 py-1.5 text-sm text-background shadow-2xl"
    >
      <span className="px-2 text-xs font-medium">
        {selectedIds.size} selected
      </span>
      <ActionButton
        icon={<CheckSquare className="h-3.5 w-3.5" />}
        onClick={complete}
        disabled={pending}
      >
        Complete
      </ActionButton>
      <ActionButton
        icon={<UserPlus className="h-3.5 w-3.5" />}
        onClick={assignToMe}
        disabled={pending || !user?.id}
      >
        Assign to me
      </ActionButton>
      <ActionButton
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={deleteSelected}
        disabled={pending}
        danger
      >
        Delete
      </ActionButton>
      <button
        type="button"
        aria-label="Clear selection"
        onClick={onClear}
        className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-background/70 hover:bg-background/15 hover:text-background"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ActionButton({
  icon,
  onClick,
  disabled,
  danger,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors disabled:opacity-50 " +
        (danger
          ? "text-red-300 hover:bg-red-500/20"
          : "hover:bg-background/15")
      }
    >
      {icon}
      {children}
    </button>
  );
}
