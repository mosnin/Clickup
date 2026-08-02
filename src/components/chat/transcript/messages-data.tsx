"use client";

// Where the transcript gets its events, and what it does when it cannot.
//
// Two shapes are copied deliberately from `shell/channel-data.tsx`, because the
// problem is the same one:
//
//  1. **References are built by hand** with `makeFunctionReference` rather than
//     read off `api.buzz.messages`. The generated `api` object is a checked-in
//     stub that only knows the modules present when it was last generated, so
//     `api.buzz.*` does not typecheck until somebody runs `npx convex dev`.
//     Naming the function and its argument/return types here is the same
//     contract, expressed in the one file that has to know it.
//  2. **A query against a function that is not deployed does not return an
//     error — it throws, during render.** So every subscription sits inside a
//     boundary and its failure becomes a sentence in the room rather than a
//     white screen. "The messages are not loading" is a state this application
//     will be in again (an outage, a suspended workspace, a half-finished
//     deploy); it should read as that.
//
// What it does NOT do is invent a message. A transcript that shows plausible
// history is worse than an empty one in exactly the way a fake screenshot is
// worse than a red placeholder: it is believed.
//
// Paging is one subscription per page rather than one subscription over a
// growing window. Convex pushes a query's whole result on any change, so a
// single query holding 300 events re-sends 300 events when one arrives; a page
// per cursor means the newest window is the only one that churns and the older
// pages sit still. It also means every page stays *live* — an edit to a message
// four pages back still lands.

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { TimelineActor, TimelineEvent } from "@/lib/buzz/timeline";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { PAGE_SIZE } from "./row-model";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

/**
 * A window of RAW events, newest-first, plus the cursor for the one before it.
 *
 * `actors` is optional and read defensively: resolving a pubkey to a display
 * name is the server's job (it has the memberships and the agent rows) and it
 * belongs on the window that carries the events, but a deployment that does not
 * send it must still draw a transcript. Without it the projector falls back to
 * a truncated pubkey — ugly and true, which is the right failure.
 */
export type MessageWindow = {
  events: TimelineEvent[];
  nextCursor?: string;
  actors?: TimelineActor[];
};

/** `api.buzz.messages.list` — one window of a channel's log. */
export const listMessages = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; cursor?: string; limit?: number },
  MessageWindow
>("buzz/messages:list");

/** `api.buzz.messages.thread` — one root and everything under it. */
export const threadMessages = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; rootId: string },
  MessageWindow
>("buzz/messages:thread");

export const reactToMessage = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; targetId: string; emoji: string; emojiUrl?: string },
  null
>("buzz/messages:react");

export const unreactToMessage = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; targetId: string; emoji: string },
  null
>("buzz/messages:unreact");

// `body`, not `content`: `buzz/messages:edit` declares `body`, and a reference
// naming the wrong argument does not fail at build time — it fails at the moment
// somebody presses Save, with an argument-validation error and the edited text
// nowhere. Named against the server rather than against the projected message,
// which is where `content` came from.
export const editMessage = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; targetId: string; body: string },
  null
>("buzz/messages:edit");

/**
 * The same edit, for a message that has attachments.
 *
 * A separate door because it takes one more argument, and it exists because an
 * edit *replaces* a message's media tags (`timeline.applyEditTagOverlay`) — so
 * `buzz/messages:edit` on a message with a picture is not a narrower edit, it is
 * an edit that silently deletes the picture. `keepUrls` names the attachments
 * that survive, and the server checks every one of them against what the message
 * already carries.
 */
export const editMessageWithMedia = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    channelId: string;
    targetId: string;
    body: string;
    keepUrls: string[];
  },
  null
>("buzz/media:edit");

/**
 * `buzz/messages:post`, for the one write the transcript does itself.
 *
 * A frame-anchored video comment is an ordinary thread reply (04-huddle-media
 * §2.10) written from the review panel rather than from the room's composer, so
 * the transcript needs the same door the composer uses. Not a second post path:
 * literally the same function.
 */
export const sendMessage = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; body: string; parentId?: string },
  { eventId: string }
>("buzz/messages:post");

export const removeMessage = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; targetId: string },
  null
>("buzz/messages:remove");

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

export type MessageFeed = {
  /** `undefined` while the first page is in flight — the skeleton state. */
  events: TimelineEvent[] | undefined;
  /** Pages that have actually resolved. `historyExhausted` needs this, not `!hasMore`. */
  resolvedPages: number;
  /** Display names the server resolved for the pubkeys in this feed. */
  windowActors: TimelineActor[] | undefined;
  hasMore: boolean;
  fetchingOlder: boolean;
  fetchOlder: () => void;
  error: string | null;
  /** Must be rendered by the caller — this is where the subscriptions live. */
  subscriptions: ReactNode;
};

/**
 * A channel's events, paged backwards.
 *
 * Returns its own subscriptions as a node instead of mounting them itself,
 * because a hook cannot render an error boundary and the boundary is the whole
 * reason this is not three lines of `useQuery`.
 */
