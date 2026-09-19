"use client";

import { motion, EASE } from "@/components/motion";
import { cn } from "@/lib/utils";
import { EmptyBlob } from "@/components/dashboard/deel-ui";

// Deel 2025 empty (Mobbin funds / move-to-folder): a pale blob, one
// sentence, one quieter line, optional black pill. No panel, no dashed
// box, no decorative icon tile.

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
      className={cn(compact ? "" : "rounded-[var(--ui-radius-card)] bg-card")}
    >
      <EmptyBlob title={title} message={message} action={action} />
    </motion.div>
  );
}
