"use client";

// The channel browser (§1.3) — one dialog that is both "find a room" and
// "make one", because those are the same errand. You discover a room does not
// exist by looking for it, so the answer has to be where you looked.
//
// The whole design turns on one detail: the create row is pinned at the top of
// the results and is **virtual keyboard index 0**. Type a name that does not
// exist, press Enter, get the room — with no reach for the mouse and no second
// dialog. Channels shift down by one so keyboard order and visual order are the
// same list; the moment those disagree the arrow keys are guessing.
//
// The ranking, the visibility rule and that geometry all live in
// `src/lib/buzz/channel-search.ts`, which is pure and tested. This file is the
// surface: state, focus, and what a click does.
//
// A note on icons. The Buzz reference puts a magnifier in the search shell and
// a Compass in the empty state; the house rule says an icon must be an
// affordance, a control or a semantic indicator, and explicitly names "centred
// in an empty state" as the thing not to do. So the ornamental glyphs are gone
// and the ones that remain earn it: `#` is how a room is named, `+` sits on a
// button, and the back arrow is a control.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Plus, X } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@convex/_generated/api";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";
import {
  browseChannels,
  canonicalChannelName,
  createRowIsOffered,
  moveSelection,
  navGeometry,
  type BrowsableChannelKind,
  type ChannelBrowseTab,
  type ChannelSortMode,
} from "@/lib/buzz/channel-search";
import { ChannelRow } from "./channel-row";
import { createChannelError, toCreateChannelArgs } from "@/lib/buzz/create-channel";
import { useEnsureChatIdentity } from "@/components/chat/shell/ensure-chat-identity";
import { CreateChannelView, type CreateChannelInput } from "./create-channel-view";

const TABS: { tab: ChannelBrowseTab; label: string }[] = [
  { tab: "all", label: "All channels" },
  { tab: "joined", label: "Joined" },
  { tab: "archived", label: "Archived" },
];

const SORTS: { sort: ChannelSortMode; label: string }[] = [
  { sort: "alpha", label: "A–Z" },
  { sort: "recent", label: "Recent" },
  { sort: "members", label: "Members" },
];

const CREATE_ROW_ID = "channel-browser-create";
const LIST_ID = "channel-browser-results";

/**
 * The three backend functions this dialog speaks to, named and typed here.
 *
 * `convex/_generated/api.d.ts` is a hand-rolled stub checked in so a fresh
 * clone typechecks, and it predates `convex/buzz/*`; only `npx convex dev` may
 * rewrite it. The runtime `api` is `anyApi`, a path proxy, so
 * `api.buzz.channels.list` already resolves correctly — the *type* is the only
 * thing missing. Stating the contract here rather than casting to `any` means
 * a change on the backend still breaks this file, which is the point.
 *
 * These signatures are `convex/buzz/channels.ts`'s **argument validators**,
 * transcribed. That is not pedantry: the version this file shipped with was a
 * description of the dialog's own form instead — it sent `kind`, which the
 * mutation has no argument for, `visibility: "public"`, which is not in its
 * union, and a `join` with no scope — so every write from this dialog would
 * have been refused by the validator the moment it was mounted. A hand-written
 * signature that describes the caller rather than the callee is a type that
 * cannot fail, which is the one thing a type is for.
 */
const buzzChannels = (
  api as unknown as {
    buzz: {
      channels: {
        list: FunctionReference<
          "query",
          "public",
          { scopeType: ChatScope["scopeType"]; scopeId: string },
          ChatChannelSummary[]
        >;
        create: FunctionReference<
          "mutation",
          "public",
          {
            scopeType: ChatScope["scopeType"];
            scopeId: string;
            name: string;
            description?: string;
            // The store speaks Buzz's `open`/`private` and NIP-29's
            // `stream`/`forum`. The form's `public`/`channel` are translated
            // by `toCreateChannelArgs` — the only helper allowed to do that.
            visibility?: "open" | "private" | "public";
            channelType?: "stream" | "forum";
            ttlSeconds?: number;
            templateId?: string;
          },
          { channelId: string; name: string }
        >;
        join: FunctionReference<
          "mutation",
          "public",
          { scopeType: ChatScope["scopeType"]; scopeId: string; channelId: string },
          { joined: boolean }
        >;
      };
    };
  }
).buzz.channels;

