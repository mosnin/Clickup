"use client";

import type { ReactNode } from "react";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import type { ComponentStyle } from "@/lib/component-style";
import {
  cornerCss,
  fillClass,
  frameClass,
  padCss,
} from "@/components/appearance/style-gallery";
import { cn } from "@/lib/utils";

// The surface a panel is drawn on, wherever that panel came from.
//
// This is the fix for the oldest complaint about this product: "the customize
// popup doesn't actually let you customize anything." The studio was not
// broken and neither was the style model — every layer resolved, every pick
// saved. The problem was where the picks could land.
//
// `dashboard/panel.tsx` — the renderer for an AUTHORED panel — read the
// resolved style and drew itself with it. Every built-in block on Home wrote
// its own `bento h-full rounded-2xl bg-card` and read nothing. So on the one
// screen everybody opens, all six panels were hardcoded cards: you could press
// Customise, click "Today's tasks", watch the sheet correctly title itself
// "Style Today's tasks", choose a card, and see precisely nothing happen. The
// feature was real and unreachable, which from the outside is the same thing as
// absent — and worse, because it advertises itself.
//
// So the four properties that make a surface are in one component, and both
// kinds of panel wear it. Adding a built-in block to a screen now means it is
// customisable by construction rather than by remembering.
//
// `pad` is the one thing a caller decides. A panel whose rows run edge to edge
// — a divided list, a table with a header band — draws its own gutters inside
// its rows, and the style's padding would inset the dividers off the card's
// edge. Those pass `pad={false}` and keep everything else.

export function StyledSurface({
  panelId,
  resolved,
  pad = true,
  className,
  children,
  ...rest
}: {
  /**
   * What the reader's per-panel override is stored under. Must be the same id
   * the screen passes to `customizable()`, or the sheet edits one thing and
   * the screen draws another.
   */
  panelId: string | null;
  /**
   * An already-resolved style, for a caller that needs it anyway.
   *
   * `Panel` resolves one to decide what to DRAW (which palette, which bar
   * shape, whether the title is hidden) and would otherwise open a second
   * subscription here for the same answer. It also resolves with the
   * definition's own layer underneath, which this component has no way to know
   * about — so the caller that has the better answer passes it.
   */
  resolved?: ComponentStyle;
  /** False for a block that owns its own gutters. */
  pad?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // `resolved` short-circuits, but the hook still has to run — it is a hook.
  // Passing null means it resolves the screen-level answer and nobody reads it.
  const own = useComponentStyle(resolved ? null : panelId);
  const style = resolved ?? own.style;
  return (
    <div
      // The same attributes `Panel` puts on its own root, for the same reason:
      // rows, tables and chips are drawn by components at three depths, and
      // CSS answers "how is a row drawn" from here rather than through four
      // props that the fifth call site would forget.
      data-row-divider={style.rowDivider}
      data-row-marker={style.rowMarker}
      data-row-emphasis={style.rowEmphasis}
      data-table-header={style.tableHeader}
      data-chip-shape={style.chipShape}
      data-number-style={style.numberStyle}
      {...rest}
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden transition-shadow",
        frameClass(style),
        fillClass(style),
        className,
      )}
      style={{
        borderRadius: cornerCss(style),
        ...(pad ? { padding: padCss(style) } : null),
      }}
    >
      {children}
    </div>
  );
}
