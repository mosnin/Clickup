"use client";

// Where the shell gets its rooms.
//
// The backend (`convex/buzz/channels.ts`) is being written beside this. Two
// consequences shape this file:
//
//  1. The references are built by hand with `makeFunctionReference` rather
//     than read off `api.buzz.channels`. The generated `api` type is a checked-
//     in stub that only knows the modules present when it was last generated,
//     so `api.buzz.*` does not typecheck until somebody runs `npx convex dev`.
//     Naming the function and its argument/return types here is the same
//     contract, expressed in the one file that has to know it, and it goes
//     back to `api.buzz.channels.list` the moment the stub is regenerated.
//
//  2. A query against a function that is not deployed yet does not return an
//     error — it throws, during render, and takes the whole shell down with
//     it. So the subscription is isolated behind a boundary and its failure
//     becomes a sentence in the sidebar. The room list being unavailable is a
//     state this application will be in again (an outage, a suspended
//     workspace); it should read as "the rooms are not loading", not as a
//     white screen.
//
// What it deliberately does NOT do is fall back to sample channels. A rail
// that shows rooms which do not exist is a rail nobody can trust once they
// have clicked one.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Component } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";

/** `api.buzz.channels.list` — the rail, the browser and the room header. */
export const listChannels = makeFunctionReference<
  "query",
  { scopeType: ChatScope["scopeType"]; scopeId: string },
  ChatChannelSummary[]
>("buzz/channels:list");

/** `api.buzz.channels.join` — create-by-name is join, as it is in Work. */
export const joinChannel = makeFunctionReference<
  "mutation",
  { scopeType: "user" | "workspace"; scopeId: string; channelId: string },
  null
>("buzz/channels:join");

/** `api.buzz.channels.leave`. */
// The scope is in these two argument types because the mutations require it.
//
// They said `{ channelId }` alone, and a hand-written reference that disagrees
// with its validator is refused at the moment somebody uses it — not at compile
// time, not in a test that asserts the caller's own shape. This is the third
// instance of that class in this build (an edit addressed with the wrong
// argument name, the channel browser's create and join, and these), which is why
// `scripts/chat-sweep.mjs` now checks every reference against its validator
// instead of waiting for a fourth.
export const leaveChannel = makeFunctionReference<
  "mutation",
  { scopeType: "user" | "workspace"; scopeId: string; channelId: string },
  null
>("buzz/channels:leave");

export type ChannelsState = {
  /** `undefined` while loading — the state that draws skeletons. */
  channels: ChatChannelSummary[] | undefined;
  /** A sentence to show instead of the list, or null. */
  error: string | null;
};

const ChannelsContext = createContext<ChannelsState>({
  channels: undefined,
  error: null,
});

export function useChannels(): ChannelsState {
  return useContext(ChannelsContext);
}

/** One room out of the loaded list, or undefined while loading / not found. */
export function useChannel(channelId: string | null): ChatChannelSummary | null {
  const { channels } = useChannels();
  if (!channelId || !channels) return null;
  return channels.find((c) => c.channelId === channelId) ?? null;
}

export function ChannelsProvider({
  scope,
  children,
}: {
  scope: ChatScope | null;
  children: ReactNode;
}) {
  const [channels, setChannels] = useState<ChatChannelSummary[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const value = useMemo(() => ({ channels, error }), [channels, error]);

  // Keyed on the community so switching one clears the previous community's
  // rooms and its error — a failed subscription that survives the switch
  // would report the new community as broken.
  const key = scope ? `${scope.scopeType}:${scope.scopeId}` : "none";

  return (
    <ChannelsContext.Provider value={value}>
      <ChannelsBoundary key={key} onError={setError}>
        <ChannelsSubscription
          scope={scope}
          onResult={setChannels}
          onOk={() => setError(null)}
        />
      </ChannelsBoundary>
      {children}
    </ChannelsContext.Provider>
  );
}

/**
 * The subscription itself, rendering nothing.
 *
 * Split out so the boundary wraps only the throwing part: everything else in
 * the shell keeps rendering when the rooms cannot be fetched, which is the
 * difference between a degraded sidebar and no application.
 */
function ChannelsSubscription({
  scope,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  onResult: (rows: ChatChannelSummary[] | undefined) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    listChannels,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
  );
  const last = useRef<ChatChannelSummary[] | undefined>(undefined);
  useEffect(() => {
    if (last.current === result) return;
    last.current = result;
    onResult(result);
    if (result !== undefined) onOk();
  }, [result, onResult, onOk]);
  return null;
}

class ChannelsBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The reason, not a generic apology: "Could not find public function
    // buzz/channels:list" is the sentence that tells whoever is looking
    // exactly what is missing.
    this.props.onError(
      error instanceof Error ? error.message : "Channels could not be loaded",
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