export function useMessageFeed(
  scope: ChatScope | null,
  channelId: string,
): MessageFeed {
  // `""` is the first page (no cursor). Cursors are appended, never replaced,
  // so a page that has loaded stays loaded.
  const [cursors, setCursors] = useState<string[]>([""]);
  const [pages, setPages] = useState<Record<string, MessageWindow>>({});
  const [error, setError] = useState<string | null>(null);

  // A new room is a new log. Resetting on the key rather than on `channelId`
  // alone also covers a community switch, where the same channel name in two
  // communities is two different rooms.
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    // Render-phase reset: an effect would paint one frame of the previous
    // room's transcript under the new room's header, which reads as the wrong
    // messages rather than as a load.
    setCursors([""]);
    setPages({});
    setError(null);
  }

  const onPage = useCallback((cursor: string, window: MessageWindow) => {
    setPages((prev) =>
      prev[cursor] === window ? prev : { ...prev, [cursor]: window },
    );
  }, []);

  const resolved = cursors.filter((cursor) => pages[cursor] !== undefined);
  const tail = resolved.length > 0 ? pages[resolved[resolved.length - 1]] : undefined;
  const hasMore = Boolean(tail?.nextCursor);
  const fetchingOlder = resolved.length < cursors.length;

  const fetchOlder = useCallback(() => {
    setCursors((prev) => {
      const last = prev[prev.length - 1];
      const window = pages[last];
      // Only the *tail* page may extend the chain, and only once: without the
      // membership check a scroll that fires twice before the page lands
      // appends the same cursor twice and mounts two identical subscriptions.
      if (!window?.nextCursor || prev.includes(window.nextCursor)) return prev;
      return [...prev, window.nextCursor];
    });
  }, [pages]);

  const events = useMemo(() => {
    if (resolved.length === 0) return undefined;
    // Concatenated in cursor order and left unsorted: `projectTimeline` sorts
    // by (created_at, id) and dedupes by id, and doing it twice would be two
    // opinions about ordering. Overlap between windows is expected — a message
    // arriving mid-page shifts the boundary.
    return cursors.flatMap((cursor) => pages[cursor]?.events ?? []);
  }, [cursors, pages, resolved.length]);

  // Deduped by pubkey across pages, newest window last so a name changed
  // recently wins over the copy an older page was holding.
  const windowActors = useMemo(() => {
    const seen = new Map<string, TimelineActor>();
    for (const cursor of [...cursors].reverse()) {
      for (const actor of pages[cursor]?.actors ?? []) seen.set(actor.pubkey, actor);
    }
    return seen.size === 0 ? undefined : [...seen.values()];
  }, [cursors, pages]);

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      {cursors.map((cursor) => (
        <MessageWindowSubscription
          key={cursor}
          scope={scope}
          channelId={channelId}
          cursor={cursor}
          onResult={onPage}
          onOk={() => setError(null)}
        />
      ))}
    </MessagesBoundary>
  );

  return {
    events,
    windowActors,
    resolvedPages: resolved.length,
    hasMore,
    fetchingOlder,
    fetchOlder,
    error,
    subscriptions,
  };
}

/**
 * One page, rendering nothing.
 *
 * Split out so the boundary wraps only the throwing part: the room's header,
 * its composer and its details pane all keep working when the log cannot be
 * read, which is the difference between a degraded transcript and no room.
 */
function MessageWindowSubscription({
  scope,
  channelId,
  cursor,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  channelId: string;
  cursor: string;
  onResult: (cursor: string, window: MessageWindow) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    listMessages,
    scope
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          channelId,
          ...(cursor ? { cursor } : {}),
          limit: PAGE_SIZE,
        }
      : "skip",
  );
  const last = useRef<MessageWindow | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(cursor, result);
    onOk();
  }, [result, cursor, onResult, onOk]);
  return null;
}

/** One thread: the root and everything under it. Same boundary discipline. */
export function useThreadFeed(
  scope: ChatScope | null,
  channelId: string,
  rootId: string | null,
): {
  events: TimelineEvent[] | undefined;
  windowActors: TimelineActor[] | undefined;
  error: string | null;
  subscriptions: ReactNode;
} {
  const [window, setWindow] = useState<MessageWindow | undefined>();
  const [error, setError] = useState<string | null>(null);
  const key = `${channelId}:${rootId ?? "none"}`;
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setWindow(undefined);
    setError(null);
  }

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      <ThreadSubscription
        scope={scope}
        channelId={channelId}
        rootId={rootId}
        onResult={setWindow}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );

  // The names come back with the events, exactly as they do for the channel.
  // Without this the pane draws truncated pubkeys beside messages the room two
  // hundred pixels to the left is naming correctly — which reads as two
  // different products rather than as one missing join.
  return { events: window?.events, windowActors: window?.actors, error, subscriptions };
}

