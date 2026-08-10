"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DARK_KEYS, VARIANTS, radiusFor, useVariantSizes } from "./variants";
import { RimGlow } from "./RimGlow";
import { Surface } from "./Surface";
import { useAiPulse, useRimMask } from "./use-ai-lights";

const PULSE_MS = 1600;

const FADE_OUT_MS = 160;

const MORPH_MS = 380;

const HANDOVER_AT = PULSE_MS + 120;

const SETTLED_MS = 260;

const GAP_MS =
  HANDOVER_AT - PULSE_MS + FADE_OUT_MS + MORPH_MS + 80 + SETTLED_MS;

/**
 * `bare` drops the plate: no tinted panel, no border, no fixed box — just the
 * morphing body and its light, sitting directly on whatever the page is.
 *
 * That is how it ships on our site. The plate is a demo frame: it says "here
 * is a component being shown to you" rather than "this is what the product
 * looks like", and a pale panel is a third surface competing with a page that
 * already has a canvas and a card. Removing it also un-clips the halo — the
 * outermost glow layer reaches ~80px past the body, and `overflow-hidden` was
 * cutting the softest, furthest part of the light square.
 */
export function AiLightsCard({ bare = false }: { bare?: boolean } = {}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const { sizes, probe } = useVariantSizes();

  const [slot, setSlot] = useState(0);
  const slotRef = useRef(0);

  const [showing, setShowing] = useState(true);

  const [morphing, setMorphing] = useState(false);

  const [gen, setGen] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  const after = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const variant = VARIANTS[slot];
  const size = sizes?.[slot];

  const radius = size ? radiusFor(variant, size.h + 2) : 0;

  const layers = useRimMask(bodyRef, 90, undefined, radius);

  useAiPulse({
    pulseMs: PULSE_MS,
    gapMs: GAP_MS,
    onPulse: useCallback(() => {

      clearTimers();
      after(HANDOVER_AT, () => {

        setShowing(false);

        after(FADE_OUT_MS, () => {

          bodyRef.current?.removeAttribute("data-playing");
          setMorphing(true);
          slotRef.current = (slotRef.current + 1) % VARIANTS.length;
          setSlot(slotRef.current);
          after(MORPH_MS, () => {
            setMorphing(false);
            setGen((g) => g + 1);
            setShowing(true);
          });
        });
      });
    }, []),
    ref: bodyRef,
    paletteRef: cardRef,
  });

  useEffect(() => clearTimers, []);

  return (
    <div
      data-canvas-card

      aria-hidden="true"
      ref={cardRef}

      className={
        bare
          ? // Tall enough for the halo, and nothing else. No fill, no rim, no
            // clipping — the light is allowed to spill onto the page.
            "relative flex min-h-[220px] w-full select-none items-center justify-center"
          : "relative flex aspect-[1344/620] w-full select-none items-center justify-center overflow-hidden rounded-[12px] border border-[var(--border-line)] transition-[--ai-bg1,--ai-bg2,--ai-bg3] duration-[1200ms] ease-[var(--ease-out)] bg-[linear-gradient(180deg,var(--ai-bg1,#f7f9fc)_0%,var(--ai-bg2,#eef4fb)_55%,var(--ai-bg3,#e6f0fa)_100%)]"
      }
    >
      {}
      {probe}

      {}
      <div
        ref={bodyRef}
        data-morphing={morphing ? "true" : undefined}

        className="ai-lights relative rounded-[var(--r)] p-px shadow-[0_1px_2px_rgba(12,38,77,0.06),0_8px_24px_rgba(12,38,77,0.08)] transition-[width,height,border-radius] duration-[var(--m)] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={
          {
            width: size ? `${size.w + 2}px` : undefined,
            height: size ? `${size.h + 2}px` : undefined,
            "--r": `${radius}px`,
            "--m": `${MORPH_MS}ms`,
          } as React.CSSProperties
        }
      >
        <RimGlow layers={layers} />

        {}
        {}
        <div

          className="relative h-full w-full overflow-hidden rounded-[calc(var(--r)-1px)] transition-colors duration-[var(--m)] ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{
            // Both faces come from the ramp now. It was a hardcoded `#1e1e1e`
            // for the terminal against a white `--s-surface-2`; with the ramp
            // inverted for a dark site that literal would have been the only
            // value in the card the theme could not reach — and it would have
            // landed LIGHTER than the surface it is supposed to be deeper than.
            backgroundColor: DARK_KEYS.has(variant.key)
              ? "var(--s-surface-0)"
              : "var(--s-surface-2)",
          }}
        >
          {}
          <Surface dark={DARK_KEYS.has(variant.key)} />

          <div
            key={gen}

            className={`relative h-full w-full ${variant.pad} transition-opacity duration-[var(--f)] ease-[var(--ease-out)]`}
            style={
              {
                opacity: showing ? 1 : 0,
                contentVisibility: morphing ? "hidden" : undefined,
                "--f": `${FADE_OUT_MS}ms`,
              } as React.CSSProperties
            }
          >
            {}
            <variant.Content />
          </div>
        </div>
      </div>
    </div>
  );
}
