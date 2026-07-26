"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

// Notification preferences.
//
// The copy under each toggle says what it actually controls, and the panel says
// plainly what turning something off does NOT do: nothing here stops work being
// recorded. Mentions still land in the inbox, approvals still queue, the event
// log is untouched. Only the live nudge is silenced. A settings screen that
// quietly drops data is a bug wearing a checkbox, so it is worth stating.

const CATEGORIES = [
  {
    key: "mentions" as const,
    label: "Mentions",
    hint: "Someone — or some agent — names you in a comment or a thread.",
  },
  {
    key: "assignments" as const,
    label: "Assignments",
    hint: "A task is assigned to you, or handed to you by an agent.",
  },
  {
    key: "approvals" as const,
    label: "Approvals",
    hint: "Work is gated and waiting on your sign-off.",
  },
  {
    key: "revisions" as const,
    label: "Revisions",
    hint: "A revision you asked for was addressed, or one was asked of you.",
  },
  {
    key: "agentErrors" as const,
    label: "Agent failures",
    hint: "An agent reported an error or stalled mid-task.",
  },
  {
    key: "agentPresence" as const,
    label: "Agents coming online",
    hint: "An agent connects or goes quiet. Chatty on a large fleet.",
  },
  {
    key: "taskUpdates" as const,
    label: "All task activity",
    hint: "Every change in the projects you can see. The full firehose.",
  },
];

export function NotificationSettings() {
  const prefs = useQuery(api.notificationPrefs.current, {});
  const set = useMutation(api.notificationPrefs.set);
  const { toast } = useToast();

  async function toggle(key: string, next: boolean) {
    try {
      await set({ prefs: { [key]: next } });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save that", {
        kind: "error",
      });
    }
  }

  const realtime = prefs?.realtime ?? true;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          These control the live nudge only. Turning one off never stops the
          work being recorded — mentions still reach your inbox, approvals still
          queue, and the activity log is unchanged.
        </p>
      </div>

      <Row
        label="Live updates"
        hint="The master switch. Off means no push at all, on any category."
        checked={realtime}
        disabled={prefs === undefined}
        onChange={(next) => void toggle("realtime", next)}
        emphasis
      />

      <div
        className={cn(
          "space-y-4 transition-opacity",
          !realtime && "pointer-events-none opacity-40",
        )}
        aria-disabled={!realtime}
      >
        {CATEGORIES.map((category) => (
          <Row
            key={category.key}
            label={category.label}
            hint={category.hint}
            checked={prefs?.[category.key] ?? false}
            disabled={prefs === undefined || !realtime}
            onChange={(next) => void toggle(category.key, next)}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  checked,
  disabled,
  onChange,
  emphasis,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  emphasis?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start justify-between gap-4",
        disabled && "cursor-default",
      )}
    >
      <span className="min-w-0">
        <span
          className={cn(
            "block text-sm text-foreground",
            emphasis && "font-semibold",
          )}
        >
          {label}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
    </label>
  );
}
