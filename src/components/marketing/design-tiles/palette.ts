// The bar says what operate.to IS, one surface per tile — the brief asked for
// this piece to be "based around operate's products", and this list is the only
// thing in the file that is content rather than mechanism. Five words to match
// INITIAL's five swatches, and all short enough that no tile dominates the bar.
export const WORDS = ["tasks", "docs", "goals", "chat", "agents"];

export type Swatch = { bg: string; fg: string };

export const SWATCHES: Swatch[] = [
  // The neutral anchor, and the one swatch that had to flip with the site.
  //
  // It was near-black (#0a0a0a), which is right on a white page and invisible
  // on a dark one — the tile disappeared and its word floated with no block
  // behind it while its four neighbours had one, which reads as a missing tile
  // rather than a dark one. Near-white does the same job here: the un-saturated
  // one, holding its own against eight loud colours.
  { bg: "#f2f4f8", fg: "#0a0a0a" },
  { bg: "#ff2e20", fg: "#0a0a0a" },
  { bg: "#f0c2f7", fg: "#0a0a0a" },
  { bg: "#22e58b", fg: "#0a0a0a" },
  { bg: "#7c4dff", fg: "#ffffff" },
  { bg: "#ffe14d", fg: "#0a0a0a" },
  { bg: "#18b6ff", fg: "#0a0a0a" },
  { bg: "#ff7a1a", fg: "#0a0a0a" },
  { bg: "#ff4fa3", fg: "#0a0a0a" },
];

export function randomSwatch(exclude?: Swatch): Swatch {
  if (SWATCHES.length < 2 || !exclude) {
    return SWATCHES[(Math.random() * SWATCHES.length) | 0];
  }
  let s = exclude;
  while (s === exclude) s = SWATCHES[(Math.random() * SWATCHES.length) | 0];
  return s;
}

export function randomSwatchAvoiding(used: Swatch[]): Swatch {
  const free = SWATCHES.filter((s) => !used.includes(s));
  const pool = free.length > 0 ? free : SWATCHES;
  return pool[(Math.random() * pool.length) | 0];
}

export const INITIAL: Swatch[] = [
  SWATCHES[0],
  SWATCHES[1],
  SWATCHES[2],
  SWATCHES[3],
  SWATCHES[4],
];
