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
// meets the ring.
//
// `dark` now means "the deepest face" (the terminal) rather than "the inverted
// one" — every face is dark since the ramp was inverted for a dark site. The
// sheen still differs between them, and in the direction that looks wrong until
// you think about it: the DEEPER face gets the STRONGER highlight. A fixed
// white at a fixed opacity lands as a bigger step against a near-black surface
// than against a charcoal one only if you hold the opacity still, and holding
// it still is what makes the near-black panel look flat and dead beside its
// neighbours. Matching the perceived lift is what keeps them one family.
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
          ? "linear-gradient(180deg, rgba(255,255,255,0.075) 0%, rgba(255,255,255,0) 58%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0) 62%)",
        // The hairline is an inset shadow rather than a border so it cannot
        // change the box the morph is animating toward.
        boxShadow: dark
          ? "inset 0 1px 0 rgba(255,255,255,0.09)"
          : "inset 0 1px 0 rgba(255,255,255,0.07)",
      }}
    />
  );
}
