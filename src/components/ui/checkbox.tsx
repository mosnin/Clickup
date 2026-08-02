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
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        // A 16px box is the right SIGHT and the wrong TARGET. This is the
        // control that marks a task done, and on a phone it asked for a finger
        // placed inside four millimetres square, in both directions at once —
        // the exact case the 44px floor exists for, and one no amount of space
        // around it fixes.
        //
        // A halo rather than a bigger box, because the drawing is correct: the
        // checkbox stays 16px and the press it answers to is 44. `-inset-3.5`
        // is 14px a side, which is 44 exactly. `.tap-target` (the app's usual
        // idiom) would only reach 33.6 here — its -0.55rem is sized for ~30px
        // controls — so the inset is stated rather than borrowed.
        //
        // Coarse pointers only. A 44px invisible halo under a mouse would
        // swallow clicks aimed at the words beside it; a finger has no such
        // precision to lose. Rows carrying these are ~77px apart, so no two
        // halos meet.
        "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']",
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
