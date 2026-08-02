"use client";

// The hover toolbar — spec 01 §3.1.
//
// Left to right: up to four quick reactions (desktop only), a divider, React,
// Reply, More. The whole bar returns `null` when none of the three is
// available, because an empty pill floating over a row is furniture.
//
// Two rules that look like styling and are not:
//
//   • **Hover reveals it; FOCUS also reveals it.** The spec says "always
//     visible below `sm`", which is right about the problem (a touch device has
//     no hover) and wrong about the fix on our layout — the gallery shot at
//     390px was seven floating toolbars sitting on top of the words they belong
//     to, because the bar overlaps the row above and phone rows are short.
//     Focus is the touch equivalent of hover: the message row is focusable, so
//     tapping one reveals its bar and tapping elsewhere puts it away, and the
//     same rule gives keyboard users an affordance they otherwise had none of.
//     Quick reactions stay desktop-only regardless — four glyphs plus three
//     buttons on a 390px row is a toolbar wider than the message it acts on.
//   • **It stays open while a menu is.** Hover-revealed chrome that vanishes
//     when the pointer travels to the menu it opened is the most common way to
//     make a menu unusable, and it is invisible in any test that clicks
//     programmatically.
//
// The more-menu's ORDER is the spec's, and every item is conditional on its
// handler being supplied — so the slots nothing has a handler for yet (mark
// read/unread, follow thread, remind me later) are absent rather than
// disabled. A disabled item is a promise; an absent one is honest, and the
// numbering below keeps the order auditable when they arrive.

import { useRef, useState } from "react";
import { CornerUpLeft, EllipsisVertical, SmilePlus } from "lucide-react";
import type { ChatMessage } from "@/lib/buzz/message-types";
import { cn } from "@/lib/utils";
import { MenuItem, MenuSeparator, Popover } from "./popover";
import { QUICK_REACTIONS, REACTION_TRAY } from "./reaction-algebra";

export type ActionBarProps = {
  message: ChatMessage;
  /** Edit and delete. Huddle rows are immutable regardless of authorship. */
  canManage: boolean;
  /** Copy message / copy link — both need a delivered event. */
  canCopy: boolean;
  canReact: boolean;
  canReply: boolean;
  /**
   * C12: turn what was said into something somebody does, without leaving the
   * room. Optional like every other slot here — absent rather than disabled
   * where there is no handler, because a disabled item is a promise.
   */
  onMakeTask?: () => void;
  /**
   * C7 slot 8 — report this message to the community's moderators. Optional
   * like every other slot here: absent where there is no scope to file against,
   * because a disabled item is a promise.
   */
  onReport?: () => void;
  /**
   * "Why didn't I get notified about this?" — the single most common support
   * question a chat product generates, asked where it is asked. Slot 8b, beside
   * Report, because both are "something about this message reached me wrongly".
   */
  onExplainNotification?: () => void;
  /** Whether the answer is currently open under the message, so the item toggles. */
  notifyExplained?: boolean;
  onToggleReaction: (emoji: string, remove: boolean) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyMessage: () => void;
  onCopyLink: () => void;
};

