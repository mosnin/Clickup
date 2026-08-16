"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { EASE_OUT, SPRING_PRESS } from "@/lib/motion-tokens";
import { uiSound } from "@/lib/sound";
import { cn } from "@/lib/utils";

// The Radix shell survives (state model, a11y, uncontrolled support, the
// data-state styling contract every call site leans on) — what changed is the
// PHYSICS, ported from the vendored beui checkbox: the press has spring
// weight, the tick DRAWS itself in instead of appearing, and the control
// answers in the app's voice (rising check on, plain tap off). Marking a task
// done is the most repeated gesture in the product; it should feel like
// something happened.

const MotionRoot = motion.create(CheckboxPrimitive.Root);
const CHECK_PATH = "M5 13l4 4L19 7";

// React's CSS-animation/drag event handler props collide with motion's props
// of the same names once the Root is a motion component; nothing here uses
// either flavour, so the spread type simply drops them.
type CheckboxProps = Omit<
  React.ComponentProps<typeof CheckboxPrimitive.Root>,
  "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd"
>;

function Checkbox({ className, onCheckedChange, ...props }: CheckboxProps) {
  const reduce = useReducedMotion();
  return (
    <MotionRoot
      data-slot="checkbox"
      whileTap={reduce || props.disabled ? undefined : { scale: 0.9 }}
      transition={SPRING_PRESS}
      onCheckedChange={(value) => {
        uiSound(value === true ? "check_on" : "tap");
        onCheckedChange?.(value);
      }}
      className={cn(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        // A 16px box is the right SIGHT and the wrong TARGET. This is the
        // control that marks a task done, and on a phone it asked for a finger
        // placed inside four millimetres square, in both directions at once —
        // the exact case the 44px floor exists for, and one no amount of space
        // around it fixes.
        //
        // A halo rather than a bigger box, because the drawing is correct: the
        // checkbox stays 16px and the press it answers to is 44.
        //
        // This used to state its own `-inset-3.5`, because `.tap-target` was a
        // flat -0.55rem halo that only reached 33.6px on a control this small.
        // The utility is now a 44px FLOOR, which resolves to exactly -14px on
        // a 16px box — the same geometry, borrowed instead of restated. Rows
        // carrying these are ~77px apart, so no two halos meet.
        "tap-target",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        // forceMount so AnimatePresence owns the unmount and the tick can
        // blur out instead of vanishing; Radix hides it via data-state.
        forceMount
        className="grid place-content-center text-current"
      >
        <AnimatePresence initial={false}>
          {props.checked === true || props.checked === undefined ? (
            <motion.svg
              key="tick"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.5, filter: "blur(4px)" }
              }
              transition={
                reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }
              }
              aria-hidden
              className={
                // Uncontrolled usage has no `checked` prop to branch on;
                // let the Radix data-state contract hide the mark instead.
                props.checked === undefined
                  ? "hidden [[data-state=checked]_&]:block"
                  : undefined
              }
            >
              <motion.path
                d={CHECK_PATH}
                initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { duration: 0.3, ease: EASE_OUT, delay: 0.04 }
                }
              />
            </motion.svg>
          ) : null}
        </AnimatePresence>
      </CheckboxPrimitive.Indicator>
    </MotionRoot>
  );
}

export { Checkbox };
