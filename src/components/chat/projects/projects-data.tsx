"use client";

// Where the project surfaces get their events.
//
// The same two constraints `transcript/messages-data.tsx` and
// `forum/forum-data.tsx` both explain, reusing their boundary rather than
// declaring a third:
//
//  1. **References are built by hand** with `makeFunctionReference` rather than
//     read off `api.buzz.projects`. The generated `api` object is a checked-in
//     stub that only knows the modules present when it was last generated, so
//     `api.buzz.*` does not typecheck until somebody runs `npx convex dev`.
//  2. **A query against a function that is not deployed throws during render**,
//     so every subscription sits inside `MessagesBoundary` and its failure
//     becomes a sentence on the page rather than a blank shell.
//
// There is no paging here and that is deliberate rather than missing. A forge
// event is rare — a branch room accumulates a handful of patches and a handful
// of verdicts, not a transcript — so the server hands back a capped window and
// the client folds it whole. Adding a cursor would be machinery for a case that
// does not arise, and the cap is honest about what happens when it does.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { createChannelError } from "@/lib/buzz/create-channel";
import { useEnsureChatIdentity } from "@/components/chat/shell/ensure-chat-identity";
import type { TimelineActor } from "@/lib/buzz/timeline";
import { MessagesBoundary } from "@/components/chat/transcript/messages-data";
import type { ForgeEvent, Project } from "@/lib/buzz/project";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

export type ProjectActor = { pubkey: string; label: string; isAgent: boolean };

export type BranchRoomWire = {
  channelId: string;
  name: string;
  displayName: string;
  visibility: "public" | "private";
  joined: boolean;
  archivedAt?: number;
  memberCount: number;
  lastActivityAt: number;
  events: ForgeEvent[];
};

export type ProjectListPage = {
  projects: { project: Project; branchRooms: number; lastActivityAt: number }[];
  groups: { slug: string; name: string; by: string; memberAddresses: string[] }[];
  actors: ProjectActor[];
};

export type ProjectDetailPage = {
  project: Project;
  refState: ForgeEvent | null;
  rooms: BranchRoomWire[];
  actors: ProjectActor[];
  canGovern: boolean;
};

export type RoomForgeWindow = {
  events: ForgeEvent[];
  actors: ProjectActor[];
  project: Project | null;
};

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** `api.buzz.projects.list`. */
export const projectsQuery = makeFunctionReference<"query", ScopeArgs, ProjectListPage>(
  "buzz/projects:list",
);

/** `api.buzz.projects.get`. */
export const projectQuery = makeFunctionReference<
  "query",
  ScopeArgs & { projectId: string },
  ProjectDetailPage | null
>("buzz/projects:get");

/** `api.buzz.projects.roomForge`. */
export const roomForgeQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  RoomForgeWindow
>("buzz/projects:roomForge");

export const announceProject = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    name: string;
    slug?: string;
    description?: string;
    cloneUrls?: string[];
    webUrl?: string;
  },
  { projectId: string; eventId: string }
>("buzz/projects:announce");

/**
 * `api.buzz.channels.create` — reused verbatim.
 *
 * Opening a branch room is create-then-bind, two calls, because room creation
 * is a mutation rather than an exported core and forking it would mean a second
 * copy of the five writes `channels.create` makes in one transaction. See
 * `buzz/projects:bindBranch` for the full argument and for what the split costs.
 */
export const createChannel = makeFunctionReference<
  "mutation",
  ScopeArgs & { name: string; description?: string; visibility?: "open" | "private" },
  { channelId: string; name: string }
>("buzz/channels:create");

export const bindBranch = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    channelId: string;
    repoAddress: string;
    branch: string;
    targetBranch?: string;
    title?: string;
    commit?: string;
  },
  { eventId: string }
>("buzz/projects:bindBranch");

export const postPatch = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; title: string; body: string; commit?: string },
  { eventId: string; createdAt: number }
>("buzz/projects:postPatch");

export const postReview = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    channelId: string;
    outcome: "approved" | "changes_requested";
    note?: string;
    commit?: string;
  },
  { eventId: string; createdAt: number }
>("buzz/projects:postReview");

export const postMerge = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; mergeCommit?: string; note?: string },
  { eventId: string; createdAt: number }
>("buzz/projects:postMerge");

export const setBranchState = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; outcome: "open" | "draft" | "closed"; note?: string },
  { eventId: string; createdAt: number }
>("buzz/projects:setBranchState");

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * A label for a pubkey, from whatever the server resolved.
 *
 * Falls back to nothing rather than to a truncated key, because every caller
 * here already has `truncatePubkey` through the timeline module and a second
 * fallback would produce two different renderings of the same unknown person.
 */
