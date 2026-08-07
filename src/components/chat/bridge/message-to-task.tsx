"use client";

// "…someone should actually do that." — and now somebody can, without leaving
// the room.
//
// The gesture is deliberately two steps and no dialog: pick a list, done. The
// title comes from the message and the description is the message, so there is
// nothing to fill in — a form here would be a form somebody abandons, and the
// point of the feature is that the thought does not have to survive a context
// switch.
//
// What lands afterwards is the part that matters. The room gets an ordinary
// reply carrying `#[Title](task:id)`, threaded under the message it came from,
// so the connection lives in the log where everyone can see it and where it
// stays live: the chip reads the task's *current* state every time it is drawn.
// A "linked task" column on the message would have been the same information,
// frozen.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { useCreateTaskFromMessage, useTargetLists } from "./bridge-data";

export function MessageToTask({
  scope,
  channelId,
  eventId,
  onDone,
}: {
  scope: ChatScope | null;
  channelId: string;
  eventId: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { lists, subscription } = useTargetLists(scope, channelId);
  const create = useCreateTaskFromMessage();

  if (!scope) return null;

  return (
    <div className="min-w-56 max-w-72">
      {subscription}
      <p className="chat-quiet px-2 py-1 text-tiny font-medium uppercase tracking-wider">
        Make a task in…
      </p>
      {lists.length === 0 ? (
        <p className="chat-quiet px-2 py-1 text-sm">
          {/* The query only ever walks this community's spaces, so an empty
              answer means this community has no lists — never that another
              tenant's were filtered out after the fact. */}
          No lists in this community yet.
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto">
          {lists.map((list) => (
            <li key={list.listId}>
              <button
                type="button"
                disabled={busy}
                className="tap-target flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[var(--chat-hover)] disabled:opacity-50"
                onClick={() => {
                  setBusy(true);
                  void create({
                    scopeType: scope.scopeType,
                    scopeId: scope.scopeId,
                    channelId,
                    eventId,
                    listId: list.listId,
                  })
                    .then((result) => {
                      onDone?.();
                      toast(`Task created in ${list.name}`, {
                        action: {
                          label: "Open",
                          onClick: () =>
                            router.push(
                              `/dashboard/l/${result.listId}/t/${result.taskId}`,
                            ),
                        },
                      });
                    })
                    .catch((error: unknown) =>
                      toast(errorMessage(error, "Couldn't create the task"), {
                        kind: "error",
                      }),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                <span className="truncate">{list.name}</span>
                <span className="chat-quiet shrink-0 text-xs">
                  {/* The bound project's lists sort first and say so: a room
                      that is about a project almost always means that project,
                      and making it the obvious answer is what the binding is
                      for. */}
                  {list.preferred ? "· project" : list.context}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
