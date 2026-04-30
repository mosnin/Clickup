"use client";

import { CheckCircle2, CalendarRange, Filter, Flame, User } from "lucide-react";
import {
  isFilterActive,
  type TaskFilter,
} from "@/lib/use-task-filter";
import { cn } from "@/lib/utils";

// Chip bar shown above List/Board views. Each chip toggles one filter;
// chips AND together. The "Hide completed" chip is inverted (active =
// hidden) so the bar reads as a list of restrictions.

type Props = {
  filter: TaskFilter;
  onChange: (next: TaskFilter) => void;
  totalCount: number;
  visibleCount: number;
  // Optional "Select" toggle for entering bulk-edit mode.
  selectMode?: boolean;
  onToggleSelectMode?: () => void;
};

export function FilterChips({
  filter,
  onChange,
  totalCount,
  visibleCount,
  selectMode,
  onToggleSelectMode,
}: Props) {
  const active = isFilterActive(filter);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip
        active={filter.mine}
        onClick={() => onChange({ ...filter, mine: !filter.mine })}
        icon={<User className="h-3.5 w-3.5" aria-hidden />}
      >
        Mine
      </Chip>
      <Chip
        active={filter.dueThisWeek}
        onClick={() =>
          onChange({ ...filter, dueThisWeek: !filter.dueThisWeek })
        }
        icon={<CalendarRange className="h-3.5 w-3.5" aria-hidden />}
      >
        Due this week
      </Chip>
      <Chip
        active={filter.highPriorityPlus}
        onClick={() =>
          onChange({
            ...filter,
            highPriorityPlus: !filter.highPriorityPlus,
          })
        }
        icon={<Flame className="h-3.5 w-3.5" aria-hidden />}
      >
        High+
      </Chip>
      <Chip
        active={filter.hideCompleted}
        onClick={() =>
          onChange({ ...filter, hideCompleted: !filter.hideCompleted })
        }
        icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
      >
        Hide completed
      </Chip>

      {active && visibleCount !== totalCount && (
        <span className="text-xs text-muted-foreground">
          {visibleCount} of {totalCount}
        </span>
      )}
      {active && (
        <button
          type="button"
          onClick={() =>
            onChange({
              mine: false,
              dueThisWeek: false,
              highPriorityPlus: false,
              hideCompleted: false,
            })
          }
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}

      {onToggleSelectMode && (
        <button
          type="button"
          onClick={onToggleSelectMode}
          className={cn(
            "ml-auto inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs",
            selectMode
              ? "border-brand-500 bg-brand-50 text-brand-700"
              : "border-border bg-background hover:bg-muted",
          )}
        >
          <Filter className="h-3.5 w-3.5" aria-hidden />
          {selectMode ? "Done" : "Select"}
        </button>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs",
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-border bg-background text-foreground hover:bg-muted",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
