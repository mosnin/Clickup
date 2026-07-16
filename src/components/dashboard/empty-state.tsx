"use client";

import { motion, EASE } from "@/components/motion";

// The one empty-state shell: open space, a quiet headline, one teaching
// sentence, and at most one action. No dashed boxes, no icons, no borders.
// Premium products treat emptiness as breathing room, not as an error.

export function EmptyState({
  title,
  message,
  action,
  compact,
}: {
  /** Short, human headline ("Nothing here yet" beats "No items found"). */
  title: string;
  /** One sentence that teaches what this surface is for. */
  message: string;
  /** Optional single call to action. */
  action?: React.ReactNode;
  /** Tighter padding for use inside panels/cards. */
  compact?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      className={compact ? "px-6 py-10 text-center" : "px-6 py-20 text-center"}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </motion.div>
  );
}
