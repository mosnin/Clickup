"use client";

// An agent in the member list.
//
// The one-sentence model this whole module is built on (02-agents §0): **an
// agent is a member of the workspace, not a bot attached to it.** Everything
// below follows mechanically from taking that literally.
//
// So the identity line is `PresenceRow` — the *same component* a person gets,
// not a lookalike with a robot glyph. Same avatar, same presence dot in the
// same place, same name treatment, same truncation. The only difference is the
// one the avatar already draws: a squircle instead of a circle. That is not
// minimalism, it is the claim — a machine working beside you is a colleague you
// can see, and a rail that files it under Integrations makes it furniture.
//
// What an agent's row carries that a person's does not is only ever a fact a
// person's row could not have:
//
//   • **What it is doing right now**, with the elapsed time — because unlike a
//     colleague you cannot lean over and ask.
//   • **That it stopped mid-sentence** — a stalled turn. A person who goes
//     quiet is thinking; a harness that goes quiet has usually died, and the
//     two must not be drawn the same way.
//   • **Whether anything is running it at all** — D9's accepted cost, and the
//     single most likely thing in this product to be mistaken for a bug. See
//     `silence.tsx`.

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { PresenceProvider, PresenceRow } from "@/components/chat/presence";
import { AddAgentControl } from "./add-agent";
import { AgentActivityLog } from "./activity-log";
import { useAgentRoomActions, useRoomAgents } from "./data";
import type { AttachableAgent, RoomTurn } from "./refs";
import { readAgentState } from "./signal";
import { HarnessSilence } from "./silence";
import { formatTurnElapsed } from "./turn";
import { useRoomWorkingSignal, TurnElapsed, WorkingPulse } from "./working-signal";

/**
 * The room's agents: who is here, what they are doing, and who could be.
 *
 * One query answers both halves (`buzz/agents:attachable` returns the community
 * with an `attached` flag), which is why the picker can never offer somebody the
 * list above it is already showing.
 */
