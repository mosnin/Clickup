"use client";

// An image that arrives in two stages and never moves the page.
//
// §2.8: draw the thumbnail, then swap to the full image once it has loaded *and*
// decoded. `decode()` is the part that is easy to leave out and the part that
// makes the swap invisible — an `onLoad` handler fires before the browser has
// turned the bytes into pixels, so swapping there hands the compositor a frame
// of nothing and the picture flashes white at exactly the moment it appears.
//
// The frame is sized from `dim` before either image exists. That is what
// blurhash was mostly buying in Buzz and we have no blurhash generator, so the
// placeholder is a plain tint — but the *reflow* is the part that hurts, and
// `dim` alone is enough to prevent it. A transcript that reflows while images
// load throws the reader's position away every time somebody posts a screenshot.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { MediaDescriptor } from "@/lib/buzz/media";

export type ProgressiveImageProps = {
  media: MediaDescriptor;
  /** The widest the frame may draw. The height follows from `dim`. */
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
  onActivate?: (element: HTMLElement) => void;
};

export function ProgressiveImage({
  media,
  maxWidth = 420,
  maxHeight = 320,
  className,
  onActivate,
}: ProgressiveImageProps) {
  // Skipped entirely when the thumbnail resolves to the same URL — otherwise the
  // component would wait for a "preview" that is the thing it is previewing.
  const thumb = media.thumbUrl && media.thumbUrl !== media.url ? media.thumbUrl : null;
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  const frameRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setReady(false);
    setBroken(false);
  }, [media.url]);

  const box = frameBox(media, maxWidth, maxHeight);
  const label = media.filename ? `Image: ${media.filename}` : "Image";

  const content = (
    <>
      {thumb && !ready ? (
        // A user upload on the Convex storage host: next/image cannot be told
        // about that origin ahead of time and would proxy every byte for no gain.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt=""
          aria-hidden
          // Blurred rather than sharp: a 320px thumbnail stretched to the frame
          // is visibly soft anyway, and blurring it says "this is loading"
          // instead of "this is what the picture looks like".
          className="absolute inset-0 size-full scale-105 object-cover blur-[6px]"
        />
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- same reason */}
      <img
        src={media.url}
        alt={label}
        loading="lazy"
        decoding="async"
        onLoad={(event) => {
          const image = event.currentTarget;
          // `decode()` may reject on an image the browser has already painted;
          // either way the swap happens, so the failure path is the same.
          const settle = () => setReady(true);
          if (typeof image.decode === "function") void image.decode().then(settle, settle);
          else settle();
        }}
        onError={() => setBroken(true)}
        className={cn(
          "size-full object-cover transition-opacity duration-200",
          ready || !thumb ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );

  if (broken) {
    return (
      <p className="chat-quiet soft-field px-3 py-2 text-xs">
        {media.filename ? `${media.filename} could not be loaded` : "Image could not be loaded"}
      </p>
    );
  }

  return (
    <button
      ref={frameRef}
      type="button"
      // The gallery is built from these in document order (§2.8), so the
      // attribute is the contract between the renderer and the lightbox rather
      // than a styling hook.
      data-image-lightbox-trigger=""
      data-media-url={media.url}
      aria-label={`Open ${label}`}
      onClick={() => {
        if (frameRef.current) onActivate?.(frameRef.current);
      }}
      style={{ width: box.width, height: box.height }}
      className={cn(
        "relative block max-w-full overflow-hidden rounded-2xl bg-[var(--chat-hover)]",
        onActivate ? "cursor-zoom-in" : "cursor-default",
        className,
      )}
    >
      {content}
    </button>
  );
}

/**
 * The box the frame reserves.
 *
 * With `dim`, the real ratio scaled to fit. Without it, a 4:3 box at the
 * maximum width — a guess, but a *stable* guess: the alternative is a frame
 * with no height, which collapses to nothing and then shoves the transcript
 * down when the image lands.
 */
export function frameBox(
  media: Pick<MediaDescriptor, "width" | "height">,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (!media.width || !media.height) {
    return { width: maxWidth, height: Math.round((maxWidth * 3) / 4) };
  }
  const scale = Math.min(maxWidth / media.width, maxHeight / media.height, 1);
  return {
    width: Math.round(media.width * scale),
    height: Math.round(media.height * scale),
  };
}
