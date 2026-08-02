"use client";

// The sidebar's resize edge.
//
// Three things make a drag feel like a drag rather than a jump:
//
//   • Pointer capture, so the gesture survives the pointer leaving the 12px
//     strip — which it does immediately, because the strip is narrower than
//     the distance a hand moves in one frame.
//   • A 3px dead zone before the drag starts, so a click on the edge is a
//     click and not a 2px resize nobody asked for.
//   • A magnetic detent at the default width (`magneticSidebarWidth`), which
//     is what lets someone wander off the default and find their way back
//     without measuring. Sticky, not blocking: past 28px it tracks the pointer
//     exactly.
//
// While the drag is live the *document* carries `data-chat-resizing`, because
// the cursor has to stay `col-resize` over the whole window — the pointer is
// no longer over the strip that set it, and a caret flickering mid-drag reads
// as the gesture having been dropped.
//
// It is also a real `separator` widget: focusable, arrow-keyed, and reporting
// its value. A resize you can only perform with a mouse is a layout choice
// somebody cannot make.

import { useEffect, useRef, useState } from "react";
import { useChatShell } from "./chat-shell";
import {
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  clampSidebarWidth,
  magneticSidebarWidth,
} from "./layout";

const DEAD_ZONE_PX = 3;

export function SidebarGrip() {
  const { sidebarWidth, setSidebarWidth, sidebarOpen, isNarrow } = useChatShell();
  const [resizing, setResizing] = useState(false);
  const start = useRef({ x: 0, width: 0, armed: false });

  useEffect(() => {
    const root = document.documentElement;
    if (resizing) root.dataset.chatResizing = "true";
    else delete root.dataset.chatResizing;
    return () => {
      delete root.dataset.chatResizing;
    };
  }, [resizing]);

  // Nothing to grab when the sidebar is a drawer or is collapsed to nothing.
  if (isNarrow || !sidebarOpen) return null;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarWidth}
      aria-valuemin={SIDEBAR_MIN_PX}
      aria-valuemax={SIDEBAR_MAX_PX}
      tabIndex={0}
      data-resizing={resizing ? "true" : "false"}
      className="chat-grip -right-1.5 hidden md:block"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: sidebarWidth, armed: false };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!resizing) return;
        const dx = event.clientX - start.current.x;
        if (!start.current.armed) {
          if (Math.abs(dx) < DEAD_ZONE_PX) return;
          start.current.armed = true;
        }
        setSidebarWidth(magneticSidebarWidth(start.current.width + dx));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setResizing(false);
      }}
      onPointerCancel={() => setResizing(false)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 8;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setSidebarWidth(clampSidebarWidth(sidebarWidth - step));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          setSidebarWidth(clampSidebarWidth(sidebarWidth + step));
        }
      }}
    />
  );
}
