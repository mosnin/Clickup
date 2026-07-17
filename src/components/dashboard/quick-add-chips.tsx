"use client";

import { CalendarDays } from "lucide-react";
import type { ParsedQuickAdd } from "@/lib/quick-add";
import { AnimatePresence, motion } from "@/components/motion";
import {
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";

// Live preview for natural-language quick add: as the user types
// "tomorrow" or "!high", chips confirm what the parser understood before
// they commit. Quietly absent when nothing matched.

export function QuickAddChips({ parsed }: { parsed: ParsedQuickAdd }) {
  return (
    <AnimatePresence initial={false}>
      {parsed.matched.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18 }}
          className="flex items-center gap-1.5 overflow-hidden"
        >
          {parsed.matched.map((m) => (
            <span
              key={`${m.kind}-${m.label}`}
              className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/80"
            >
              {m.kind === "due" ? (
                <CalendarDays className="h-3 w-3 text-muted-foreground" aria-hidden />
              ) : (
                parsed.priority && (
                  <PriorityDot
                    priority={parsed.priority as TaskPriority}
                    className="h-1.5 w-1.5"
                  />
                )
              )}
              {m.label}
            </span>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
