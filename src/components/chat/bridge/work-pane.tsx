"use client";

// The Work side of a room, docked beside the conversation.
//
// Three sections, and the order is the order the questions arrive: what is this
// room about, what has happened in it, who is working on it. Every one of them
// is a **read across the seam** — nothing on this pane is stored by the bridge
// except the first line's answer, which is a pointer to a project and nothing
// else.
//
// The binding is the only control here, and it is community-governed rather
// than room-governed: pointing a room at a project decides what everybody in
// the room sees and takes a project's activity across a tenancy boundary, so it
// uses the same bar `channels.update` and moderation use. The server refuses
// either way; hiding the control from somebody who cannot use it is the polite
// half, not the boundary.

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { timeAgo } from "@/lib/time";
import { errorMessage } from "@/lib/errors";
import { eventLabel } from "@/lib/event-labels";
import { bindingSentence, workHref } from "@/lib/buzz/bridge";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  useBindProject,
  useBindableProjects,
  useFleet,
  useRoomBinding,
  useRoomWorkFeed,
  useUnbindProject,
} from "./bridge-data";

export function WorkPane({
  scope,
  channelId,
}: {
  scope: ChatScope | null;
  channelId: string;
}) {
  const { binding, subscription: bindingSub } = useRoomBinding(scope, channelId);
  const { rows, subscription: feedSub } = useRoomWorkFeed(scope, channelId);
  const { fleet, subscription: fleetSub } = useFleet(scope, channelId);

  return (
    <div className="space-y-6 pb-2">
      {bindingSub}
      {feedSub}
      {fleetSub}

      <BindingSection scope={scope} channelId={channelId} binding={binding} />

      <section>
        <h3 className="chat-quiet text-tiny font-medium uppercase tracking-wider">
          Activity
        </h3>
        {rows.length === 0 ? (
          <p className="chat-quiet mt-2 text-sm">
            {binding?.projectId
              ? "Nothing has happened in this project yet."
              : "Bind this room to a project and its work shows up here."}
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {rows.map((row) => {
              const href =
                row.entityType === "task" && row.listId
                  ? workHref("task", row.entityId, { listId: row.listId })
                  : row.entityType === "project"
                    ? workHref("project", row.entityId)
                    : null;
              const title = row.entityTitle ?? "";
              return (
                <li key={row.eventId} className="text-sm leading-snug">
                  <span className="font-medium">{row.actorName}</span>{" "}
                  <span className="chat-quiet">{eventLabel(row.type)}</span>{" "}
                  {href ? (
                    <Link href={href} className="underline-offset-2 hover:underline">
                      {title}
                    </Link>
                  ) : (
                    <span>{title}</span>
                  )}
                  <span className="chat-quiet ml-1 text-xs">
                    {timeAgo(row.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="chat-quiet text-tiny font-medium uppercase tracking-wider">
          Fleet
        </h3>
        {fleet.length === 0 ? (
          <p className="chat-quiet mt-2 text-sm">
            No agents in this community yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {fleet.map((agent) => (
              <li key={agent.agentId} className="text-sm leading-snug">
                <div className="flex items-baseline gap-2">
                  <Link
                    href={`/dashboard/agents/${agent.agentId}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {agent.name}
                  </Link>
                  {agent.inThisRoom ? (
                    <span className="chat-quiet text-xs">in this room</span>
                  ) : null}
                  {agent.status === "paused" ? (
                    <span className="chat-quiet text-xs">paused</span>
                  ) : null}
                </div>
                {/* Both halves of one sentence. "Scout is on Payroll rewrite"
                    comes from `agents.currentTaskId`, written by the Work claim
                    path; "and answering in #billing" comes from `buzzTurns`,
                    written by the Chat turn path. Neither is copied into the
                    other — they are simply read together, which is the whole of
                    what "one fleet" had left to become. */}
                <p className="chat-quiet text-xs">
                  {agent.workTaskTitle && agent.workListId ? (
                    <Link
                      href={
                        workHref("task", agent.workTaskId ?? "", {
                          listId: agent.workListId,
                        }) ?? "#"
                      }
                      className="underline-offset-2 hover:underline"
                    >
                      {agent.workTaskTitle}
                    </Link>
                  ) : null}
                  {agent.workTaskTitle && agent.rooms.length > 0 ? " · " : null}
                  {agent.rooms.length > 0
                    ? agent.rooms.map((room) => `#${room.channelName}`).join(", ")
                    : null}
                  {!agent.workTaskTitle && agent.rooms.length === 0
                    ? (agent.statusText ?? "Idle")
                    : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BindingSection({
  scope,
  channelId,
  binding,
}: {
  scope: ChatScope | null;
  channelId: string;
  binding: ReturnType<typeof useRoomBinding>["binding"];
}) {
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const { projects, subscription } = useBindableProjects(picking ? scope : null);
  const bind = useBindProject();
  const unbind = useUnbindProject();

  if (!scope) return null;
  const args = { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId };

  return (
    <section>
      {subscription}
      <h3 className="chat-quiet text-tiny font-medium uppercase tracking-wider">
        Project
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {binding?.projectId ? (
          <Link
            href={workHref("project", binding.projectId) ?? "#"}
            className="font-medium underline-offset-2 hover:underline"
          >
            {binding.projectName}
          </Link>
        ) : (
          <span className="chat-quiet">
            {bindingSentence(null, binding?.bound ?? false)}
          </span>
        )}
        {binding?.mayGovern ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPicking((v) => !v)}
            >
              {binding.bound ? "Change" : "Bind"}
            </Button>
            {binding.bound ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void unbind(args).catch((error: unknown) =>
                    toast(errorMessage(error, "Couldn't unbind the room"), {
                      kind: "error",
                    }),
                  );
                }}
              >
                Unbind
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {picking ? (
        <ul className="mt-2 space-y-1">
          {projects.length === 0 ? (
            <li className="chat-quiet text-sm">
              {/* Narrowed to this community by the query itself rather than by
                  a filter here — a picker that could offer another tenant's
                  project would be a tenancy hole with a nice interface. */}
              No projects in this community.
            </li>
          ) : (
            projects.map((project) => (
              <li key={project.projectId}>
                <button
                  type="button"
                  className="tap-target w-full rounded px-2 py-1 text-left text-sm hover:bg-[var(--chat-hover)]"
                  onClick={() => {
                    setPicking(false);
                    void bind({ ...args, projectId: project.projectId })
                      .then(() => toast(`Room bound to ${project.name}`))
                      .catch((error: unknown) =>
                        toast(errorMessage(error, "Couldn't bind the room"), {
                          kind: "error",
                        }),
                      );
                  }}
                >
                  {project.name}
                  <span className="chat-quiet ml-2 text-xs">
                    {project.spaceName}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}
