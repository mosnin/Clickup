"use client";

// The face's own material, under the contents.
//
// Authored here rather than supplied with the rest of ai-lights: `AiLightsCard`
// imports it and passes one prop, so the contract is `{ dark }` and nothing more.
//
// It exists because of a specific failure mode in the spec: the four variants
// are meant to read as surfaces from one product family, and a product family's
// surfaces are LAYERED — that is most of what separates a designed flat UI from
// a coloured rectangle. But the layering cannot come from the variants, because
// a variant that draws its own container would break the morph (the body's box
// is measured from the contents, so anything pinning its own box moves the
// target). So the face carries it, once, for all four.
//
// Two strokes only: a light falling from the top, and a hairline where the face
// meets the ring. Both invert with polarity — on the dark panel the same light
// has to be a tenth the strength or it reads as fog rather than as a sheen.
//
// A sibling of the contents and strictly beneath them: it is inside the face's
// `overflow-hidden` and inherits its radius by being inset to it.

export function Surface({ dark }: { dark: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        background: dark
          ? "linear-gradient(180deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0) 58%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 62%)",
        // The hairline is an inset shadow rather than a border so it cannot
        // change the box the morph is animating toward.
        boxShadow: dark
          ? "inset 0 1px 0 rgba(255,255,255,0.07)"
          : "inset 0 1px 0 rgba(255,255,255,0.9)",
      }}
    />
  );
}
