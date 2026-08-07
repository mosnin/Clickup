"use client";

// Global search — spec 01 §6.2, the ⌘K surface.
//
// One box, one list, and the list is what you can press Enter on. Everything
// difficult about search is somewhere else on purpose: the grammar is pure
// (`@/lib/buzz/search-query`), the composition and the row identity are pure
// (`./results`), the destination of a hit is pure (`./hit-destination`), and the
// execution and its gates are on the server. What is left here is state, focus
// and what a click does — which is the only part that has to be a component.
//
// Three things this surface refuses to do, each of which is the obvious move:
//
//   • **It never widens a search it could not narrow.** An operator that names a
//     room or a person nobody can resolve produces a sentence saying so, not a
//     list of everything (§6.2, rule 93). A widened search answers a question
//     that was not asked and looks exactly like an answer to the one that was.
//   • **It never invents a result.** Loading is a skeleton, empty is a sentence,
//     and a failed query is the reason it failed. A search that renders
//     plausible rows is the fake-screenshot failure with a keyboard attached.
//   • **It carries no decorative icons.** The house rule, and Buzz's own
//     magnifier and compass are exactly the two glyphs it names. The hint row
//     teaches the operators in words, which is also the only form of teaching
//     that survives somebody reading it with a screen reader.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";
import { moveSelection } from "@/lib/buzz/channel-search";
import type { ResolvableAuthor } from "@/lib/buzz/search-query";
import { useSearch } from "./search-data";
import {
  composeResults,
  excerpt,
  reconcileSelection,
  type SearchResultRow,
} from "./results";

const LIST_ID = "chat-search-results";

/**
 * The operator hints, in the pre-query state (§6.2's `SearchPromptPlaceholder`).
 *
 * Shown rather than hidden behind a help link because an operator grammar nobody
 * is told about is a grammar nobody uses — and because the four of them fit in
 * four lines, which is the whole argument for keeping the grammar this small.
 */
const HINTS: { operator: string; means: string }[] = [
  { operator: "from:", means: "a person — from:@ada" },
  { operator: "in:", means: "a room — in:#design" },
  { operator: "after:", means: "a date — after:2026-01-05" },
  { operator: "before:", means: "a date — before:2026-02-01" },
];

