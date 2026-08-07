import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "@/lib/utils";

// The Cyberlock notch: a card whose top-right corner is scooped out, with the
// slab (--color-background) showing through and a control sitting in the scoop.
// The scoop is painted, not clipped — an absolute bg-background square covers the
// card's own corner, and two 10px "smoothers" fake the inverted fillet where the
// scoop meets the card's edges: each is a bg-background square whose full-size
// inner span wears the CARD's tone with rounded-tr, so the background shows only
// in the concave sliver outside the quarter-circle. Both smoothers round top-right
// because both curves bend toward the same corner.

type Tone = "panel" | "lime" | "island";

// Resolved through records, never string-built, so Tailwind's scanner sees every class.
// "panel" draws its separation the way every other surface in the app does —
// a value step (bg-card sits one step above the canvas) plus `.notch-panel`'s
// border-token + shadow — never a bare hairline. See `.notch-panel` in
// globals.css for why that's a small dedicated class and not the `.panel`
// class itself.
const TONE_ROOT: Record<Tone, string> = {
  panel: "notch-panel bg-card",
  lime: "bg-signal-lime text-signal-ink",
  // ui-light-island re-declares the light tokens inside itself, so the smoother
  // spans below can keep using bg-card and still match the island's surface.
  island: "ui-light-island border border-border",
};

// The smoother's inner span must match the card face exactly — inside an island
// root, bg-card resolves to the island's (white) card token, so no special case.
const TONE_FACE: Record<Tone, string> = {
  panel: "bg-card",
  lime: "bg-signal-lime",
  island: "bg-card",
};

export function NotchCard({
  tone = "panel",
  corner,
  className,
  children,
}: {
  tone?: Tone;
  corner?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        // overflow-visible on purpose: the scoop square sits flush over the
        // card's rounded corner; clipping it would re-expose the corner.
        "relative overflow-visible rounded-[1.375rem]",
        TONE_ROOT[tone],
        className,
      )}
    >
      {corner ? (
        <>
          {/* The scoop: slab colour over the card's own corner. Its bottom-left
              radius matches the card radius so the cut reads as deliberate. */}
          <div className="absolute right-0 top-0 flex size-14 items-center justify-center rounded-bl-[1.375rem] bg-background">
            {corner}
          </div>
          {/* Smoother on the top edge, just left of the scoop. */}
          <span aria-hidden className="absolute right-14 top-0 size-2.5 bg-background">
            <span className={cn("block size-full rounded-tr-[10px]", TONE_FACE[tone])} />
          </span>
          {/* Smoother on the right edge, just below the scoop. */}
          <span aria-hidden className="absolute right-0 top-14 size-2.5 bg-background">
            <span className={cn("block size-full rounded-tr-[10px]", TONE_FACE[tone])} />
          </span>
        </>
      ) : null}
      {/* No padding here — callers own their grid, and a scoop-aware layout
          needs to decide for itself how content clears the notch. */}
      {children}
    </div>
  );
}

// The usual occupant of the scoop: a circular ⋮ built from three dots, because
// glyph fonts drift between platforms and the icon rule forbids a lib for this.
export function NotchMenuButton({
  label,
  onClick,
}: {
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // No border: the scoop is already a colour cutout (bg-background) and
      // this button's own bg-card is the value step that separates it —
      // matching the corner controls at both call sites, which never drew a
      // ring of their own.
      className="flex size-9 items-center justify-center rounded-full bg-card text-foreground"
    >
      <span aria-hidden className="flex flex-col items-center gap-[3px]">
        <span className="size-[3px] rounded-full bg-current" />
        <span className="size-[3px] rounded-full bg-current" />
        <span className="size-[3px] rounded-full bg-current" />
      </span>
    </button>
  );
}
