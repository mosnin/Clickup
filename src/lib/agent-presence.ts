export const AGENT_ONLINE_WINDOW_MS = 5 * 60 * 1000;
export const AGENT_RECENT_WINDOW_MS = 30 * 60 * 1000;

export type AgentPresenceInput = {
  status: "active" | "paused";
  lastSeenAt?: number;
  lastConnectedAt?: number;
  lastHeartbeatAt?: number;
};

export type AgentPresenceState =
  | "paused"
  | "online_heartbeating"
  | "online_connected"
  | "recently_seen"
  | "offline"
  | "never_connected";

export type AgentPresence = {
  state: AgentPresenceState;
  online: boolean;
  label: string;
  detail: string;
};

function isFresh(timestamp: number | undefined, now: number): boolean {
  return (
    timestamp !== undefined && now - timestamp < AGENT_ONLINE_WINDOW_MS
  );
}

export function agentPresence(
  agent: AgentPresenceInput,
  now: number,
): AgentPresence {
  if (agent.status === "paused") {
    return {
      state: "paused",
      online: false,
      label: "Paused",
      detail: "Presence is disabled until this agent is resumed.",
    };
  }

  const lastActivityAt = agent.lastSeenAt;
  if (lastActivityAt === undefined) {
    return {
      state: "never_connected",
      online: false,
      label: "Never connected",
      detail: "No authenticated MCP request has reached Operate.",
    };
  }

  if (isFresh(agent.lastHeartbeatAt, now)) {
    return {
      state: "online_heartbeating",
      online: true,
      label: "Online",
      detail: "Explicit heartbeat received within the last 5 minutes.",
    };
  }

  if (
    isFresh(agent.lastConnectedAt, now) ||
    // Backward compatibility for agents observed before source timestamps
    // were introduced.
    (agent.lastConnectedAt === undefined &&
      agent.lastHeartbeatAt === undefined &&
      isFresh(lastActivityAt, now))
  ) {
    return {
      state: "online_connected",
      online: true,
      label: "Online",
      detail: "MCP authenticated; waiting for an explicit heartbeat.",
    };
  }

  const age = now - lastActivityAt;
  if (age < AGENT_RECENT_WINDOW_MS) {
    return {
      state: "recently_seen",
      online: false,
      label: "Recently seen",
      detail: "No connection or heartbeat in the last 5 minutes.",
    };
  }

  return {
    state: "offline",
    online: false,
    label: "Offline",
    detail: "No connection or heartbeat in the last 30 minutes.",
  };
}
