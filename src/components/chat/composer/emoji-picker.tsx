"use client";

// The one emoji picker.
//
// One, deliberately: the composer opens it, and so will the reaction bar and
// anything else that ever needs an emoji. Each site owns its own trigger and
// popover — those legitimately differ — but the grid, the search and the
// custom-emoji wiring are here, because in the client this is ported from they
// were not, and custom emoji quietly went missing from the pickers that forgot
// them.
//
// The selection contract is the load-bearing part: `onSelect` is handed a
// *string*, never an object. A standard emoji is its glyph, a custom emoji is
// `:shortcode:`, and every consumer stores or sends that string unchanged.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  searchCustomEmoji,
  searchEmoji,
  selectionToken,
  type CustomEmoji,
} from "./emoji-data";

export function EmojiPicker({
  customEmoji = [],
  onSelect,
  autoFocus = true,
  className,
}: {
  customEmoji?: CustomEmoji[];
  /** Receives the glyph, or `:shortcode:` for a custom emoji. */
  onSelect: (token: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => searchEmoji(query), [query]);
  const custom = useMemo(
    () => searchCustomEmoji(query, customEmoji),
    [query, customEmoji],
  );
  const empty = groups.length === 0 && custom.length === 0;

  return (
    <div
      data-emoji-picker=""
      className={cn(
        "w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl bg-popover shadow-lg",
        className,
      )}
    >
      <div className="p-2">
        <input
          type="search"
          value={query}
          autoFocus={autoFocus}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
          // Off on all four, as the ported picker does: an emoji search is not
          // prose, and a browser capitalising or "correcting" `:shipit:` into
          // something else is a search that returns nothing for no visible
          // reason.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="soft-field h-8 w-full px-2.5 text-sm outline-none"
        />
      </div>

      <div className="chat-scroll max-h-64 px-2 pb-2">
        {empty ? (
          <p className="chat-quiet px-1 py-6 text-center text-xs">
            No emoji matches “{query}”.
          </p>
        ) : null}

        {/* Custom first: a community's own emoji are the ones that are hard to
            find anywhere else, and they are the reason this palette is not
            just a Unicode table. */}
        {custom.length > 0 ? (
          <Section label="Custom">
            {custom.map((row) => (
              <button
                key={row.shortcode}
                type="button"
                title={`:${row.shortcode}:`}
                aria-label={`:${row.shortcode}:`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(selectionToken(row))}
                className="tap-target flex size-8 items-center justify-center rounded-lg text-lg hover:bg-[var(--chat-hover)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={row.url} alt="" className="size-5 object-contain" />
              </button>
            ))}
          </Section>
        ) : null}

        {groups.map((group) => (
          <Section key={group.id} label={group.label}>
            {group.emoji.map((row) => (
              <button
                key={row.native}
                type="button"
                title={row.name}
                aria-label={row.name}
                // Mouse-down is swallowed so the composer keeps focus and the
                // caret stays where the emoji is about to land.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(selectionToken(row))}
                className="tap-target flex size-8 items-center justify-center rounded-lg text-lg leading-none hover:bg-[var(--chat-hover)]"
              >
                {row.native}
              </button>
            ))}
          </Section>
        ))}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pb-1">
      <p className="chat-quiet px-1 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider">
        {label}
      </p>
      <div className="flex flex-wrap gap-0.5">{children}</div>
    </div>
  );
}
