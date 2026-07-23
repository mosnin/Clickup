"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// Searchable picker: the app-wide replacement for native <select>s wherever
// the options are people, agents, tasks, or sprints. A pill trigger opens a
// popover with a filter input and a keyboard-navigable list (↑/↓/Enter/Esc).

export type PickerOption = {
  id: string;
  label: string;
  /** @deprecated no longer rendered — the product renders no emoji, ever. */
  emoji?: string;
  /** Muted trailing hint (e.g. "agent", "active"). */
  hint?: string;
};

export function Picker({
  options,
  onSelect,
  label,
  selectedId,
  disabled,
  dashed = false,
  className,
}: {
  options: PickerOption[];
  onSelect: (id: string) => void;
  /** Trigger text (e.g. "+ Assign…" or the current selection). */
  label: string;
  /** Marks this option with a check and sorts it first. */
  selectedId?: string;
  disabled?: boolean;
  /** Dashed trigger border — for "add" style triggers. */
  dashed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;
    if (!selectedId) return base;
    return [...base].sort((a, b) =>
      a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0,
    );
  }, [options, query, selectedId]);

  useEffect(() => setHighlight(0), [query, open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else setQuery("");
  }, [open]);

  function choose(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-sm transition-colors",
          dashed
            ? "border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            : "border-border hover:border-foreground/30",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute left-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlight((h) => Math.min(h + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlight((h) => Math.max(h - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const opt = filtered[highlight];
                    if (opt) choose(opt.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                  }
                }}
                placeholder="Search…"
                className="w-full bg-transparent text-sm focus:outline-none"
              />
            </div>
            <ul role="listbox" className="max-h-60 overflow-y-auto p-1">
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  No matches.
                </li>
              )}
              {filtered.map((o, i) => (
                <li key={o.id} role="option" aria-selected={o.id === selectedId}>
                  <button
                    type="button"
                    onClick={() => choose(o.id)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm",
                      i === highlight && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && (
                      <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                    {o.id === selectedId && (
                      <Check className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
