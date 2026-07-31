"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/utils";

// A list where arriving is a movement, not a repaint.
//
// The primitive behind any surface where rows land while you are looking at
// it. Two properties are the whole point and both are easy to lose:
//
// **Index 0 is the newest**, so a new row pushes the rest down rather than
// appearing at the bottom where nobody is looking. Callers pass newest-first
// and the component does not sort — a list that reorders its own input cannot
// be used for anything that is already ordered by something else.
//
// **`layout` plus a keyed `AnimatePresence`** is what makes the push read as
// one motion instead of a jump: the rows that stay animate to their new
// positions while the new one springs in and the overflow one leaves.
// `mode="popLayout"` is what stops the leaving row from holding its slot.
//
// `maxVisible` is a render cap, not a data cap. The caller decides how much
// history exists; this decides how much of it is on screen.

export type AnimationType = "scale" | "slide" | "fade" | "bounce";

export interface AnimatedListProps<T> {
  /** index 0 = newest */
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  /** @default 8 */
  maxVisible?: number;
  /** @default 12 */
  gap?: number;
  /** @default "scale" */
  animation?: AnimationType;
  className?: string;
}

function getAnimationVariants(type: AnimationType) {
  switch (type) {
    case "slide":
      return {
        initial: { opacity: 0, y: -30 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -20 },
      };
    case "fade":
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      };
    case "bounce":
      return {
        initial: { opacity: 0, y: -20, scale: 0.8 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, scale: 0.8 },
      };
    case "scale":
    default:
      return {
        initial: { opacity: 0, y: -20, scale: 0.95 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, scale: 0.9 },
      };
  }
}

export function AnimatedList<T extends { id: string | number }>({
  items,
  renderItem,
  maxVisible = 8,
  gap = 12,
  animation = "scale",
  className,
}: AnimatedListProps<T>) {
  const visible = items.slice(0, maxVisible);
  const variants = getAnimationVariants(animation);

  return (
    <div className={cn("flex flex-col", className)} style={{ gap: `${gap}px` }}>
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((item, index) => (
          <motion.div
            key={item.id}
            layout
            initial={variants.initial}
            animate={variants.animate}
            exit={variants.exit}
            transition={{
              type: "spring",
              stiffness: 350,
              damping: 28,
              layout: { type: "spring", stiffness: 350, damping: 28 },
            }}
          >
            {renderItem(item, index)}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
