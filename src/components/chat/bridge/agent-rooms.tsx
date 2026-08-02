"use client";

// The other direction of "one fleet".
//
// The Chat side already shows an agent's Work task beside its rooms. This is
// the same fact seen from Work: an agent's own page saying which rooms it is
// mid-turn in, live, read from `buzzTurns` rather than from anything the Work
// side stores about Chat.
//
// It renders **nothing at all** when the agent is not in a turn. An empty
// "Rooms" heading on every agent page would be a permanent reminder that a
// feature exists, which is not the same thing as the feature being useful, and
// the whole point of the strip is that it appears exactly when something is
// happening.

import Link from "next/link";
import { useAgentRooms } from "./bridge-data";

export function AgentRooms({ agentId }: { agentId: string }) {
  const { rooms, subscription } = useAgentRooms(agentId);
  return (
    <>
      {subscription}
      {rooms.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          Answering in{" "}
          {rooms.map((room, index) => (
            <span key={room.channelId}>
              {index > 0 ? ", " : ""}
              <Link
                href={`/chat/c/${room.channelId}`}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                #{room.channelName}
              </Link>
            </span>
          ))}
        </p>
      )}
    </>
  );
}