export function RoomAgentsPanel({
  scope,
  channelId,
  roomLabel,
  className,
}: {
  scope: ChatScope | null;
  channelId: string;
  roomLabel: string;
  className?: string;
}) {
  const room = useRoomAgents(scope, channelId);
  const signal = useRoomWorkingSignal(scope, channelId);
  const [removed, setRemoved] = useState<readonly string[]>([]);

  const shown = room.attached.filter((agent) => !removed.includes(agent.agentId));
  // Seeded so an agent that has never beaten still has a roster row. Without it
  // the honest-silence case — the one this panel most needs to draw — would be
  // an agent that is simply missing from the list.
  const seed = shown.map((agent) => ({
    actorId: agent.agentId,
    actorType: "agent" as const,
  }));

  const turnsOf = (agentId: string): RoomTurn[] =>
    (signal.turns ?? []).filter((turn) => turn.agentId === agentId);

  const silent = shown.filter(
    (agent) =>
      readAgentState({
        turns: turnsOf(agent.agentId),
        lastSeenAt: agent.lastSeenAt ?? null,
        now: signal.now,
      }) === "never-connected",
  );

  return (
    <PresenceProvider scope={scope} seed={seed}>
      <section className={cn("flex min-w-0 flex-col gap-3", className)}>
        {room.subscription}
        {signal.subscriptions}

        {room.all === undefined ? (
          <p className="chat-quiet text-xs">Loading agents…</p>
        ) : shown.length === 0 ? (
          <p className="chat-quiet text-xs">No agents in {roomLabel} yet.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {shown.map((agent) => (
              <li key={agent.agentId} className="min-w-0">
                <AgentMemberRow
                  agent={agent}
                  turns={turnsOf(agent.agentId)}
                  now={signal.now}
                  scope={scope}
                  channelId={channelId}
                  roomLabel={roomLabel}
                  onRemove={() => setRemoved((list) => [...list, agent.agentId])}
                  onRestore={() =>
                    setRemoved((list) => list.filter((id) => id !== agent.agentId))
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {/* The whole-room form of D9, computed from the rows above rather than
            repeated on each of them: three silent agents is one fact about the
            room, and three copies of the same paragraph is a wall. */}
        <HarnessSilence names={silent.map((agent) => agent.name)} />

        <AddAgentControl
          scope={scope}
          channelId={channelId}
          roomLabel={roomLabel}
          agents={room.all}
        />

        {room.error ?? signal.error ? (
          <p className="chat-quiet text-[0.6875rem]">
            {/* The reason, verbatim. On a deployment that has not run
                `npx convex dev` this reads "Could not find public function …",
                which is the sentence that tells whoever is looking what is
                missing — and is emphatically better than an empty list
                implying calm. */}
            Agent activity is unavailable: {room.error ?? signal.error}
          </p>
        ) : null}
      </section>
    </PresenceProvider>
  );
}

export function AgentMemberRow({
  agent,
  turns,
  now,
  scope,
  channelId,
  roomLabel,
  onRemove,
  onRestore,
}: {
  agent: AttachableAgent;
  /** This agent's turns in this room, whatever their liveness. */
  turns: readonly RoomTurn[];
  now: number;
  scope: ChatScope | null;
  channelId: string;
  roomLabel: string;
  onRemove: () => void;
  onRestore: () => void;
}) {
  const { toast } = useToast();
  const { detach } = useAgentRoomActions(scope, channelId);
  const [open, setOpen] = useState(false);

  const reading = readAgentState({
    turns,
    lastSeenAt: agent.lastSeenAt ?? null,
    now,
  });
  // The newest turn, which is the one any of the three live readings is about.
  const turn = [...turns].sort((a, b) => b.startedAt - a.startedAt)[0];

  return (
    <div
      data-agent-member={agent.agentId}
      data-reading={reading}
      className="group/agent min-w-0 rounded-lg px-1 py-1 transition-colors hover:bg-[var(--chat-hover)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The person's row, unchanged. See the header of this file. */}
        <PresenceRow
          className="min-w-0 flex-1"
          actorId={agent.agentId}
          fallbackName={agent.name}
          isAgent
          {...(agent.pubkey ? { pubkey: agent.pubkey } : {})}
        />
        <span
          // Text, not a bot glyph — the same chip the message row draws, so a
          // name means the same thing in the list and in the transcript.
          className="shrink-0 rounded-full bg-[var(--chat-active)] px-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-[var(--chat-quiet)]"
        >
          agent
        </span>
        <button
          type="button"
          onClick={() => {
            onRemove();
            // Deferred, per the house rule: the row disappears now and the
            // mutation runs when the undo window closes. A remove that fired
            // immediately would make Undo a second mutation that can fail on
            // its own.
            toast(`${agent.name} removed from ${roomLabel}`, {
              action: { label: "Undo", onClick: onRestore },
              onExpire: () => {
                void detach(agent.agentId).catch((error: unknown) => {
                  onRestore();
                  toast(
                    error instanceof Error ? error.message : "Could not remove that agent",
                    { kind: "error" },
                  );
                });
              },
            });
          }}
          aria-label={`Remove ${agent.name} from ${roomLabel}`}
          className="chat-icon-button tap-target shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/agent:opacity-100"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="min-w-0 pl-8">
        {reading === "working" && turn ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            data-agent-activity-toggle={agent.agentId}
            className="tap-target chat-quiet -ml-1 flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 text-[0.6875rem] hover:text-foreground"
          >
            <WorkingPulse />
            <span className="min-w-0 truncate">{turn.narration?.trim() || "Working"}</span>
            <TurnElapsed since={turn.startedAt} now={now} />
          </button>
        ) : reading === "stalled" && turn ? (
          // Not "offline" and not silence: a turn that stopped mid-sentence is
          // a thing that went wrong a moment ago, and the room saying nothing
          // would read as the agent deciding not to answer.
          <p className="chat-quiet text-[0.6875rem]">
            {/* The exact silence, not `timeAgo`: a turn goes stalled after 25
                seconds, and `timeAgo` says "just now" for the first minute —
                which is the opposite of what this sentence is reporting. */}
            Stopped responding {formatTurnElapsed(Math.max(0, now - turn.lastActivityAt))} ago
            — its runtime may have quit.
          </p>
        ) : reading === "idle" ? (
          <p className="chat-quiet text-[0.6875rem]">
            {agent.lastSeenAt
              ? `Idle — last seen ${timeAgo(agent.lastSeenAt)}.`
              : "Idle."}
          </p>
        ) : (
          <p className="chat-quiet text-[0.6875rem]">Never connected.</p>
        )}

        {open && turn ? (
          <AgentActivityLog turn={turn} now={now} className="mt-2 pb-1" />
        ) : null}
      </div>
    </div>
  );
}
