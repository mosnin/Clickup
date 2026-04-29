"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useCommandPalette } from "@/components/dashboard/command-palette";

// Global keyboard layer. Mounted once in the dashboard layout. Listens
// at document level and bails out cleanly when the focus is in a text
// editor — otherwise typing 'c' inside a comment composer would open
// the comment shortcut.
//
// Shortcuts intentionally short. Anything that grows past one keystroke
// goes through the command palette instead.
//
//   ⌘K / Ctrl+K   open command palette
//   /             focus the palette search input
//   ?             open the cheat sheet
//   Esc           close any modal/panel (handled per-modal)

export function KeyboardShortcuts() {
  const { open: openPalette } = useCommandPalette();
  const [cheatOpen, setCheatOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const editing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t as HTMLElement).isContentEditable);

      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openPalette();
        return;
      }
      if (editing) return;

      if (e.key === "/") {
        e.preventDefault();
        openPalette();
      } else if (e.key === "?") {
        e.preventDefault();
        setCheatOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPalette]);

  if (!cheatOpen) return null;
  return <CheatSheet onClose={() => setCheatOpen(false)} />;
}

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ["⌘", "K"], description: "Open the command palette" },
  { keys: ["/"], description: "Search anywhere" },
  { keys: ["?"], description: "Show this cheat sheet" },
  { keys: ["Esc"], description: "Close a modal, popover, or palette" },
];

function CheatSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-[60] flex items-end justify-center px-4 pb-8 sm:items-center sm:pb-0"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="divide-y divide-border">
          {SHORTCUTS.map((s) => (
            <li
              key={s.description}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <span>{s.description}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          More shortcuts land in step 2 — start with these.
        </p>
      </div>
    </div>
  );
}
