"use client";

// The one popover the transcript opens: the more-menu, and the reaction tray.
//
// Portaled to `<body>` rather than positioned inside the row, and that is not a
// preference. The transcript is a scroller with `overflow-x: hidden` inside a
// surface with `overflow: hidden`; a menu absolutely positioned inside a
// message row is clipped by both, so the last item of a menu opened on the
// bottom row is simply not there. Every popover in this app that got this wrong
// was discovered by somebody who could not click "Delete".
//
// Two behaviours it owns so no call site has to re-derive them:
//
//   • **It flips.** Anchored below the trigger, unless there is not room, in
//     which case above. A menu that opens downward off the bottom of a viewport
//     is the same bug as one that is clipped, arrived at differently.
//   • **The keyboard works.** ↑/↓ move, Enter activates, Escape closes and
//     returns focus to the trigger. `stopPropagation` on Escape matters here:
//     the auxiliary pane and the shell both listen for it, and without this a
//     menu and the thread pane close together.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const GAP_PX = 6;
const MARGIN_PX = 8;

export function Popover({
  open,
  onClose,
  anchorRef,
  label,
  children,
  className,
  align = "end",
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** The accessible name of the menu itself, not of its trigger. */
  label: string;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const below = a.bottom + GAP_PX;
    const flip = below + p.height > window.innerHeight - MARGIN_PX;
    const top = flip ? Math.max(MARGIN_PX, a.top - GAP_PX - p.height) : below;
    const raw = align === "end" ? a.right - p.width : a.left;
    const left = Math.min(
      Math.max(MARGIN_PX, raw),
      Math.max(MARGIN_PX, window.innerWidth - p.width - MARGIN_PX),
    );
    setPos({ top, left });
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    // The transcript scrolls under the menu; `capture` so a scroll on any
    // ancestor repositions it rather than leaving it floating over nothing.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // The innermost open surface owns Escape. Without this the thread pane
      // and the shell drawer both close behind the menu.
      event.stopPropagation();
      event.preventDefault();
      onClose();
      anchorRef.current?.focus();
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onClose, anchorRef]);

  // Focus the first item on open, so the menu is usable without a pointer.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "[data-menu-item]:not([disabled])",
    );
    first?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            "[data-menu-item]:not([disabled])",
          ) ?? [],
        );
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Placed off-screen for one frame while it is measured; rendering it at
        // 0,0 first makes the menu visibly jump into position.
        visibility: pos ? "visible" : "hidden",
      }}
      className={cn(
        "fixed z-50 min-w-48 rounded-xl bg-popover p-1 text-sm shadow-lg",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A row in the more-menu. */
export function MenuItem({
  onSelect,
  children,
  destructive,
  disabled,
}: {
  onSelect: () => void;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item=""
      disabled={disabled}
      // The menu closes before the action runs. A mutation that re-renders the
      // row out from under an open menu leaves the menu anchored to a node that
      // no longer exists.
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
        "hover:bg-[var(--chat-hover)] focus-visible:bg-[var(--chat-hover)] focus-visible:outline-none",
        destructive && "text-destructive",
        disabled && "opacity-50",
      )}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-[var(--chat-hairline)]" />;
}
