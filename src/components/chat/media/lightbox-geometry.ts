// Where the lightbox opens from and where it lands.
//
// Pure, and separate from the component for the reason §2.8 separates them in
// Buzz: the animation is a FLIP — measure the thumbnail's real box, compute the
// box it is going to, animate the *difference* — and every part of that except
// `getBoundingClientRect` is arithmetic. Arithmetic that decides whether an
// image appears to grow out of the message or to jump can be tested; a
// component that does the arithmetic inside an effect cannot.
//
// jsdom lays nothing out, so none of this is a claim that the animation looks
// right. It is a claim that the numbers are the numbers.

export type Box = { top: number; left: number; width: number; height: number };

/** §2.8: enter 260, exit 170, and 100 for a reader who asked for less motion. */
export const LIGHTBOX_ENTER_MS = 260;
export const LIGHTBOX_EXIT_MS = 170;
export const LIGHTBOX_REDUCED_MS = 100;

/** The fraction of the viewport a lightboxed image is allowed to fill. */
export const LIGHTBOX_VIEWPORT_FRACTION = 0.8;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
/** §2.8. Per wheel event, before clamping. */
export const WHEEL_ZOOM_SPEED = 0.002;
export const MAX_WHEEL_DELTA = 0.2;

/**
 * The centred box an image opens into.
 *
 * Sized from the image's **natural** ratio rather than from the thumbnail's box,
 * because a thumbnail is usually cropped — opening into the crop's shape and
 * then reflowing to the real one is the reflow the whole progressive-image
 * treatment exists to avoid.
 *
 * A natural size of zero (the image has not loaded yet) falls back to the
 * viewport fraction as a square, which is wrong by an aspect ratio and right in
 * the only way that matters: the box is on screen and the animation has
 * somewhere to go.
 */
export function lightboxTarget(
  viewport: { width: number; height: number },
  natural: { width: number; height: number },
  fraction: number = LIGHTBOX_VIEWPORT_FRACTION,
): Box {
  const maxWidth = Math.max(1, viewport.width * fraction);
  const maxHeight = Math.max(1, viewport.height * fraction);

  let width = maxWidth;
  let height = maxHeight;
  if (natural.width > 0 && natural.height > 0) {
    const scale = Math.min(maxWidth / natural.width, maxHeight / natural.height);
    width = natural.width * scale;
    height = natural.height * scale;
  }

  return {
    width,
    height,
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
  };
}

/**
 * The transform that makes `to` look like `from`.
 *
 * FLIP's inverted step: the element is already laid out at `to`, and this is
 * what has to be applied before the frame paints so it *appears* to be at
 * `from`. Animating it back to identity is the whole illusion.
 *
 * The transform origin is the top-left corner, which is why the translation is a
 * plain difference of corners rather than of centres.
 */
export function flipFrom(from: Box, to: Box): {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
} {
  return {
    x: from.left - to.left,
    y: from.top - to.top,
    scaleX: to.width > 0 ? from.width / to.width : 1,
    scaleY: to.height > 0 ? from.height / to.height : 1,
  };
}

/** One wheel notch of zoom, clamped both ways. §2.8's constants. */
export function zoomAfterWheel(current: number, deltaY: number): number {
  const raw = deltaY * -WHEEL_ZOOM_SPEED;
  const bounded = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, raw));
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + bounded * current));
}

/**
 * Which entry the arrow keys land on.
 *
 * Clamped rather than wrapped. A gallery that wraps means the right arrow at the
 * last image silently takes you back to the first, and in a transcript — where
 * the gallery is "the images in this message" and the reader is stepping through
 * them looking for one — that reads as the viewer having jumped somewhere else.
 */
export function stepInGallery(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/**
 * The visible triggers in one markdown scope, in document order.
 *
 * §2.8 builds the gallery from the DOM rather than from the data, and that is
 * the right way round: the gallery is what the reader can *see*, so a collapsed
 * spoiler or a zero-size element is not in it. Reading the data instead would
 * offer arrow navigation to an image that is not on screen.
 */
export function galleryTriggers(scope: ParentNode | null): HTMLElement[] {
  if (!scope) return [];
  const found = Array.from(
    scope.querySelectorAll<HTMLElement>("[data-image-lightbox-trigger]"),
  );
  return found.filter((element) => {
    if (element.hidden) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}
