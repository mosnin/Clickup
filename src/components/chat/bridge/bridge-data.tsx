"use client";

// Where the bridge surfaces get their data.
//
// The same two constraints every Chat data module states, reusing their
// boundary rather than declaring a third:
//
//  1. **References are built by hand** with `makeFunctionReference` rather than
//     read off `api.buzz.bridge`. The generated `api` object is a checked-in
//     stub that only knows the modules present when it was last generated, so
//     `api.buzz.*` does not typecheck until somebody runs `npx convex dev`.
//  2. **A query against a function that is not deployed throws during render**,
//     so every subscription sits inside `MessagesBoundary` and its failure
//     becomes a sentence rather than a blank shell.
//
// One thing this module deliberately does not have: a cache. Every hook here is
// a live Convex subscription, because the whole claim of C12 is that a task
// referenced in a room is *current*. A memoized answer would be the copy this
// phase exists to avoid, just held in a browser instead of a table.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type { TaskCard } from "@/lib/buzz/bridge";
import { MessagesBoundary } from "@/components/chat/transcript/messages-data";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

export type ResolvedRef = {
  kind: string;
  id: string;
  label: string;
  href: string | null;
  title: string | null;
  found: boolean;
};

export type RoomBindingWire = {
  bound: boolean;
  projectId: string | null;
  projectName: string | null;
  spaceName: string | null;
  boundAt: number | null;
  mayGovern: boolean;
};

export type WorkFeedRow = {
  eventId: string;
  type: string;
  actorName: string;
  actorType: "user" | "agent" | "system";
  entityType: string;
  entityId: string;
  entityTitle?: string;
  listId?: string;
  createdAt: number;
};

export type FleetMember = {
  agentId: string;
  name: string;
  status: "active" | "paused";
  workTaskId: string | null;
  workTaskTitle: string | null;
  workListId: string | null;
  statusText: string | null;
  lastSeenAt: number | null;
  rooms: { channelId: string; channelName: string }[];
  inThisRoom: boolean;
};

export type TargetList = {
  listId: string;
  name: string;
  context: string;
  preferred: boolean;
};

export type SwitcherCounts = {
  work: number;
  chat: number;
  workMentions: number;
  workUpdates: number;
  workApprovals: number;
  chatRoomMentions: number;
  chatUpdates: number;
};

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export const taskCardsQuery = makeFunctionReference<
  "query",
  { taskIds: string[] },
  TaskCard[]
>("buzz/bridge:taskCards");

export const resolveRefsQuery = makeFunctionReference<
  "query",
  ScopeArgs & { refs: { kind: string; id: string; label: string }[] },
  ResolvedRef[]
>("buzz/bridge:resolveRefs");

export const roomBindingQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  RoomBindingWire | null
>("buzz/bridge:roomBinding");

export const bindableProjectsQuery = makeFunctionReference<
  "query",
  ScopeArgs,
  { projectId: string; name: string; spaceName: string }[]
>("buzz/bridge:bindableProjects");

export const roomWorkFeedQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; limit?: number },
  WorkFeedRow[]
>("buzz/bridge:roomWorkFeed");

export const fleetQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId?: string },
  FleetMember[]
>("buzz/bridge:fleet");

export const agentRoomsQuery = makeFunctionReference<
  "query",
  { agentId: string },
  { channelId: string; channelName: string }[]
>("buzz/bridge:agentRooms");

export const targetListsQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId?: string },
  TargetList[]
>("buzz/bridge:targetLists");

export const switcherCountsQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  SwitcherCounts
>("buzz/bridge:switcherCounts");

export const unifiedSearchQuery = makeFunctionReference<
  "query",
  ScopeArgs & { text: string; limit?: number },
  {
    kind: "message" | "task" | "page" | "room";
    id: string;
    label: string;
    context: string;
    href: string;
  }[]
>("buzz/bridge:search");

export const bindProjectMutation = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; projectId: string },
  { projectId: string }
>("buzz/bridge:bindProject");

export const unbindProjectMutation = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string },
  null
>("buzz/bridge:unbindProject");

