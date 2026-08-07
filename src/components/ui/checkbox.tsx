"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
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
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