export function actorMap(actors: readonly ProjectActor[] | undefined): Map<string, TimelineActor> {
  return new Map((actors ?? []).map((actor) => [actor.pubkey, actor]));
}

export function useProjects(scope: ChatScope | null): {
  page: ProjectListPage | undefined;
  error: string | null;
  subscriptions: ReactNode;
} {
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<ProjectListPage | undefined>();
  const key = scope ? `${scope.scopeType}:${scope.scopeId}` : "none";

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      <Subscription
        reference={projectsQuery}
        args={scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : null}
        onResult={setPage}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );
  return { page, error, subscriptions };
}

export function useProject(
  scope: ChatScope | null,
  projectId: string,
): { page: ProjectDetailPage | null | undefined; error: string | null; subscriptions: ReactNode } {
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<ProjectDetailPage | null | undefined>();
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${projectId}` : "none";

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      <Subscription
        reference={projectQuery}
        args={
          scope
            ? { scopeType: scope.scopeType, scopeId: scope.scopeId, projectId }
            : null
        }
        onResult={setPage}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );
  return { page, error, subscriptions };
}

export function useRoomForge(
  scope: ChatScope | null,
  channelId: string,
): { forge: RoomForgeWindow | undefined; error: string | null; subscriptions: ReactNode } {
  const [error, setError] = useState<string | null>(null);
  // Named `forge` rather than `window`: a local called `window` shadows the
  // global one, and the next person to reach for `window.matchMedia` in this
  // file would get a query result instead.
  const [forge, setForge] = useState<RoomForgeWindow | undefined>();
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      <Subscription
        reference={roomForgeQuery}
        args={
          scope
            ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }
            : null
        }
        onResult={setForge}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );
  return { forge, error, subscriptions };
}

/**
 * One subscription, rendering nothing.
 *
 * Split out so the boundary wraps only the throw — a component that both
 * subscribes and draws would take its own output down with it when the query
 * refuses, and the refusal is the thing the reader most needs to see.
 */
function Subscription<Args extends Record<string, unknown>, Result>({
  reference,
  args,
  onResult,
  onOk,
}: {
  reference: FunctionReference<"query", "public", Args, Result>;
  args: Args | null;
  onResult: (result: Result) => void;
  onOk: () => void;
}) {
  // `OptionalRestArgsOrSkip` is a conditional over the reference's own argument
  // type, and TypeScript cannot resolve a conditional while `Args` is still a
  // type parameter — so the rest tuple is asserted once, here, rather than three
  // near-identical subscription components existing to avoid saying it.
  const result = useQuery(
    reference,
    ...([args ?? "skip"] as OptionalRestArgsOrSkip<
      FunctionReference<"query", "public", Args, Result>
    >),
  );
  const last = useRef<Result | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result as Result;
    onResult(result as Result);
    onOk();
  }, [result, onResult, onOk]);
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Open a branch room: create the channel, then bind it.
 *
 * Two calls, not one transaction, and the failure mode is named rather than
 * hidden — if the bind refuses, the room exists and is unbound, which is a room.
 * The caller is told exactly that, and binding again fixes it. The alternative
 * was a second room-creation path, and a second path is how a room ends up
 * without an owner membership.
 */
export function useOpenBranchRoom(
  scope: ChatScope | null,
): (input: {
  repoAddress: string;
  branch: string;
  targetBranch?: string;
  title?: string;
  visibility?: "open" | "private";
}) => Promise<{ channelId: string }> {
  const create = useMutation(createChannel);
  const bind = useMutation(bindBranch);
  const ensureIdentity = useEnsureChatIdentity();
  return useCallback(
    async (input) => {
      if (!scope) throw new Error("No community selected");
      const args = { scopeType: scope.scopeType, scopeId: scope.scopeId };
      await ensureIdentity();
      let room: { channelId: string; name: string };
      try {
        room = await create({
          ...args,
          name: input.branch,
          description: input.title ?? `Work on ${input.branch}`,
          ...(input.visibility ? { visibility: input.visibility } : {}),
        });
      } catch (error) {
        throw new Error(createChannelError(error));
      }
      try {
        await bind({
          ...args,
          channelId: room.channelId,
          repoAddress: input.repoAddress,
          branch: input.branch,
          ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
          ...(input.title ? { title: input.title } : {}),
        });
      } catch (error) {
        const reason =
          (error as { data?: string })?.data ??
          (error instanceof Error ? error.message : "the binding was refused");
        throw new Error(
          `#${room.name} was created but is not bound to ${input.branch} yet: ${reason}`,
        );
      }
      return { channelId: room.channelId };
    },
    [create, bind, scope, ensureIdentity],
  );
}
