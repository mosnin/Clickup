"use client";

// The way in — a control and the ⌘⇧F that opens it, in one component.
//
// Bundled deliberately. A dialog whose open state lives in whatever mounted it
// means every surface that wants search has to own a piece of state, a window
// listener and a decision about what `Escape` does — and the fourth one to do it
// will get the listener wrong. Mounting this is the whole integration.
//
// ## Why this is not ⌘K
//
// It was, and that was a collision rather than a choice. ⌘K in this product
// belongs to the command palette (`src/components/command-palette.tsx` binds it
// at the window, and the Chat sidebar's "Search everything" row dispatches the
// same event), so two window listeners were answering one keystroke and which
// one won came down to which mounted first. That is not a bug you can fix with
// `defaultPrevented`: both handlers are legitimate and both call it.
//
// The two surfaces are genuinely different questions and deserve different
// keys. ⌘K is the cross-dashboard quick-switch — a room, a task, a page, a
// board, by name. This is in-room search with a grammar (`from:`, `in:`,
// `after:`, `before:`), which is the thing the palette cannot express. So it
// takes **⌘⇧F / Ctrl+Shift+F** — the keystroke every editor uses for
// "search across everything", claimed by no browser, and one modifier away from
// the ⌘F somebody reaches for when they want to find what was said.
//
// One arbitration rule survives from §10, and it is about *not* stealing a
// keystroke somebody meant for something else: a surface that binds ⌘⇧F for
// itself calls `preventDefault()`, and this handler checks `defaultPrevented`
// and yields. Listener order cannot be relied on — this one is registered at
// mount and a room's is registered later — so yielding has to be explicit
// rather than positional.
//
// What is deliberately NOT checked is whether the focus is in a text field.
// ⌘K needed that (rule 99: ⌘K inside the composer is the link editor), but a
// chat application's focus lives in the composer almost all of the time, and a
// search shortcut that only works when you are not typing is a search shortcut
// that never works. ⌘⇧F types nothing, so there is nothing to defer to.
//
// The control has no magnifier. An icon must be an affordance, a control, a
// semantic indicator or an `.icon-tile`, and a magnifier beside the word
// "Search" is the same word twice — the second time in a form some readers
// cannot read.

import { useCallback, useEffect, useState } from "react";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";
import type { ResolvableAuthor } from "@/lib/buzz/search-query";
import { cn } from "@/lib/utils";
import { ChatSearchDialog } from "./search-dialog";

/** True for the platform's own "command" modifier, and only that one. */
function hasPrimaryModifier(event: KeyboardEvent): boolean {
  // Both, rather than sniffing the platform: a Mac keyboard on a Linux browser
  // and a PC keyboard on a Mac are both ordinary, and the wrong guess makes the
  // shortcut simply not work for whoever guessed wrong.
  return event.metaKey || event.ctrlKey;
}

/**
 * Open search from anywhere, with the dialog attached.
 *
 * `label` exists because this control appears in two places with two different
 * amounts of room — the top strip and (eventually) the empty home surface — and
 * a component that can only be one size gets copied rather than reused.
 */
export function ChatSearchLauncher({
  scope,
  channels,
  people,
  className,
  label = "Search",
}: {
  scope: ChatScope | null;
  channels: readonly ChatChannelSummary[];
  people?: readonly ResolvableAuthor[];
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // `event.key` for Shift+F is the capital "F", so the comparison has to be
    // case-insensitive or the shortcut is one that can never fire.
    if (event.key.toLowerCase() !== "f") return;
    if (!hasPrimaryModifier(event) || !event.shiftKey) return;
    event.preventDefault();
    setOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
        // Deliberately NOT `.soft-field`, which is the product's input surface
        // and is the wrong one here. A soft field is `--color-muted` (#f5f5f6)
        // and the Chat top strip is the page canvas (#ededf0) — eight units of
        // grey, which photographs as a label rather than a control. White is
        // what "raised" means in this system (`.segmented-on`, the content
        // card), so on a strip that is deliberately not white it is the one
        // fill that says "press me". A second call site on a white surface
        // will need its own answer; `className` is where it goes.
        className={cn(
          "tap-target flex h-8 min-w-0 items-center gap-2 rounded-full bg-background px-3 text-xs",
          "transition-colors hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground",
          className,
        )}
      >
        <span className="chat-quiet truncate">{label}</span>
        {/* A shortcut hint, not an icon: it says the same thing the listener
            does, in the one place somebody would look for it. */}
        <kbd className="chat-quiet ml-auto hidden shrink-0 font-sans text-micro tracking-wider sm:inline">
          ⌘⇧F
        </kbd>
      </button>

      <ChatSearchDialog
        scope={scope}
        channels={channels}
        people={people}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