export const createTaskFromMessageMutation = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    channelId: string;
    eventId: string;
    listId: string;
    title?: string;
  },
  { taskId: string; listId: string }
>("buzz/bridge:createTaskFromMessage");

export function useBindProject() {
  return useMutation(bindProjectMutation);
}
export function useUnbindProject() {
  return useMutation(unbindProjectMutation);
}
export function useCreateTaskFromMessage() {
  return useMutation(createTaskFromMessageMutation);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * A guarded subscription.
 *
 * The boundary is a *sibling* of whatever it protects rather than a wrapper
 * around it — the same shape `useChannelMessages` uses — so a bridge query
 * against a backend that has not been deployed yet degrades the strip and
 * leaves the room standing. Returned as a node the caller renders wherever it
 * likes, which is what keeps the failure invisible in layout terms.
 */
function useGuarded<Args, Result>(
  reference: Parameters<typeof useQuery>[0],
  args: Args | "skip",
  render: (value: Result | undefined) => void,
): { subscription: ReactNode; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const subscription = (
    <MessagesBoundary onError={setError}>
      <Subscription
        reference={reference}
        args={args}
        onResult={render}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );
  return { subscription, error };
}

function Subscription({
  reference,
  args,
  onResult,
  onOk,
}: {
  reference: Parameters<typeof useQuery>[0];
  args: unknown;
  onResult: (value: never) => void;
  onOk: () => void;
}) {
  // The hand-built references above are typed at their declarations; this
  // generic plumbing cannot see through them, so the args are widened here and
  // narrowed again by each hook's own signature.
  const result = useQuery(reference, args as never);
  // A ref rather than a dependency array over the callbacks: the callers build
  // fresh closures every render, so keying the effect on them would re-run it
  // per render and write state in a loop.
  const last = useRef<unknown>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onOk();
    onResult(result as never);
  }, [result, onOk, onResult]);
  return null;
}

/**
 * The live state of the tasks a screenful of messages points at.
 *
 * One subscription for the whole transcript. Passing the id list in rather than
 * per chip is what makes "stays live" cost one query instead of forty — and
 * what makes the ids the transcript's business rather than each row's.
 */
export function useTaskCards(taskIds: readonly string[]): {
  cards: Map<string, TaskCard>;
  subscription: ReactNode;
} {
  const [rows, setRows] = useState<TaskCard[]>([]);
  const key = taskIds.join(",");
  const args = useMemo(
    () => (taskIds.length === 0 ? ("skip" as const) : { taskIds: [...taskIds] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const { subscription } = useGuarded<
    { taskIds: string[] } | "skip",
    TaskCard[]
  >(taskCardsQuery, args, (value) => {
    if (value) setRows(value);
  });
  const cards = useMemo(() => {
    const map = new Map<string, TaskCard>();
    for (const card of rows) map.set(card.taskId, card);
    return map;
  }, [rows]);
  return { cards, subscription };
}

/**
 * The non-task references on screen, resolved by whichever side owns each one.
 *
 * `resolved` tells a caller the resolver has answered at least once. Both
 * states draw identically (the author's label, quiet and unlinked) but they are
 * different facts, and collapsing them is how "slow" and "refused" become
 * indistinguishable to whoever debugs this next.
 */
export function useResolvedRefs(
  scope: ChatScope | null,
  refs: readonly { kind: string; id: string; label: string }[],
): {
  refs: Map<string, ResolvedRef>;
  resolved: boolean;
  subscription: ReactNode;
} {
  const [rows, setRows] = useState<ResolvedRef[] | null>(null);
  const key = refs.map((r) => `${r.kind}:${r.id}`).join(",");
  const args = useMemo(
    () =>
      scope && refs.length > 0
        ? {
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            refs: refs.map((r) => ({ ...r })),
          }
        : ("skip" as const),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, scope?.scopeType, scope?.scopeId],
  );
  const { subscription } = useGuarded<
    (ScopeArgs & { refs: { kind: string; id: string; label: string }[] }) | "skip",
    ResolvedRef[]
  >(resolveRefsQuery, args, (value) => {
    if (value) setRows(value);
  });
  const map = useMemo(() => {
    const out = new Map<string, ResolvedRef>();
    for (const row of rows ?? []) out.set(`${row.kind}:${row.id}`, row);
    return out;
  }, [rows]);
  return { refs: map, resolved: rows !== null, subscription };
}

export function useRoomBinding(
  scope: ChatScope | null,
  channelId: string,
): { binding: RoomBindingWire | null | undefined; subscription: ReactNode } {
  const [binding, setBinding] = useState<RoomBindingWire | null | undefined>(
    undefined,
  );
  const { subscription } = useGuarded<
    (ScopeArgs & { channelId: string }) | "skip",
    RoomBindingWire | null
  >(
    roomBindingQuery,
    scope
      ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }
      : "skip",
    (value) => {
      if (value !== undefined) setBinding(value);
    },
  );
  return { binding, subscription };
}

export function useRoomWorkFeed(
  scope: ChatScope | null,
  channelId: string,
): { rows: WorkFeedRow[]; subscription: ReactNode } {
  const [rows, setRows] = useState<WorkFeedRow[]>([]);
  const { subscription } = useGuarded<
    (ScopeArgs & { channelId: string }) | "skip",
    WorkFeedRow[]
  >(
    roomWorkFeedQuery,
    scope
      ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }
      : "skip",
    (value) => {
      if (value) setRows(value);
    },
  );
  return { rows, subscription };
}