export function ChatSearchDialog({
  scope,
  channels,
  people = [],
  open,
  onOpenChange,
}: {
  scope: ChatScope | null;
  /** The reader's rooms, already access-filtered by `channels.list`. */
  channels: readonly ChatChannelSummary[];
  /** Who `from:` may resolve to. Empty is a supported state, not a bug. */
  people?: readonly ResolvableAuthor[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Everything clears when the dialog closes (§6.2). A search box that still
  // holds last week's query when it reopens is a box you have to clear before
  // you can use it, every single time.
  useEffect(() => {
    if (!open) {
      setRaw("");
      setSelectedId(null);
    }
  }, [open]);

  const directory = useMemo(
    () => ({
      channels: channels.map((channel) => ({
        channelId: channel.channelId,
        name: channel.name,
        displayName: channel.displayName,
      })),
      authors: people,
    }),
    [channels, people],
  );

  const { parsed, response, pending, unresolved, error, subscription } = useSearch(
    scope,
    raw,
    directory,
  );

  const rows = useMemo(
    () =>
      composeResults({
        parsed,
        channels,
        hits: response?.hits ?? [],
      }),
    [parsed, channels, response],
  );

  // Identity-based, not index-based: message hits arrive 300 ms after the
  // channel rows, so an index clamp would slide the highlight out from under
  // whoever is already holding the arrow key.
  const selection = reconcileSelection(selectedId, rows);
  const active = selection === null ? null : (rows[selection] ?? null);

  const openRow = useCallback(
    (row: SearchResultRow) => {
      onOpenChange(false);
      router.push(row.kind === "channel" ? row.href : row.destination.href);
    },
    [onOpenChange, router],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = moveSelection(selection, event.key === "ArrowDown" ? 1 : -1, rows.length);
      setSelectedId(next === null ? null : (rows[next]?.id ?? null));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = active ?? rows[0];
      if (row) openRow(row);
    }
  }

  const showPrompt =
    unresolved === null && parsed.text.length === 0 && parsed.operators.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* A light scrim with a blur, matching the channel browser: the room
            behind is still your workspace and should read as being behind the
            dialog rather than switched off. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/10 backdrop-blur-[5px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="panel fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl p-6 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-xl font-semibold tracking-tight">
              Search
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="tap-target inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>

          <input
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              // A new question has no selection: keeping the old index would
              // highlight whatever happens to land in that slot next.
              setSelectedId(null);
            }}
            onKeyDown={onKeyDown}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls={LIST_ID}
            aria-activedescendant={active ? `chat-search-${active.id}` : undefined}
            aria-label="Search messages and channels"
            placeholder="Search messages — try from:@ada or in:#design"
            className="soft-field h-11 w-full px-4 text-sm outline-none placeholder:text-muted-foreground"
          />

          <div
            id={LIST_ID}
            role="listbox"
            aria-label="Search results"
            className={cn(
              "chat-scroll -mx-1 flex flex-col gap-0.5 overflow-y-auto px-1",
              // Fixed once a question has been asked, and that is the load-
              // bearing half: results arrive in two waves (channels locally,
              // message hits 300 ms later), and a pane that resized between
              // them would move the highlight out from under whoever is
              // holding the arrow key — the same failure `reconcileSelection`
              // exists to prevent, in the other dimension.
              //
              // The pre-query state is exempt because it is not a list and
              // never becomes one: four hint lines under a 30rem pane is two
              // thirds of a dialog holding nothing, which is the FIRST thing
              // anybody sees. Growing once, on the first keystroke, is a
              // single transition rather than a per-keystroke wobble.
              showPrompt ? "h-auto" : "h-[min(60vh,30rem)]",
            )}
          >
            {error ? (
              <Note>{error}</Note>
            ) : unresolved !== null ? (
              <Note>
                Nothing here matches{" "}
                <span className="text-foreground">
                  {unresolved === "in" ? `in:${parsed.in}` : `from:${parsed.from}`}
                </span>
                , so the search was not run. Dropping a narrowing nobody can
                resolve would have searched everything instead — an answer to a
                question you did not ask.
              </Note>
            ) : showPrompt ? (
              <HintList />
            ) : rows.length === 0 && pending ? (
              <Skeleton />
            ) : rows.length === 0 ? (
              <Note>
                No results for{" "}
                <span className="text-foreground">{parsed.text || "that"}</span>.
              </Note>
            ) : (
              rows.map((row, index) => (
                <ResultRow
                  key={row.id}
                  row={row}
                  query={parsed.text}
                  selected={index === selection}
                  onSelect={() => setSelectedId(row.id)}
                  onOpen={() => openRow(row)}
                />
              ))
            )}

            {response?.truncated && rows.length > 0 ? (
              <p className="chat-quiet px-3 py-2 text-xs">
                More matches than fit here — add a word, a{" "}
                <span className="text-foreground">from:</span> or an{" "}
                <span className="text-foreground">in:</span> to narrow it.
              </p>
            ) : null}
          </div>

          {subscription}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResultRow({
  row,
  query,
  selected,
  onSelect,
  onOpen,
}: {
  row: SearchResultRow;
  /** The free text, so the excerpt can centre itself on what was searched for. */
  query: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      id={`chat-search-${row.id}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseMove={onSelect}
      onClick={onOpen}
      className={cn(
        "cursor-pointer rounded-xl px-3 py-2.5 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      {row.kind === "channel" ? (
        <>
          <p className="truncate text-compact font-semibold">
            {row.channel.kind === "dm" || row.channel.kind === "group_dm"
              ? row.channel.displayName || "Direct message"
              : `#${row.channel.name}`}
          </p>
          {row.channel.description ? (
            <p className="chat-quiet mt-0.5 truncate text-xs">{row.channel.description}</p>
          ) : null}
        </>
      ) : (
        <>
          <p className="chat-quiet flex items-baseline gap-2 text-xs">
            <span className="truncate text-foreground">{row.hit.authorName}</span>
            <span className="truncate">
              {row.hit.channelName ? `#${row.hit.channelName}` : "direct message"}
            </span>
            <span className="ml-auto shrink-0">{timeAgo(row.hit.createdAt * 1000)}</span>
          </p>
          <p className="mt-0.5 line-clamp-2 text-sm">
            {excerpt(row.hit.content, query)}
          </p>
        </>
      )}
    </div>
  );
}

/** The pre-query state: what the box can do, said in words. */
function HintList() {
  return (
    <div className="px-3 py-2">
      <p className="chat-quiet text-xs uppercase tracking-wider">Narrow a search</p>
      <dl className="mt-2 flex flex-col gap-1.5">
        {HINTS.map((hint) => (
          <div key={hint.operator} className="flex gap-3 text-sm">
            <dt className="w-16 shrink-0 font-medium">{hint.operator}</dt>
            <dd className="chat-quiet">{hint.means}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="chat-quiet px-3 py-6 text-sm">{children}</p>;
}
