"use client";

// Reminders, as a section of Home rather than a screen of their own.
//
// Buzz deleted `/reminders` and made it an inbox filter (§4.5), and the reason
// generalises: a reminder is not a place you go, it is one of the things
// waiting for you — so it belongs beside the unread rooms, sorted by the same
// question ("what has a claim on my attention"), not behind a second click.
//
// Overdue is stated flatly and first. A missed reminder is the most useful row
// on this screen and softening it ("a little while ago") is how a product
// teaches people to stop trusting it.

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { Stagger, StaggerItem } from "@/components/motion";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  TIME_PRESETS,
  countDue,
  formatRelativeTime,
  groupReminders,
  reminderBody,
  reminderHref,
  type ReminderLike,
} from "./model";
import { RemindMeLater } from "./remind-me-later";

type ScopeArgs = { scopeType: string; scopeId: string };

/** `api.buzz.reminders.*` — named by hand, see canvas-pane.tsx. */
const listRef = makeFunctionReference<
  "query",
  ScopeArgs & { includeSettled?: boolean },
  ReminderLike[] | null
>("buzz/reminders:list");
const snoozeRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { reminderId: string; notBefore: number },
  unknown
>("buzz/reminders:snooze");
const settleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { reminderId: string; status: "done" | "cancelled" },
  unknown
>("buzz/reminders:settle");

export function RemindersSection({ scope }: { scope: ChatScope | null }) {
  const [composing, setComposing] = useState(false);
  const reminders = useQuery(listRef, scope ? { ...scope } : "skip");

  // Absent is loading; empty is a real answer and gets a real (quiet) state.
  if (reminders === undefined || reminders === null) return null;

  const now = Date.now();
  const due = countDue(reminders, now);
  const groups = groupReminders(reminders, now);

  return (
    <section aria-labelledby="chat-reminders-heading" className="mt-10">
      <div className="flex items-center gap-2">
        <h2
          id="chat-reminders-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Reminders
        </h2>
        {due > 0 ? <span className="chat-badge shrink-0">{due}</span> : null}
        <span className="min-w-0 flex-1" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={composing}
          onClick={() => setComposing((open) => !open)}
        >
          {composing ? "Close" : "Remind me"}
        </Button>
      </div>

      {composing ? (
        <div className="bento-tile mt-3 rounded-xl p-3">
          <RemindMeLater scope={scope} onDone={() => setComposing(false)} />
        </div>
      ) : null}

      {groups.length === 0 && !composing ? (
        <p className="chat-quiet mt-3 text-sm">
          Nothing set. Reminders you make from a message land here.
        </p>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="mt-4">
          <p className="chat-quiet text-xs uppercase tracking-wider">
            {group.label}
          </p>
          <Stagger className="mt-1 space-y-1">
            {group.reminders.map((reminder) => (
              <StaggerItem key={reminder.reminderId}>
                <ReminderRow scope={scope} reminder={reminder} now={now} />
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      ))}
    </section>
  );
}

function ReminderRow({
  scope,
  reminder,
  now,
}: {
  scope: ChatScope | null;
  reminder: ReminderLike;
  now: number;
}) {
  const { toast } = useToast();
  const snooze = useMutation(snoozeRef);
  const settle = useMutation(settleRef);
  const [snoozing, setSnoozing] = useState(false);

  const run = useCallback(
    async (what: () => Promise<unknown>, said: string) => {
      try {
        await what();
        toast(said);
      } catch (error) {
        toast(error instanceof Error ? error.message : "That did not work", {
          kind: "error",
        });
      }
    },
    [toast],
  );

  const body = reminderBody(reminder);
  const overdue = reminder.dueAtMs !== null && reminder.dueAtMs <= now;

  return (
    <div className="rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/70">
      <div className="flex items-center gap-3">
        <Link href={reminderHref(reminder)} className="min-w-0 flex-1">
          <span className="block truncate text-sm">{body || "Reminder"}</span>
          <span className="chat-quiet block truncate text-xs">
            {reminder.dueAtMs !== null
              ? formatRelativeTime(reminder.dueAtMs, now)
              : "No time set"}
          </span>
        </Link>
        {overdue ? <span className="chat-dot shrink-0" aria-hidden /> : null}
        <Button
          size="sm"
          variant="ghost"
          className="tap-target"
          onClick={() =>
            scope &&
            run(
              () =>
                settle({
                  ...scope,
                  reminderId: reminder.reminderId,
                  status: "done",
                }),
              "Reminder completed",
            )
          }
        >
          Complete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="tap-target"
          aria-expanded={snoozing}
          onClick={() => setSnoozing((open) => !open)}
        >
          Snooze
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="tap-target"
          onClick={() =>
            scope &&
            run(
              () =>
                settle({
                  ...scope,
                  reminderId: reminder.reminderId,
                  status: "cancelled",
                }),
              "Reminder cancelled",
            )
          }
        >
          Cancel
        </Button>
      </div>

      {/* The same five presets the create dialog offers — one list, so "In 1
          hour" cannot mean two things depending on which menu you opened. */}
      {snoozing ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TIME_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              size="xs"
              variant="secondary"
              onClick={() => {
                if (!scope) return;
                setSnoozing(false);
                void run(
                  () =>
                    snooze({
                      ...scope,
                      reminderId: reminder.reminderId,
                      notBefore: Math.floor(
                        preset.at(new Date()).getTime() / 1000,
                      ),
                    }),
                  `Snoozed — ${preset.label.toLowerCase()}`,
                );
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
