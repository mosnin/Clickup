"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The sidebar tree's three motions.
//
// Lifted out of `ui/file-tree.tsx` rather than adopting that component
// wholesale. Its contract is "give me an array of nodes and I will draw them",
// and the real sidebar's rows carry a create menu, an overflow menu, inline
// creation, unread badges, drag handles and active state — none of which
// survive a contract like that. So the markup stays where the behaviour is and
// only the motion is shared, which is what keeps `FileTree` a primitive you
// can drop anywhere instead of a second sidebar with a worse API.
//
// Three things, and each one is doing a job:
//
// **The highlight is one element that moves**, not a background per row. A
// per-row hover state pops on and off; one element springing between rows
// reads as the cursor being tracked, which is the difference between a list
// that responds and a list that lights up. It has to be positioned against a
// scroll container, so the provider owns the ref and every row measures
// against it.
//
// **A branch opens by growing**, so the rows below it move rather than jump.
// `height: auto` under a spring is the only version of this that survives
// content of unknown size.
//
// **The disclosure marker turns.** Small, but it is the only feedback that the
// click landed on the branch rather than on the link beside it.
//
// All three go through `motion/react`, so `MotionConfig reducedMotion="user"`
// in the dashboard shell already switches them off for anyone who asked.

type Bounds = { top: number; left: number; width: number; height: number };

type TreeMotionCtx = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  setBounds: React.Dispatch<React.SetStateAction<Bounds | null>>;
};

const TreeMotionContext = React.createContext<TreeMotionCtx | null>(null);

/**
 * Wraps the scrolling tree and draws the travelling highlight behind it.
 *
 * Rendering the children inside the same positioned box is the point: the
 * highlight is absolutely positioned against this element, so a row's offset
 * has to be measured against the same thing.
 */
export function TreeHighlight({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = React.useState<Bounds | null>(null);
  const value = React.useMemo(() => ({ containerRef, setBounds }), []);

  return (
    <TreeMotionContext.Provider value={value}>
      <div
        className={cn("relative isolate", className)}
        onMouseLeave={() => setBounds(null)}
        ref={containerRef}
      >
        <AnimatePresence>
          {bounds && (
            <motion.div
              animate={{
                opacity: 1,
                top: bounds.top,
                left: bounds.left,
                width: bounds.width,
                height: bounds.height,
              }}
              aria-hidden
              className="pointer-events-none absolute z-0 rounded-lg bg-muted/70"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
        </AnimatePresence>
        {children}
      </div>
    </TreeMotionContext.Provider>
  );
}

/**
 * Ref + handler for a row that the highlight should follow.
 *
 * Returns a no-op outside a `TreeHighlight` rather than throwing: rows are
 * reused on surfaces that have no travelling highlight (the icon rail, the
 * command palette), and a primitive that refuses to render outside one
 * context is a primitive with one caller.
 */
export function useTreeHover() {
  const ctx = React.useContext(TreeMotionContext);
  const ref = React.useRef<HTMLDivElement>(null);

  const onMouseEnter = React.useCallback(() => {
    const element = ref.current;
    const container = ctx?.containerRef.current;
    if (!element || !container || !ctx) return;
    const box = container.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    ctx.setBounds({
      // Relative to the container's *scrolled* content, not the viewport, or
      // the highlight detaches from its row the moment the tree scrolls.
      top: row.top - box.top + container.scrollTop,
      left: row.left - box.left,
      width: row.width,
      height: row.height,
    });
  }, [ctx]);

  return { ref, onMouseEnter, enabled: ctx !== null };
}

/** A branch that grows open and shrinks closed, with an indent guide. */
export function Branch({
  open,
  guide = true,
  children,
}: {
  open: boolean;
  /** The hairline down the left of the children. Off for top-level groups. */
  guide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          animate={{ height: "auto", opacity: 1 }}
          className="relative z-10"
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          style={{ overflow: "hidden" }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        >
          <div
            className={cn(
              guide &&
                "relative before:absolute before:inset-y-1 before:left-[0.6rem] before:w-px before:bg-border",
            )}
          >
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The turning marker on a branch's row. */
export function Disclosure({
  open,
  onToggle,
  label,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  /** What the branch is, for the screen-reader name. */
  label: string;
  className?: string;
}) {
  return (
    <button
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      className={cn(
        "flex size-5 flex-shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
      onClick={onToggle}
      type="button"
    >
      <motion.span
        animate={{ rotate: open ? 90 : 0 }}
        className="inline-flex"
        transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.8 }}
      >
        <ChevronRight className="size-3.5" />
      </motion.span>
    </button>
  );
}
