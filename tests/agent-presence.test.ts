import { describe, expect, it } from "vitest";
import {
  AGENT_ONLINE_WINDOW_MS,
  AGENT_RECENT_WINDOW_MS,
  agentPresence,
} from "../src/lib/agent-presence";

const NOW = 1_800_000_000_000;

describe("agentPresence", () => {
  it("distinguishes protocol heartbeats from authenticated connections", () => {
    expect(
      agentPresence(
        {
          status: "active",
          lastSeenAt: NOW - 1_000,
          lastConnectedAt: NOW - 1_000,
        },
        NOW,
      ).state,
    ).toBe("online_connected");

    expect(
      agentPresence(
        {
          status: "active",
          lastSeenAt: NOW - 1_000,
          lastConnectedAt: NOW - 2_000,
          lastHeartbeatAt: NOW - 1_000,
        },
        NOW,
      ).state,
    ).toBe("online_heartbeating");
  });

  it("keeps legacy recent activity online during migration", () => {
    const presence = agentPresence(
      { status: "active", lastSeenAt: NOW - 1_000 },
      NOW,
    );
    expect(presence.state).toBe("online_connected");
    expect(presence.online).toBe(true);
  });

  it("ages presence through recent and offline states", () => {
    expect(
      agentPresence(
        {
          status: "active",
          lastSeenAt: NOW - AGENT_ONLINE_WINDOW_MS,
          lastConnectedAt: NOW - AGENT_ONLINE_WINDOW_MS,
        },
        NOW,
      ).state,
    ).toBe("recently_seen");

    expect(
      agentPresence(
        {
          status: "active",
          lastSeenAt: NOW - AGENT_RECENT_WINDOW_MS,
          lastConnectedAt: NOW - AGENT_RECENT_WINDOW_MS,
        },
        NOW,
      ).state,
    ).toBe("offline");
  });

  it("never treats paused or never-connected agents as online", () => {
    expect(
      agentPresence(
        { status: "paused", lastSeenAt: NOW - 1_000 },
        NOW,
      ).state,
    ).toBe("paused");
    expect(agentPresence({ status: "active" }, NOW).state).toBe(
      "never_connected",
    );
  });
});
