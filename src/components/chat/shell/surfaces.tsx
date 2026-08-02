"use client";

// The two surfaces a screen is made of: the room, and the pane beside it.
//
// `ContentSurface` is the sheet the application is read on — inset a hair from
// the chrome on the two edges that face it, with a hairline on exactly those
// two edges and nothing on the two that face the window. A full border draws a
// line against the outside of the window, where there is nothing to separate
// from.
//
// `AuxPane` is the slot: threads, profiles, room details, whatever a later
// phase docks beside the transcript. Its geometry is the interesting part —
// it is a column while two columns fit and a floating sheet when they do not,
// and it is the *pane* that decides, not the page that opened it. Every
// surface that docks here inherits one answer to "what happens on a phone",
// which is the only way that answer stays consistent.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatShell } from "./chat-shell";
import {
  AUX_DEFAULT_PX,
  AUX_WIDTH_KEY,
  clampAuxWidth,
  SIDEBAR_DEFAULT_PX,
} from "./layout";

export function ContentSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-chat-surface=""
      className={cn(
        "chat-surface mb-2 ml-px mr-2 mt-px flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The auxiliary pane.
 *
 * Below 600px it stops being a column: two panes at 300px each is the first
 * width where both are legible, so under it the pane floats over the room with
 * a backdrop rather than squeezing it. The resize grip disappears in that mode
 * — there is nothing to resize against.
 *
 * Double-click on the grip resets the width. That gesture lives here and not
 * on the sidebar's grip on purpose: the sidebar has a magnetic detent that
 * already walks you home, and a pane you have dragged to 700px to read a
 * thread is one you want back at 380 in one gesture.
 */
export function AuxPane({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { auxIsOverlay } = useChatShell();
  const [width, setWidth] = useState(AUX_DEFAULT_PX);
  const [resizing, setResizing] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(AUX_WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        setWidth(clampAuxWidth(stored, window.innerWidth));
      }
    } catch {
      /* private mode */
    }
  }, []);

  function commit(px: number) {
    const next = clampAuxWidth(px, window.innerWidth);
    setWidth(next);
    try {
      localStorage.setItem(AUX_WIDTH_KEY, String(next));
    } catch {
      /* private mode */
    }
  }

  // Escape closes this pane and stops there, so the shell's drawer handler
  // does not also fire. The innermost open surface owns the key.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {auxIsOverlay ? (
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-foreground/20"
        />
      ) : null}
      <aside
        data-chat-aux=""
        data-mode={auxIsOverlay ? "overlay" : "docked"}
        style={{
          width: auxIsOverlay ? undefined : width,
          // A hard ceiling at paint, whatever the stored width says: a pane
          // wider than the window minus a sidebar leaves the room unreadable,
          // and the stored value was measured on a different screen.
          maxWidth: auxIsOverlay
            ? undefined
            : `calc(100% - ${SIDEBAR_DEFAULT_PX}px)`,
        }}
        className={cn(
          "chat-surface relative z-40 flex min-h-0 flex-col overflow-hidden",
          auxIsOverlay
            ? "fixed bottom-2 right-2 top-11 w-[min(24rem,calc(100vw-2rem))] shadow-lg"
            : "mb-2 mr-2 mt-px shrink-0",
        )}
      >
        {!auxIsOverlay ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${title} panel`}
            tabIndex={0}
            data-resizing={resizing ? "true" : "false"}
            className="chat-grip -left-1.5 z-10"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              start.current = { x: event.clientX, width };
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (!resizing) return;
              commit(start.current.width - (event.clientX - start.current.x));
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              setResizing(false);
            }}
            onPointerCancel={() => setResizing(false)}
            onDoubleClick={() => commit(AUX_DEFAULT_PX)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 40 : 8;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                commit(width + step);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                commit(width - step);
              }
            }}
          />
        ) : null}

        {/* 52px title row — the same height on every pane that ever docks
            here, so the room's header and the pane's header line up. */}
        <header className="flex h-13 shrink-0 items-center gap-2 px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="chat-icon-button tap-target"
          >
            <X aria-hidden className="size-4" />
          </button>
        </header>
        <div className="chat-scroll min-h-0 flex-1 px-4 pb-4">{children}</div>
      </aside>
    </>
  );
}
