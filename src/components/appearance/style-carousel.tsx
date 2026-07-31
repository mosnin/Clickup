"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAnimatable, type AnimatableObject } from "animejs";
import { scaled } from "@/lib/anime";
import { cn } from "@/lib/utils";

// A shelf of real things you scroll through.
//
// The point of it is that nothing here is a swatch or a specimen drawing of a
// look — every item is the actual component, rendered at a size you can judge,
// and the shelf makes comparing them a physical act rather than a reading
// comprehension exercise.
//
// **The magnification is driven by distance, per frame.** Each item is an
// `animatable` whose scale and lift follow how close its centre is to the
// shelf's centre, recomputed on scroll. That is anime.js's actual job in this
// codebase — driving values that no CSS transition can express — and it is the
// same trick the app dock uses. A cosine falloff rather than a linear one,
// because linear leaves a visible kink where the influence zone ends.
//
// **Scrolling is the interaction; clicking is the commit.** Snap points mean
// the shelf always comes to rest on an item, so "which one am I looking at" is
// never ambiguous, and the centred item is the one a keyboard Enter takes.
//
// **Reduced motion is not a lesser version.** `scaled()` returns 0 and the
// per-frame driver simply writes the resting values, so the shelf still snaps
// and still highlights — it just doesn't breathe.

/** How far from centre an item still feels the pull, as a fraction of width. */
const INFLUENCE = 0.55;
/** How much the centred item grows. Subtle: these are real components. */
const LIFT = 0.08;

export type CarouselItem = {
  id: string;
  label: string;
  hint?: string;
  render: () => React.ReactNode;
};

export function StyleCarousel({
  items,
  selectedId,
  onPick,
  itemWidth = 220,
  label,
  tone = "light",
}: {
  items: CarouselItem[];
  selectedId?: string;
  onPick: (id: string) => void;
  /** Fixed so the shelf has a rhythm; content scales inside it. */
  itemWidth?: number;
  label: string;
  /** "dark" when the shelf sits on the ink screen — flips ring and text. */
  tone?: "light" | "dark";
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const animatables = useRef<Map<string, AnimatableObject>>(new Map());
  const [centred, setCentred] = useState<string | null>(
    selectedId ?? items[0]?.id ?? null,
  );

  /** Recompute every item's scale from its distance to the shelf centre. */
  const drive = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const box = track.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    const reach = Math.max(box.width * INFLUENCE, 1);

    let nearest: { id: string; d: number } | null = null;

    for (const child of Array.from(track.children)) {
      const id = (child as HTMLElement).dataset.itemId;
      if (!id) continue;
      const rect = child.getBoundingClientRect();
      const d = Math.abs(rect.left + rect.width / 2 - mid);
      if (!nearest || d < nearest.d) nearest = { id, d };

      // Cosine falloff to zero at `reach`, so there is no edge where the
      // effect stops abruptly.
      const t = Math.min(d / reach, 1);
      const pull = (Math.cos(t * Math.PI) + 1) / 2;
      const anim = animatables.current.get(id);
      if (anim) {
        anim.scale(1 + LIFT * pull);
        anim.opacity(0.55 + 0.45 * pull);
      }
    }

    if (nearest && nearest.id !== centred) setCentred(nearest.id);
  }, [centred]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    // Snapshot the map for cleanup: the ref's `.current` can point at a fresh
    // map by the time this effect tears down.
    const anims = animatables.current;

    anims.clear();
    for (const child of Array.from(track.children)) {
      const id = (child as HTMLElement).dataset.itemId;
      if (!id) continue;
      anims.set(
        id,
        createAnimatable(child as HTMLElement, {
          scale: scaled(320),
          opacity: scaled(320),
          ease: "outQuad",
        }),
      );
    }

    drive();
    track.addEventListener("scroll", drive, { passive: true });
    const onResize = () => drive();
    window.addEventListener("resize", onResize);
    return () => {
      track.removeEventListener("scroll", drive);
      window.removeEventListener("resize", onResize);
      for (const anim of anims.values()) anim.revert();
      anims.clear();
    };
  }, [drive, items]);

  // Bring the chosen one into view when it changes from outside — picking in
  // one shelf can change what another shelf is showing.
  useEffect(() => {
    if (!selectedId) return;
    const el = trackRef.current?.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(selectedId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selectedId]);

  return (
    <section aria-label={label}>
      <div
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-[35%] pb-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        ref={trackRef}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (centred) onPick(centred);
          }
        }}
      >
        {items.map((item) => {
          const chosen = item.id === selectedId;
          return (
            <button
              aria-selected={chosen}
              className={cn(
                "flex shrink-0 snap-center flex-col rounded-2xl p-2 text-left transition-[box-shadow,outline-color] outline outline-2 outline-offset-2",
                chosen
                  ? tone === "dark"
                    ? "outline-background"
                    : "outline-foreground"
                  : "outline-transparent",
              )}
              data-item-id={item.id}
              key={item.id}
              onClick={() => onPick(item.id)}
              role="option"
              style={{ width: itemWidth }}
              title={item.hint}
              type="button"
            >
              <span className="pointer-events-none block">{item.render()}</span>
              <span className="mt-2 block truncate text-[12px] font-medium">
                {item.label}
              </span>
              {item.hint && (
                <span
                  className={cn(
                    "mt-0.5 block truncate text-[11px]",
                    tone === "dark"
                      ? "text-background/50"
                      : "text-muted-foreground",
                  )}
                >
                  {item.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
