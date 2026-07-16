"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useToast } from "@/components/toast";

// Watches agent presence app-wide (mounted once in the dashboard layout)
// and celebrates the moment an agent heartbeats for the very first time —
// the payoff for wiring a runtime to its key. Subsequent reconnects stay
// quiet; this is only about first contact.
export function AgentOnlineWatcher() {
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const { toast } = useToast();
  // agentId -> had it ever connected as of the previous query result.
  const prevRef = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!agents) return;
    const all = [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)];
    const prev = prevRef.current;
    if (prev) {
      for (const a of all) {
        if (a.lastSeenAt !== undefined && prev.get(a._id) === false) {
          toast(`${a.emoji ?? "🤖"} ${a.name} is online, first connection!`, {
            duration: 6000,
          });
        }
      }
    }
    prevRef.current = new Map(all.map((a) => [a._id, a.lastSeenAt !== undefined]));
  }, [agents, toast]);

  return null;
}
