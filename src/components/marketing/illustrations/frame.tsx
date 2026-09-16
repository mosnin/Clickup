import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared shell for the marketing illustrations.
//
// This deliberately mirrors ScreenshotFrame's shell rather than inventing a
// second card language: same `mk-panel-2` surface, same rounded-card-lg +
// p-1.5 + shadow-2xl, same inner rounded-xl well, same figcaption. An
// illustration and a screenshot sit in the same row on /features and must
// read as the same object — a frame that differs by a few pixels of radius
// is the kind of thing nobody can name but everybody sees.
//
// The illustrations themselves are drawn from the theme's own tokens
// (mk-panel, the azure ramp, white/[0.0x] hairlines), so they inherit the
// marketing scope's palette flip for free and never hardcode a hex.
export function IllustrationFrame({
  children,
  caption,
  /** Tailwind aspect class for the drawing well. A class rather than an
   * inline `aspect-ratio` so it can carry a breakpoint: an illustration is
   * often a different shape on a phone than on a desktop. */
  ratioClass = "aspect-[16/10]",
  className,
}: {
  children: ReactNode;
  caption?: string;
  ratioClass?: string;
  className?: string;
}) {
  const frame = (
    <div
      className={cn(
        "relative overflow-hidden rounded-card-lg p-1.5 shadow-2xl mk-panel-2",
        className,
      )}
    >
      <div className={cn("relative overflow-hidden rounded-xl mk-panel", ratioClass)}>
        {children}
      </div>
    </div>
  );
  if (!caption) return frame;
  return (
    <figure className="m-0">
      {frame}
      <figcaption className="mt-3 text-center text-xs leading-relaxed text-white/45">
        {caption}
      </figcaption>
    </figure>
  );
}
