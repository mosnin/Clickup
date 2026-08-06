// The graphic marks the hero blocks carry.
//
// Both references fill their colour blocks with ART, not with white space:
// AIHub's yellow block is mostly a hypnotic set of concentric rings, and every
// list row opens with a drawn glyph. A saturated block with a number in one
// corner and nothing else is a form field wearing a paint job — the mark is
// what turns it into a poster.
//
// Inline SVG in `currentColor`, so the same mark is ink-on-yellow in the hero
// and could be chalk-on-dark anywhere else, with nothing fetched and nothing
// to theme. All of them are `aria-hidden` at the call site: they are drawing,
// not information.

export function OpRings({ className }: { className?: string }) {
  // Alternating ring weights, off-centre inner rings — the AIHub mark's trick.
  // Even spacing reads as a target; drift reads as op-art.
  const rings = [
    { r: 88, w: 7 },
    { r: 76, w: 9 },
    { r: 65, w: 7 },
    { r: 55, w: 8 },
    { r: 45, w: 6 },
    { r: 36, w: 7 },
    { r: 28, w: 5 },
    { r: 21, w: 6 },
    { r: 14, w: 4 },
    { r: 8, w: 5 },
  ];
  return (
    <svg viewBox="0 0 200 200" fill="none" className={className}>
      {rings.map((ring, i) => (
        <circle
          key={ring.r}
          // The centres walk slightly down-right as the rings shrink, which is
          // what gives the mark its pull. Sinusoidal rather than linear so the
          // drift reads as a swirl, not a misprint.
          cx={100 + Math.sin(i * 0.8) * i * 0.6}
          cy={100 + i * 0.9}
          r={ring.r}
          stroke="currentColor"
          strokeWidth={ring.w}
        />
      ))}
    </svg>
  );
}

/** The four-point spark both references use as a bullet. */
export function SparkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 1c.9 6.2 4.8 10.1 11 11-6.2.9-10.1 4.8-11 11-.9-6.2-4.8-10.1-11-11 6.2-.9 10.1-4.8 11-11Z" />
    </svg>
  );
}
