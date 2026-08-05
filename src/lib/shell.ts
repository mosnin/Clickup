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
 * `bg-page` is the load-bearing part. Every card in the product is `bg-card` —
 * white — so a white sheet gives them nothing to sit on and only a hairline
 * says where one ends. The tinted canvas is what makes `.bento` mean anything,
 * and it is the one thing all three design references share.
 */
export const SHELL_INSET =
  "h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-x-contain bg-page";

/**
 * The provider wrapper: pinned to the viewport so the inset — not the
 * document — is the real scroll container, which is what lets a page's sticky
 * header actually stick.
 */
export const SHELL_PROVIDER = "h-svh overflow-hidden";

/** The gutter every dashboard page is drawn inside. */
export const SHELL_PAGE = "w-full px-4 py-6 sm:px-6";
