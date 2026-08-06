// The Work shell's own class strings, in one place.
//
// They were written out twice — once in `app/dashboard/layout.tsx` and once in
// `tests/ui/design/home-app.tsx`, the harness the design gallery renders — and
// the two drifted the moment one of them changed. That is not a cosmetic
// problem: the gallery is the only place anybody LOOKS at this product, and a
// gallery rendering a shell nobody ships reports a design that does not exist.
// It cost a whole round of "the canvas is white" versus "the canvas is tinted",
// because both were true, of different files.
//
// `layout.tsx` is a Next.js route segment file and may not export anything but
// its default and the framework's own metadata hooks, so the constants live
// here rather than there.

/**
 * The scroll container.
 *
 * `bg-background`, not `bg-page`: since the app became a window (`.app-slab`),
 * `--color-page` is only ever the tint BEHIND the slab. Painting it inside
 * would put the backdrop on the content and leave the frame with nothing to
 * frame. Cards separate from this surface by their hairline and shadow.
 */
export const SHELL_INSET =
  "h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-x-contain bg-background";

/**
 * The provider wrapper — and the app window itself.
 *
 * `.app-slab` (globals.css) is the rounded surface the whole application sits
 * on, inset from the viewport with the page colour showing round every edge.
 * It is still pinned to the viewport with its own overflow hidden, which is
 * what makes the inset — not the document — the real scroll container and
 * therefore what lets a page's sticky header actually stick.
 */
export const SHELL_PROVIDER = "app-slab flex";

/** The gutter every dashboard page is drawn inside. */
// More air than it had: Apple's surfaces breathe, and the old 16px phone
// gutter put cards two hairlines from the slab's own edge.
export const SHELL_PAGE = "w-full px-5 py-7 sm:px-8";
