"use client";

import { createRoot, type Root } from "react-dom/client";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The popup shared by the `/`, `@` and `[[` menus.
//
// One component and one keyboard contract for all three: ↑/↓ move, Enter
// picks, Esc closes. Three menus with three sets of key handling is how you
// end up with Enter selecting in one and inserting a newline in another.

export type MenuRow<T> = {
  key: string;
  label: string;
  hint?: string;
  meta?: string;
  icon?: LucideIcon;
  value: T;
};

export type MenuSection<T> = { heading?: string; rows: MenuRow<T>[] };

export function SuggestionMenu<T>({
  sections,
  activeKey,
  emptyLabel,
  onPick,
}: {
  sections: MenuSection<T>[];
  activeKey: string | null;
  emptyLabel: string;
  onPick: (value: T) => void;
}) {
  const isEmpty = sections.every((s) => s.rows.length === 0);
  return (
    <div className="w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
      {isEmpty ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="max-h-80 overflow-y-auto py-1.5">
          {sections.map((section, i) =>
            section.rows.length === 0 ? null : (
              <div key={section.heading ?? i}>
                {section.heading && (
                  <p className="px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                    {section.heading}
                  </p>
                )}
                {section.rows.map((row) => {
                  const Icon = row.icon;
                  const active = row.key === activeKey;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      // Mouse-down, not click: the editor still holds focus
                      // and a click would blur it before the command runs.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onPick(row.value);
                      }}
                      data-active={active ? "" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
                        active ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      {Icon && (
                        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {row.label}
                      </span>
                      {row.meta && (
                        <span className="flex-shrink-0 text-micro uppercase tracking-wider text-muted-foreground">
                          {row.meta}
                        </span>
                      )}
                      {row.hint && (
                        <span className="flex-shrink-0 font-mono text-tiny text-muted-foreground">
                          {row.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Mounts a suggestion popup near the caret and drives it from Tiptap's
 * suggestion lifecycle.
 *
 * `buildSections` runs on every keystroke with the current query; the
 * renderer owns the selection index and the keyboard, so each menu only has
 * to say what its rows are and what picking one does.
 */
export function createSuggestionRenderer<T>(config: {
  emptyLabel: string;
  buildSections: (query: string) => MenuSection<T>[];
}) {
  return () => {
    let host: HTMLDivElement | null = null;
    let root: Root | null = null;
    let sections: MenuSection<T>[] = [];
    let flat: MenuRow<T>[] = [];
    let index = 0;
    let command: ((value: T) => void) | null = null;
    // Escape dismisses the popup, but Tiptap's suggestion plugin keeps
    // matching until the caret leaves the token — so "closed" is our state
    // to hold, and it resets when the plugin exits.
    let dismissed = false;

    function draw() {
      if (!root || dismissed) return;
      root.render(
        <SuggestionMenu
          sections={sections}
          activeKey={flat[index]?.key ?? null}
          emptyLabel={config.emptyLabel}
          onPick={(value) => command?.(value)}
        />,
      );
    }

    function place(rect: DOMRect | null | undefined) {
      if (!host || !rect) return;
      // Flip above the caret when there isn't room below, so the menu is
      // never half off-screen at the bottom of a long page.
      const below = window.innerHeight - rect.bottom;
      const wantsAbove = below < 320;
      host.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
      host.style.top = wantsAbove ? "" : `${rect.bottom + 6}px`;
      host.style.bottom = wantsAbove
        ? `${window.innerHeight - rect.top + 6}px`
        : "";
    }

    function update(props: {
      query: string;
      command: (value: T) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) {
      sections = config.buildSections(props.query);
      flat = sections.flatMap((s) => s.rows);
      if (index >= flat.length) index = 0;
      command = props.command;
      if (dismissed) return;
      place(props.clientRect?.());
      draw();
    }

    return {
      onStart(props: {
        query: string;
        command: (value: T) => void;
        clientRect?: (() => DOMRect | null) | null;
      }) {
        host = document.createElement("div");
        host.dataset.suggestionMenu = "";
        host.style.position = "fixed";
        host.style.zIndex = "60";
        document.body.appendChild(host);
        root = createRoot(host);
        index = 0;
        dismissed = false;
        update(props);
      },
      onUpdate(props: {
        query: string;
        command: (value: T) => void;
        clientRect?: (() => DOMRect | null) | null;
      }) {
        update(props);
      },
      onKeyDown(props: { event: KeyboardEvent }) {
        const { key } = props.event;
        // Once dismissed, the keys belong to the document again — otherwise
        // Enter would still insert a block from an invisible menu.
        if (dismissed) return false;
        if (key === "ArrowDown") {
          index = flat.length === 0 ? 0 : (index + 1) % flat.length;
          draw();
          return true;
        }
        if (key === "ArrowUp") {
          index = flat.length === 0 ? 0 : (index - 1 + flat.length) % flat.length;
          draw();
          return true;
        }
        if (key === "Enter") {
          const row = flat[index];
          if (!row) return false;
          command?.(row.value);
          return true;
        }
        if (key === "Escape") {
          dismissed = true;
          root?.render(null);
          return true;
        }
        return false;
      },
      onExit() {
        // Unmount on a later tick: React refuses to unmount a root while it
        // is still rendering, which is exactly when a pick fires this.
        const dyingRoot = root;
        const dyingHost = host;
        root = null;
        host = null;
        dismissed = false;
        setTimeout(() => {
          dyingRoot?.unmount();
          dyingHost?.remove();
        }, 0);
      },
    };
  };
}