export function ChannelBrowserDialog({
  scope,
  open,
  onOpenChange,
  onSelectChannel,
  kindFilter,
  canCreate = true,
}: {
  scope: ChatScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a channel id once the browser is done with it. */
  onSelectChannel: (channelId: string) => void;
  /** Restricts the browser to one kind. Swaps every noun in the dialog. */
  kindFilter?: BrowsableChannelKind;
  canCreate?: boolean;
}) {
  const { toast } = useToast();
  const noun = kindFilter === "forum" ? "forum" : "channel";

  const [mode, setMode] = useState<"browse" | "create">("browse");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<ChannelBrowseTab>("all");
  const [sort, setSort] = useState<ChannelSortMode>("alpha");
  const [selection, setSelection] = useState<number | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // The rooms this person may see. `undefined` means the query has not
  // answered yet — a state we render as loading rather than as "no channels",
  // because the two look identical and only one of them is true.
  const listed = useQuery(
    buzzChannels.list,
    open ? { scopeType: scope.scopeType, scopeId: scope.scopeId } : "skip",
  );
  const loading = listed === undefined;
  const channels = useMemo(() => listed ?? [], [listed]);

  const createChannel = useMutation(buzzChannels.create);
  const joinChannel = useMutation(buzzChannels.join);
  const ensureIdentity = useEnsureChatIdentity();

  // The filter runs on the deferred query so a long list does not make typing
  // feel heavy; the create row reads the LIVE query, because its label quotes
  // what you just typed and a create row a frame behind would offer to create
  // a name you had already finished changing.
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(
    () => browseChannels(channels, { query: deferredQuery, tab, sort, kindFilter }),
    [channels, deferredQuery, tab, sort, kindFilter],
  );
  const createRowShown = createRowIsOffered({ channels, query, kindFilter, canCreate });
  const { offset, count } = navGeometry({ createRowShown, resultCount: results.length });

  // Everything resets when the dialog closes, so reopening never resumes
  // somebody else's half-finished search.
  useEffect(() => {
    if (open) return;
    setMode("browse");
    setQuery("");
    setTab("all");
    setSort("alpha");
    setSelection(null);
    setJoiningId(null);
    setPrefill("");
  }, [open]);

  // Selection is an index into a list that changes underneath it. Clamp rather
  // than clear: a list that shrinks by one should not throw away where you were.
  useEffect(() => {
    setSelection((current) =>
      current === null ? null : Math.min(current, Math.max(count - 1, 0)),
    );
  }, [count]);

  const enterCreateMode = useCallback((name: string) => {
    setPrefill(canonicalChannelName(name));
    setMode("create");
  }, []);

  const openChannel = useCallback(
    (channelId: string) => {
      onOpenChange(false);
      onSelectChannel(channelId);
    },
    [onOpenChange, onSelectChannel],
  );

  async function join(channel: ChatChannelSummary) {
    setJoiningId(channel.channelId);
    try {
      await joinChannel({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        channelId: channel.channelId,
      });
      // Close first, then navigate: the room you just joined is where you
      // wanted to be, and leaving the dialog up over it reads as a failure.
      openChannel(channel.channelId);
    } catch (err) {
      // Failure leaves the dialog open on purpose — you are still browsing,
      // and the reason (full room, revoked invite) belongs next to the list.
      setJoiningId(null);
      toast(err instanceof Error ? err.message : `Could not join that ${noun}.`, {
        kind: "error",
      });
    }
  }

  async function create(input: CreateChannelInput) {
    setCreating(true);
    try {
      // Mint before the write so a first-visit create cannot dead-end on
      // "open Chat first" — they are already standing in Chat. Idempotent
      // after the shell bootstrap has run.
      await ensureIdentity();
      const created = await createChannel(toCreateChannelArgs(scope, input));
      // The server's canonical name, not the one typed: `#Release Notes` is
      // stored as `release-notes`, and a toast quoting the input would name a
      // room that does not exist.
      toast(`#${created?.name ?? input.name} created`);
      if (created?.channelId) openChannel(created.channelId);
      else onOpenChange(false);
    } catch (err) {
      throw new Error(createChannelError(err, noun));
    } finally {
      setCreating(false);
    }
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelection((s) => moveSelection(s, 1, count));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelection((s) => moveSelection(s, -1, count));
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    // The create row wins when it is selected, and also when nothing matched —
    // "no results" and "make it" are the same thought, and making somebody
    // arrow down to a row that is the only row is a keystroke for nothing.
    if (createRowShown && (selection === 0 || results.length === 0)) {
      enterCreateMode(query);
      return;
    }
    const index = selection === null ? 0 : selection - offset;
    const channel = results[index];
    if (channel) openChannel(channel.channelId);
  }

  const activeId =
    selection === null
      ? undefined
      : selection === 0 && createRowShown
        ? CREATE_ROW_ID
        : results[selection - offset]
          ? `channel-browser-${results[selection - offset]!.channelId}`
          : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* A light scrim with a blur rather than a heavy dim: the room behind
            is still your workspace and should read as being *behind* the
            dialog, not switched off. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/10 backdrop-blur-[5px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="panel fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl p-6 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-xl font-semibold tracking-tight">
              {kindFilter === "forum" ? "Add a forum" : "Browse channels"}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="tap-target inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>

          {mode === "create" ? (
            <CreateChannelView
              initialName={prefill}
              kind={kindFilter ?? "channel"}
              noun={noun}
              creating={creating}
              onBack={() => {
                setMode("browse");
                // Back to the search you were already doing, focus included.
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
              onCreate={create}
            />
          ) : (
            <>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelection(null);
                }}
                onKeyDown={onSearchKeyDown}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded
                aria-controls={LIST_ID}
                aria-activedescendant={activeId}
                aria-label={`Search ${noun}s`}
                placeholder={
                  canCreate
                    ? `Search or create a ${noun}`
                    : `Search ${noun}s by name or description`
                }
                className="soft-field h-11 w-full px-4 text-sm outline-none placeholder:text-muted-foreground"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="segmented" role="tablist" aria-label={`${noun} filter`}>
                  {TABS.map((t) => (
                    <button
                      key={t.tab}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.tab}
                      onClick={() => {
                        setTab(t.tab);
                        setSelection(null);
                      }}
                      className={cn(tab === t.tab && "segmented-on")}
                    >
                      {t.tab === "all" && kindFilter === "forum" ? "All forums" : t.label}
                    </button>
                  ))}
                </div>
                <div className="segmented" role="radiogroup" aria-label="Sort">
                  {SORTS.map((s) => (
                    <button
                      key={s.sort}
                      type="button"
                      role="radio"
                      aria-checked={sort === s.sort}
                      onClick={() => {
                        setSort(s.sort);
                        setSelection(null);
                      }}
                      className={cn(sort === s.sort && "segmented-on")}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                id={LIST_ID}
                role="listbox"
                aria-label={`${noun} results`}
                className="-mx-1 flex h-[min(60vh,30rem)] flex-col gap-0.5 overflow-y-auto px-1"
              >
                {createRowShown ? (
                  <div
                    id={CREATE_ROW_ID}
                    role="option"
                    aria-selected={selection === 0}
                    tabIndex={-1}
                    onClick={() => enterCreateMode(query)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
                      selection === 0 ? "bg-muted" : "bg-muted/40 hover:bg-muted",
                    )}
                  >
                    <span className="icon-tile size-8 rounded-lg bg-background">
                      <Plus aria-hidden className="size-4" />
                    </span>
                    <span className="truncate text-compact font-semibold">
                      {canonicalChannelName(query).length > 0
                        ? `Create ${noun} “#${canonicalChannelName(query)}”`
                        : `Create a new ${noun}`}
                    </span>
                  </div>
                ) : null}

                {loading ? (
                  <div className="flex flex-col gap-1.5 px-3 py-2.5" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-10 animate-pulse rounded-xl bg-muted" />
                    ))}
                  </div>
                ) : results.length === 0 ? (
                  <BrowseEmptyState
                    query={query}
                    tab={tab}
                    noun={noun}
                    canCreate={canCreate}
                  />
                ) : (
                  results.map((channel, i) => (
                    <ChannelRow
                      key={channel.channelId}
                      id={`channel-browser-${channel.channelId}`}
                      channel={channel}
                      selected={selection === i + offset}
                      joining={joiningId === channel.channelId}
                      onSelect={() => openChannel(channel.channelId)}
                      onJoin={() => void join(channel)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The four empty states (§1.3). Four rather than one because they are four
 * different situations and only one of them is a dead end: "nothing matched"
 * has an action, "you have not joined anything" is a statement about you, and
 * "nothing archived" is a statement about the room list. One generic "No
 * results" sentence would be wrong three times out of four.
 */
function BrowseEmptyState({
  query,
  tab,
  noun,
  canCreate,
}: {
  query: string;
  tab: ChannelBrowseTab;
  noun: string;
  canCreate: boolean;
}) {
  const searching = canonicalChannelName(query).length > 0;
  const plural = `${noun}s`;

  const { title, description } = searching
    ? {
        title: `No ${plural} match your search`,
        description: canCreate
          ? `No ${noun} by that name yet — create it to get started.`
          : "Try a different name or keyword.",
      }
    : tab === "archived"
      ? {
          title: `No archived ${plural}`,
          description: `Archived ${plural} you have joined will appear here.`,
        }
      : tab === "joined"
        ? {
            title: `No joined ${plural}`,
            description: `${plural[0]!.toUpperCase()}${plural.slice(1)} you join will appear here.`,
          }
        : {
            title: `No ${plural} to browse`,
            description: `All open ${plural} are available in the sidebar. Create a new ${noun} to get started.`,
          };

  return (
    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-mini text-muted-foreground">{description}</p>
    </div>
  );
}
