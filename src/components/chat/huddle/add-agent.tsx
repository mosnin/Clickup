"use client";

// Pulling a machine into the call.
//
// **An agent joins a huddle the way a person does** (00-decisions.md D6): the
// same 48101, the same `p` tag, the same roster, one `role` tag different. So
// there is no separate "bot panel" here — the agent appears in the participants
// list beside people, which is the whole point of scoping an agent by identity
// rather than by a flag.
//
// The list comes from `buzz.agents.attachable`, which already answers every
// part of "can this agent be here, and if not why not" — paused, no Chat
// identity yet, restricted to lists, already in the room. A second copy of
// those rules in this folder would be a second place for the *reason* to stop
// being said, and an agent that is silently missing from a picker is
// indistinguishable from an agent that does not exist.

import { useRef, useState } from "react";
import { Bot } from "lucide-react";
import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/chat/transcript/popover";
import { MAX_HUDDLE_AGENTS, agentsIn } from "@/lib/buzz/huddle";
import { useHuddle } from "./huddle-provider";
import { attachableAgentsRef, scopeArgs, type AttachableAgent } from "./refs";

export function AddAgentControl() {
  const { scope, channelId, mine, roster, addAgent } = useHuddle();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const agents = useQuery(
    attachableAgentsRef,
    scope && channelId ? { ...scopeArgs(scope), channelId } : "skip",
  ) as AttachableAgent[] | undefined | null;

  const inCall = new Set(roster.filter((entry) => entry.isAgent).map((entry) => entry.pubkey));
  const full = mine ? agentsIn(mine).length >= MAX_HUDDLE_AGENTS : false;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add an agent to the huddle"
        aria-disabled={mine === null}
        disabled={mine === null}
        data-testid="huddle-add-agent"
        onClick={() => setOpen((value) => !value)}
        className="tap-target chat-icon-button disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Bot aria-hidden className="h-4 w-4" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="Add an agent"
        className="w-72 p-1"
      >
        {full ? (
          <p className="chat-quiet px-2 py-2 text-mini leading-snug">
            This huddle already holds {MAX_HUDDLE_AGENTS} agents.
          </p>
        ) : null}
        <ul className="chat-scroll flex max-h-72 flex-col overflow-y-auto">
          {(agents ?? []).map((agent) => {
            const already = agent.pubkey !== null && inCall.has(agent.pubkey);
            // `attached` means "in the room", which is a prerequisite rather
            // than a block: adding it to the call adds it to the room too.
            const blocked = already || full || (agent.blockedReason !== null && !agent.attached);
            return (
              <li key={agent.agentId}>
                <button
                  type="button"
                  disabled={blocked}
                  data-testid="huddle-agent-option"
                  onClick={() => {
                    setOpen(false);
                    void addAgent(agent.agentId, agent.name);
                  }}
                  className={cn(
                    "tap-target flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left",
                    blocked
                      ? "cursor-not-allowed opacity-55"
                      : "hover:bg-black/5 dark:hover:bg-white/10",
                  )}
                >
                  <span className="text-mini font-medium">{agent.name}</span>
                  {already ? (
                    <span className="chat-quiet text-tiny">Already in the huddle</span>
                  ) : agent.blockedReason && !agent.attached ? (
                    // The reason, verbatim from the server. Each of the common
                    // ones is something a person can fix in ten seconds if
                    // anybody tells them.
                    <span className="chat-quiet text-tiny">{agent.blockedReason}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {agents !== undefined && agents !== null && agents.length === 0 ? (
            <li className="chat-quiet px-2 py-2 text-mini leading-snug">
              No agents in this community yet.
            </li>
          ) : null}
        </ul>
      </Popover>
    </>
  );
}