export function useFleet(
  scope: ChatScope | null,
  channelId?: string,
): { fleet: FleetMember[]; subscription: ReactNode } {
  const [fleet, setFleet] = useState<FleetMember[]>([]);
  const { subscription } = useGuarded<
    (ScopeArgs & { channelId?: string }) | "skip",
    FleetMember[]
  >(
    fleetQuery,
    scope
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          ...(channelId ? { channelId } : {}),
        }
      : "skip",
    (value) => {
      if (value) setFleet(value);
    },
  );
  return { fleet, subscription };
}

export function useTargetLists(
  scope: ChatScope | null,
  channelId: string,
): { lists: TargetList[]; subscription: ReactNode } {
  const [lists, setLists] = useState<TargetList[]>([]);
  const { subscription } = useGuarded<
    (ScopeArgs & { channelId: string }) | "skip",
    TargetList[]
  >(
    targetListsQuery,
    scope
      ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }
      : "skip",
    (value) => {
      if (value) setLists(value);
    },
  );
  return { lists, subscription };
}

export function useBindableProjects(scope: ChatScope | null): {
  projects: { projectId: string; name: string; spaceName: string }[];
  subscription: ReactNode;
} {
  const [projects, setProjects] = useState<
    { projectId: string; name: string; spaceName: string }[]
  >([]);
  const { subscription } = useGuarded<
    ScopeArgs | "skip",
    { projectId: string; name: string; spaceName: string }[]
  >(
    bindableProjectsQuery,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
    (value) => {
      if (value) setProjects(value);
    },
  );
  return { projects, subscription };
}

/**
 * How much is waiting on the other side.
 *
 * Mounted by the mode switcher, which lives in **both** sidebars — so this hook
 * runs in the Work shell as well as the Chat one. That is why it is guarded the
 * same way: the Work dashboard must not white-screen because a Chat function
 * has not been deployed to this environment.
 */
export function useSwitcherCounts(): {
  counts: SwitcherCounts | null;
  subscription: ReactNode;
} {
  const [counts, setCounts] = useState<SwitcherCounts | null>(null);
  const { subscription } = useGuarded<Record<string, never>, SwitcherCounts>(
    switcherCountsQuery,
    {},
    (value) => {
      if (value) setCounts(value);
    },
  );
  return { counts, subscription };
}

export function useAgentRooms(agentId: string | null): {
  rooms: { channelId: string; channelName: string }[];
  subscription: ReactNode;
} {
  const [rooms, setRooms] = useState<
    { channelId: string; channelName: string }[]
  >([]);
  const { subscription } = useGuarded<
    { agentId: string } | "skip",
    { channelId: string; channelName: string }[]
  >(agentRoomsQuery, agentId ? { agentId } : "skip", (value) => {
    if (value) setRooms(value);
  });
  return { rooms, subscription };
}
