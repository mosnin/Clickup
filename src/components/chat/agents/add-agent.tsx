"use client";

// Putting an agent in a room.
//
// It is the same act as adding a person, and it is drawn as the same act on
// purpose (02-agents §3.1: adding an agent to a channel calls the same
// membership API a human does; `buzz/agents:attach` routes through
// `channels.addMembers`). What it is NOT is a "connect an integration" flow
// with its own vocabulary and its own screen — filing a colleague under
// Integrations is what turns it into furniture.
//
// The control is a `Picker` rather than a dialog, and that is the difference
// between one gesture and four. A dialog would be right if there were choices
// to make; there is one choice, which agent, and everything else about the
// agent — its permissions, its budget, its key — was decided where agents are
// decided and is not re-asked here.
//
// **Refusals are offered, not hidden.** The query returns the agents it will
// not attach along with why, and this control shows them: an agent missing from
// a picker is indistinguishable from an agent that does not exist, and the two
// commonest blocks ("No Chat identity yet", "Restricted to specific lists") are
// both things a person fixes in ten seconds once somebody tells them. Picking
// one says the reason instead of doing nothing.

import { useState } from "react";
import Link from "next/link";
import { Picker, type PickerOption } from "@/components/ui/picker";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { useAgentRoomActions } from "./data";
import type { AttachableAgent } from "./refs";

export function AddAgentControl({
  scope,
  channelId,
  roomLabel,
  agents,
  className,
}: {
  scope: ChatScope | null;
  channelId: string;
  /** `#flight-path`. Named in the confirmation, so the toast is not ambiguous. */
  roomLabel: string;
  /** The whole community, attached flag included. `undefined` = loading. */
  agents: readonly AttachableAgent[] | undefined;
  className?: string;
}) {
  const { attach } = useAgentRoomActions(scope, channelId);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (agents === undefined) {
    // Loading is not "no agents". A picker that renders empty for a second and
    // then fills is a picker somebody has already concluded is broken.
    return <p className={cn("chat-quiet text-xs", className)}>Loading agents…</p>;
  }

  const candidates = agents.filter((agent) => !agent.attached);

  // Two different empty states, because they need two different next actions:
  // an empty community needs an agent created, and a fully-attached one needs
  // nothing at all. One sentence for both would be wrong for one of them.
  if (candidates.length === 0) {
    return (
      <p className={cn("chat-quiet text-xs", className)}>
        {agents.length === 0
          ? "No agents in this community yet. "
          : "Every agent in this community is already here. "}
        <Link href="/dashboard/agents" className="underline underline-offset-2">
          {agents.length === 0 ? "Create one" : "Create another"}
        </Link>
        .
      </p>
    );
  }

  const options: PickerOption[] = candidates.map((agent) => ({
    id: agent.agentId,
    label: agent.name,
    ...(agent.blockedReason ? { hint: agent.blockedReason } : {}),
  }));

  return (
    <div className={className}>
      <Picker
        dashed
        options={options}
        label={busy ? "Adding…" : "Add an agent"}
        disabled={busy}
        onSelect={async (agentId) => {
          const agent = candidates.find((candidate) => candidate.agentId === agentId);
          if (!agent) return;
          if (agent.blockedReason) {
            // Say the reason rather than silently refusing. A control that does
            // nothing when you use it is the worst possible answer, because the
            // next thing somebody does is create a second agent.
            toast(`${agent.name} cannot join this room: ${agent.blockedReason}`, {
              kind: "error",
            });
            return;
          }
          setBusy(true);
          try {
            await attach(agentId);
            toast(`${agent.name} added to ${roomLabel}`);
          } catch (error) {
            // The server's own reason: "Join this channel before adding an
            // agent to it" is the sentence that tells you what you did.
            toast(error instanceof Error ? error.message : "Could not add that agent", {
              kind: "error",
            });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
