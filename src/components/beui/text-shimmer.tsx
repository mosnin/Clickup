"use client";
// Vendored from beui.dev on the founder's instruction; the keyframes/lib pair
// is merged into one file, and the gradient reads this app's Tailwind v4
// token names (--color-*), which the original's bare --muted-foreground would
// silently miss.

import type { CSSProperties, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

const KEYFRAMES =
  "@keyframes beui-text-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}";

const SHIMMER_CLASS =
  "bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--color-muted-foreground)_30%,var(--color-foreground)_50%,var(--color-muted-foreground)_70%)]";

export interface TextShimmerProps {
  children: ReactNode;
  as?: ElementType;
  duration?: number;
  className?: string;
}

export function TextShimmer({
  children,
  as: Comp = "span",
  duration = 2.5,
  className,
}: TextShimmerProps) {
  const style: CSSProperties = {
    animation: `beui-text-shimmer ${duration}s linear infinite`,
  };
  return (
    <>
      <style>{KEYFRAMES}</style>
      <Comp style={style} className={cn("inline-block", SHIMMER_CLASS, className)}>
        {children}
      </Comp>
    </>
  );
}

/** A shimmering "working on it" line — for live-run narration and loaders. */
export function ThinkingShimmer({
  children = "Thinking…",
  duration = 1.8,
  className,
}: {
  children?: ReactNode;
  duration?: number;
  className?: string;
}) {
  return (
    <TextShimmer as="span" duration={duration} className={cn("font-medium", className)}>
      {children}
    </TextShimmer>
  );
}
