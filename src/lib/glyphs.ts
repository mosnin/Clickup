// Icon geometry for the morphing glyphs.
//
// lucide-react 0.468 does not export the node data behind its components —
// only the rendered component — and morphicons needs the geometry to
// interpolate between two shapes. So the handful of icons that actually
// morph are lifted here, generated from the installed lucide modules rather
// than hand-copied, with lucide's internal render key
// stripped (it is a React reconciliation hint, not geometry).
//
// Only add an entry when a glyph genuinely morphs into another one. Every
// non-morphing icon should keep importing its component from lucide-react,
// so this file stays a short list of pairs rather than a second icon set
// drifting alongside the first.

import type { IconInput } from "morphicons/react";

export const GLYPH = {
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  sparkles: [ [ "path", { d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" } ], ["path", { d: "M20 3v4" }], ["path", { d: "M22 5h-4" }], ["path", { d: "M4 17v2" }], ["path", { d: "M5 18H3" }] ],
  sun: [ ["circle", { cx: "12", cy: "12", r: "4" }], ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }], ["path", { d: "m4.93 4.93 1.41 1.41" }], ["path", { d: "m17.66 17.66 1.41 1.41" }], ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }], ["path", { d: "m6.34 17.66-1.41 1.41" }], ["path", { d: "m19.07 4.93-1.41 1.41" }] ],
  moon: [ ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }] ],
  panelLeft: [ ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M9 3v18" }] ],
  panelRight: [ ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M15 3v18" }] ],
  chevronRight: [ ["path", { d: "m9 18 6-6-6-6" }] ],
  chevronDown: [ ["path", { d: "m6 9 6 6 6-6" }] ],
} satisfies Record<string, IconInput>;