function ThreadSubscription({
  scope,
  channelId,
  rootId,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  channelId: string;
  rootId: string | null;
  onResult: (window: MessageWindow) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    threadMessages,
    scope && rootId
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          channelId,
          rootId,
        }
      : "skip",
  );
  const last = useRef<MessageWindow | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
    onOk();
  }, [result, onResult, onOk]);
  return null;
}

/**
 * Exported for the forum, which has the same problem and must not grow a second
 * answer to it: a query against a function the deployment does not have throws
 * during render, and the failure has to become a sentence on the surface rather
 * than a white screen. A class component cannot be a hook, so it is shared as
 * itself.
 */
export class MessagesBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The reason, not a generic apology: "Could not find public function
    // buzz/messages:list" is the sentence that tells whoever is looking
    // exactly what is missing.
    this.props.onError(
      error instanceof Error ? error.message : "Messages could not be loaded",
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type MessageActions = {
  react: (targetId: string, emoji: string, emojiUrl?: string) => Promise<void>;
  unreact: (targetId: string, emoji: string) => Promise<void>;
  /**
   * `keepUrls` is the message's surviving attachments, and its presence is what
   * chooses the door: absent means an ordinary text edit, present (even empty)
   * means "this message has media and here is what it keeps". Empty is
   * meaningful — it is how somebody removes the last picture.
   */
  edit: (targetId: string, content: string, keepUrls?: string[]) => Promise<void>;
  remove: (targetId: string) => Promise<void>;
  /** A reply, for the surfaces that write one without a composer. */
  reply: (parentId: string, body: string) => Promise<void>;
};

/**
 * The four writes, with the scope baked in.
 *
 * Bundled because every one of them needs the same three arguments and a call
 * site that assembles them by hand is a call site that can assemble them
 * wrongly — a react against the wrong channel is a reaction that lands
 * somewhere nobody is looking.
 */
export function useMessageActions(
  scope: ChatScope | null,
  channelId: string,
): MessageActions {
  const react = useMutation(reactToMessage);
  const unreact = useMutation(unreactToMessage);
  const edit = useMutation(editMessage);
  const editWithMedia = useMutation(editMessageWithMedia);
  const remove = useMutation(removeMessage);
  const send = useMutation(sendMessage);

  return useMemo(() => {
    const base = scope
      ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }
      : null;
    const refuse = async () => {
      throw new Error("No community selected");
    };
    if (!base) {
      return {
        react: refuse,
        unreact: refuse,
        edit: refuse,
        remove: refuse,
        reply: refuse,
      };
    }
    return {
      async react(targetId, emoji, emojiUrl) {
        await react({ ...base, targetId, emoji, ...(emojiUrl ? { emojiUrl } : {}) });
      },
      async unreact(targetId, emoji) {
        await unreact({ ...base, targetId, emoji });
      },
      async edit(targetId, content, keepUrls) {
        if (keepUrls === undefined) {
          await edit({ ...base, targetId, body: content });
          return;
        }
        await editWithMedia({ ...base, targetId, body: content, keepUrls });
      },
      async remove(targetId) {
        await remove({ ...base, targetId });
      },
      async reply(parentId, body) {
        // No `rootId`: the server derives the thread's root from the parent and
        // refuses a caller's guess that disagrees, so sending one would be a
        // second opinion about something only the log can answer.
        await send({ ...base, body, parentId });
      },
    } satisfies MessageActions;
  }, [scope, channelId, react, unreact, edit, editWithMedia, remove, send]);
}

// ---------------------------------------------------------------------------
// The reader's own identity
// ---------------------------------------------------------------------------

/** `api.buzz.identity.myPubkey` — who "mine" means. */
export const myPubkey = makeFunctionReference<
  "query",
  Record<string, never>,
  { pubkey: string | null }
>("buzz/identity:myPubkey");

const PubkeyContext = createContext<string | null>(null);

function PubkeySubscription({
  onResult,
}: {
  onResult: (pubkey: string | null) => void;
}) {
  const result = useQuery(myPubkey, {});
  useEffect(() => {
    if (result) onResult(result.pubkey);
  }, [result, onResult]);
  return null;
}

/**
 * The reader's pubkey as a provider — mounted once by the room.
 *
 * A provider rather than a hook per row: every message row asks "is this
 * mine", and forty rows each opening their own subscription to answer the same
 * question is forty subscriptions for one string.
 *
 * Null is a supported state, not an error: a person who has never posted in
 * Chat has no key yet (D3 — keys are minted in a Node action, and a mutation
 * cannot mint). The transcript draws fine without it; it just cannot say which
 * messages are yours, which is exactly what "no identity yet" means.
 */
export function MyPubkeyProvider({ children }: { children: ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  return (
    <PubkeyContext.Provider value={pubkey}>
      <MessagesBoundary onError={() => setPubkey(null)}>
        <PubkeySubscription onResult={setPubkey} />
      </MessagesBoundary>
      {children}
    </PubkeyContext.Provider>
  );
}

export function useSelfPubkey(): string | null {
  return useContext(PubkeyContext);
}
