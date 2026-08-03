"use client";

// Tabs — the one tab strip.
//
// Before this, a dozen surfaces each hand-rolled their own: a `<nav>` of
// `<button>`s with `aria-pressed`, or `aria-current="page"`, or nothing at
// all. They looked similar and behaved differently, and none of them
// implemented the keyboard contract a tab strip is supposed to have — every
// one was a plain tab stop per button, so a ten-filter strip cost ten presses
// to walk past.
//
// Two things this owns that the buttons could not:
//
//   • **Arrow keys move between tabs, Tab moves past them.** That is the whole
//     point of the roving tabindex: a tab strip is ONE stop in the page's tab
//     order, and the arrow keys pick within it. Home/End jump to the ends.
//     Disabled tabs are skipped rather than focused-and-refused.
//
//   • **`activation` is a real choice, not a detail.** Automatic selects as
//     focus lands, which is right when switching is free. Manual moves focus
//     and waits for Enter or Space, which is right when switching costs
//     something — a refetch, a scroll position, a form. Arrowing through five
//     tabs should not fire five queries.
//
// `renderPanel` is optional on purpose. The strip's content usually lives far
// down the page (a grid under a sticky header), not inside the strip, and
// `aria-controls` pointing at an element that does not exist is worse than no
// `aria-controls` at all — so it is emitted only when there is a panel to
// point at, whether rendered here or named through `panelId`.

import {
  useCallback,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabItem = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Semantic glyph for the tab's subject. Never decorative. */
  icon?: LucideIcon;
  /** A count beside the label — "12" on All, "3" on At risk. */
  count?: number;
};

export type TabsProps = {
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /**
   * `underline` sits flush on a container's bottom border — the page-level
   * strip. `segmented` is the raised-pill track from the design system, for
   * switching a mode inside a panel.
   */
  variant?: "underline" | "segmented";
  /** Selection follows focus, or waits for Enter/Space. Defaults to manual. */
  activation?: "automatic" | "manual";
  /** Names the strip for screen readers. Required — a tablist without one is
   *  announced as an unlabelled group of tabs. */
  label: string;
  className?: string;
  panelClassName?: string;
  /** Render the selected panel here. Omit when the content lives elsewhere. */
  renderPanel?: (value: string) => ReactNode;
  /** The id of an externally-rendered panel, so `aria-controls` still links. */
  panelId?: string;
};

export function Tabs({
  items,
  value,
  onValueChange,
  variant = "underline",
  activation = "manual",
  label,
  className,
  panelClassName,
  renderPanel,
  panelId,
}: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement | null>());

  const tabId = (v: string) => `${base}-tab-${v}`;
  const ownPanelId = renderPanel ? `${base}-panel` : panelId;

  const focus = useCallback((next: TabItem) => {
    refs.current.get(next.value)?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Only the tabs themselves are navigable, so a strip of five with two
      // disabled behaves like a strip of three rather than trapping on them.
      const usable = items.filter((i) => !i.disabled);
      if (usable.length === 0) return;

      // Navigation is relative to the FOCUSED tab, not the selected one. Under
      // manual activation those are routinely different — that is the entire
      // point of it — and anchoring to the selection means the second arrow
      // press recomputes from the same place as the first, so focus bounces
      // between the selected tab and its neighbour and can never reach the
      // third. Selection is only the fallback, for the first press when focus
      // has just arrived on the strip.
      const focusedValue =
        items.find((i) => refs.current.get(i.value) === document.activeElement)
          ?.value ?? value;
      const at = usable.findIndex((i) => i.value === focusedValue);
      // -1 means the anchor is a disabled tab (legitimate: a filter can become
      // unavailable while it is on). Start from the first so arrowing works.
      const from = at === -1 ? 0 : at;

      let next: TabItem | undefined;
      switch (event.key) {
        case "ArrowRight":
          next = usable[(from + 1) % usable.length];
          break;
        case "ArrowLeft":
          next = usable[(from - 1 + usable.length) % usable.length];
          break;
        case "Home":
          next = usable[0];
          break;
        case "End":
          next = usable[usable.length - 1];
          break;
        case "Enter":
        case " ":
          // Manual activation's other half. Without this the arrow keys move
          // focus to a tab that can never be chosen from the keyboard.
          if (activation === "manual") {
            event.preventDefault();
            const focused = items.find(
              (i) => refs.current.get(i.value) === document.activeElement,
            );
            if (focused && !focused.disabled) onValueChange(focused.value);
          }
          return;
        default:
          return;
      }

      if (!next) return;
      event.preventDefault();
      focus(next);
      if (activation === "automatic") onValueChange(next.value);
    },
    [activation, focus, items, onValueChange, value],
  );

  const isUnderline = variant === "underline";

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        className={cn(
          isUnderline
            ? // -mb-px pulls the strip onto the container's own bottom border
              // so the active tab's rule and that border are the same line —
              // this is what "flush" means. The negative inline margins let it
              // scroll edge to edge on a phone instead of clipping inside the
              // page gutter.
              "-mx-4 -mb-px flex items-center gap-1 overflow-x-auto overscroll-x-contain px-4 sm:-mx-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "segmented",
          className,
        )}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const selected = item.value === value;
          const Icon = item.icon;
          return (
            <button
              key={item.value}
              ref={(el) => {
                refs.current.set(item.value, el);
              }}
              type="button"
              role="tab"
              id={tabId(item.value)}
              aria-selected={selected}
              aria-controls={ownPanelId}
              disabled={item.disabled}
              // The roving tabindex. Exactly one tab is reachable with Tab;
              // the arrows do the rest.
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!item.disabled) onValueChange(item.value);
              }}
              className={cn(
                "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-sm transition-colors",
                "disabled:pointer-events-none disabled:opacity-40",
                isUnderline
                  ? cn(
                      "border-b-2 px-3 py-2",
                      selected
                        ? "border-foreground font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )
                  : selected
                    ? "segmented-on"
                    : undefined,
              )}
            >
              {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
              {item.label}
              {item.count !== undefined ? (
                <span
                  className={cn(
                    "tabular-nums",
                    selected ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {renderPanel ? (
        <div
          role="tabpanel"
          id={ownPanelId}
          aria-labelledby={tabId(value)}
          // Focusable so that Tab out of the strip lands in the content the
          // strip just changed, which is where somebody who pressed it is
          // looking.
          tabIndex={0}
          className={panelClassName}
        >
          {renderPanel(value)}
        </div>
      ) : null}
    </>
  );
}