export function MessageActionBar({
  message,
  canManage,
  canCopy,
  canReact,
  canReply,
  onMakeTask,
  onReport,
  onExplainNotification,
  notifyExplained = false,
  onToggleReaction,
  onReply,
  onEdit,
  onDelete,
  onCopyMessage,
  onCopyLink,
}: ActionBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const trayAnchor = useRef<HTMLButtonElement | null>(null);

  const hasMore =
    canManage ||
    canCopy ||
    onMakeTask !== undefined ||
    onReport !== undefined ||
    onExplainNotification !== undefined;
  if (!canReact && !canReply && !hasMore) return null;

  const reacted = (emoji: string) =>
    message.reactions.some((r) => r.emoji === emoji && r.mine);

  return (
    <div
      // `data-open` keeps the bar up while either popover is; the CSS below
      // reads it, so travelling to the menu never closes the thing that opened
      // it.
      data-open={menuOpen || trayOpen ? "true" : "false"}
      className={cn(
        "absolute -top-3 right-3 z-20 flex items-center gap-0.5 rounded-lg bg-background p-0.5",
        "shadow-md ring-1 ring-[var(--chat-hairline)]",
        // Hidden until the row is hovered, focused (which is what a tap does —
        // the row is focusable for exactly this) or holding a popover open.
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
        "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
        "data-[open=true]:pointer-events-auto data-[open=true]:opacity-100",
      )}
    >
      {canReact ? (
        <>
          <div className="hidden sm:flex sm:items-center sm:gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                title={`React with ${emoji}`}
                aria-label={`React with ${emoji}`}
                aria-pressed={reacted(emoji)}
                onClick={() => onToggleReaction(emoji, reacted(emoji))}
                className="chat-icon-button tap-target text-base leading-none"
              >
                <span aria-hidden>{emoji}</span>
              </button>
            ))}
          </div>
          <div
            aria-hidden
            className="mx-0.5 hidden h-4 w-px bg-[var(--chat-hairline)] sm:block"
          />
          <button
            ref={trayAnchor}
            type="button"
            title="React"
            aria-label="React"
            aria-haspopup="menu"
            aria-expanded={trayOpen}
            onClick={() => setTrayOpen((open) => !open)}
            className="chat-icon-button tap-target"
          >
            <SmilePlus aria-hidden className="size-4" />
          </button>
        </>
      ) : null}

      {canReply ? (
        <button
          type="button"
          title="Reply in thread"
          aria-label="Reply in thread"
          onClick={onReply}
          className="chat-icon-button tap-target"
        >
          <CornerUpLeft aria-hidden className="size-4" />
        </button>
      ) : null}

      {hasMore ? (
        <button
          ref={menuAnchor}
          type="button"
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="chat-icon-button tap-target"
        >
          <EllipsisVertical aria-hidden className="size-4" />
        </button>
      ) : null}

      <Popover
        open={trayOpen}
        onClose={() => setTrayOpen(false)}
        anchorRef={trayAnchor}
        label="Choose a reaction"
        className="max-w-[16rem]"
      >
        <div className="grid grid-cols-6 gap-0.5 p-0.5">
          {REACTION_TRAY.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-menu-item=""
              role="menuitem"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                setTrayOpen(false);
                onToggleReaction(emoji, reacted(emoji));
              }}
              className="flex size-8 items-center justify-center rounded-lg text-base hover:bg-[var(--chat-hover)] focus-visible:bg-[var(--chat-hover)] focus-visible:outline-none"
            >
              <span aria-hidden>{emoji}</span>
            </button>
          ))}
        </div>
      </Popover>

      <Popover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuAnchor}
        label="Message actions"
      >
        {/* 1 */}
        {canManage ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onEdit();
            }}
          >
            Edit message
          </MenuItem>
        ) : null}
        {/* 2 Mark read / Mark unread — arrives with read state (C5) */}
        {/* 3 Follow thread / Unfollow thread — arrives with read state (C5) */}
        {/* 4 */}
        {canCopy ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onCopyMessage();
            }}
          >
            Copy message
          </MenuItem>
        ) : null}
        {/* 5 Remind me later — arrives with reminders (C7) */}
        {/* 5b — the bridge. Sits with the other "do something with this
            message" verbs rather than in a toolbar of its own. */}
        {onMakeTask ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onMakeTask();
            }}
          >
            Make a task…
          </MenuItem>
        ) : null}
        {/* 6 */}
        {canCopy ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onCopyLink();
            }}
          >
            Copy link
          </MenuItem>
        ) : null}
        {/* 7 */}
        {canManage && canCopy ? <MenuSeparator /> : null}
        {/* 8 */}
        {onReport ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onReport();
            }}
          >
            Report message
          </MenuItem>
        ) : null}
        {/* 8b — the notification explainer. It sits with Report because both
            are "this message reached me wrongly", and because the answer it
            gives is the server re-running the same decision the delivery path
            ran rather than a narration of it. */}
        {onExplainNotification ? (
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onExplainNotification();
            }}
          >
            {notifyExplained ? "Hide why this notified me" : "Why this notified me"}
          </MenuItem>
        ) : null}
        {/* 9 */}
        {canManage ? (
          <MenuItem
            destructive
            onSelect={() => {
              setMenuOpen(false);
              onDelete();
            }}
          >
            Delete message
          </MenuItem>
        ) : null}
      </Popover>
    </div>
  );
}
