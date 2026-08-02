"use client";

// The lightbox: an image growing out of the message it was in.
//
// The whole design is one idea from §2.8 — the picture does not *appear*, it
// *moves*. A modal that fades in over a transcript makes the reader find their
// place again when it closes; one that grows out of the thumbnail and shrinks
// back into it keeps the place for them. That is a FLIP animation from the
// thumbnail's real box, and the arithmetic lives next door in
// `lightbox-geometry.ts` so it can be checked without a browser.
//
// Three details that are easy to leave out and each of which is the difference
// between "smooth" and "why did it jump":
//
//   • **The return target is recomputed at close time.** The transcript scrolls
//     and re-renders while the lightbox is open, so the box the image came from
//     is not where it is now. Closing to a remembered rectangle animates the
//     picture into empty space.
//   • **The gallery is the DOM, not the data** (`galleryTriggers`): arrow keys
//     step through the images the reader can actually see.
//   • **Reduced motion shortens rather than removes.** A picture that appears
//     with no transition at all is a jump-cut; 100ms is enough to say where it
//     came from without any of the travel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { MediaDescriptor } from "@/lib/buzz/media";
import {
  LIGHTBOX_ENTER_MS,
  LIGHTBOX_EXIT_MS,
  LIGHTBOX_REDUCED_MS,
  flipFrom,
  galleryTriggers,
  lightboxTarget,
  stepInGallery,
  zoomAfterWheel,
  type Box,
} from "./lightbox-geometry";

export type LightboxRequest = {
  /** The element the reader clicked; the animation starts from its box. */
  trigger: HTMLElement;
  /** Where to look for the rest of the gallery — usually the message row. */
  scope: ParentNode | null;
  media: MediaDescriptor[];
};

export function ImageLightbox({
  request,
  onClose,
}: {
  request: LightboxRequest | null;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [entered, setEntered] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // The gallery, resolved once per opening. Recomputing it per render would
  // rebuild the array while the reader is stepping through it.
  const gallery = useMemo(() => {
    if (!request) return [] as { media: MediaDescriptor; element: HTMLElement }[];
    const elements = galleryTriggers(request.scope ?? request.trigger.parentElement);
    const byUrl = new Map(request.media.map((entry) => [entry.url, entry]));
    const found = elements
      .map((element) => ({ element, media: byUrl.get(element.dataset.mediaUrl ?? "") }))
      .filter((entry): entry is { element: HTMLElement; media: MediaDescriptor } =>
        Boolean(entry.media),
      );
    // A trigger with no matching descriptor means the two disagree; fall back to
    // the one that was clicked rather than showing nothing.
    if (found.length === 0) {
      const clicked = byUrl.get(request.trigger.dataset.mediaUrl ?? "");
      return clicked ? [{ element: request.trigger, media: clicked }] : [];
    }
    return found;
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const start = gallery.findIndex((entry) => entry.element === request.trigger);
    setIndex(start >= 0 ? start : 0);
    setZoom(1);
    setEntered(false);
    // Two frames: one for the inverted transform to paint, one to release it.
    // A single frame lands in the same paint and the animation never runs.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(raf);
  }, [request, gallery]);

  const close = useCallback(() => {
    setEntered(false);
    // Long enough for the exit to play; the caller unmounts us afterwards.
    window.setTimeout(onClose, reduced ? LIGHTBOX_REDUCED_MS : LIGHTBOX_EXIT_MS);
  }, [onClose, reduced]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowRight") {
        setIndex((current) => stepInGallery(current, 1, gallery.length));
        setZoom(1);
      } else if (event.key === "ArrowLeft") {
        setIndex((current) => stepInGallery(current, -1, gallery.length));
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, gallery.length, close]);

  if (!request || !mounted || gallery.length === 0) return null;

  const current = gallery[Math.min(index, gallery.length - 1)];
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const natural = {
    width: current.media.width ?? 0,
    height: current.media.height ?? 0,
  };
  const target = lightboxTarget(viewport, natural);
  // Recomputed here, on every render, which is what makes the close land on the
  // element's *current* box rather than the one it had when it was opened.
  const origin: Box = boxOf(current.element);
  const flip = flipFrom(origin, target);
  const duration = reduced ? LIGHTBOX_REDUCED_MS : entered ? LIGHTBOX_ENTER_MS : LIGHTBOX_EXIT_MS;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.media.filename ?? "Image"}
      className="fixed inset-0 z-[60]"
      onWheel={(event) => setZoom((value) => zoomAfterWheel(value, event.deltaY))}
    >
      <button
        type="button"
        aria-label="Close image"
        onClick={close}
        style={{ transitionDuration: `${duration}ms` }}
        className={cn(
          "absolute inset-0 cursor-zoom-out bg-black/70 transition-opacity",
          entered ? "opacity-100" : "opacity-0",
        )}
      />

      {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on
          the Convex storage host; see progressive-image.tsx */}
      <img
        ref={imageRef}
        src={current.media.url}
        alt={current.media.filename ?? "Image"}
        style={{
          position: "fixed",
          top: target.top,
          left: target.left,
          width: target.width,
          height: target.height,
          transformOrigin: "top left",
          transform: entered
            ? `translate(0px, 0px) scale(${zoom})`
            : `translate(${flip.x}px, ${flip.y}px) scale(${flip.scaleX}, ${flip.scaleY})`,
          transition: `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`,
        }}
        className="pointer-events-none rounded-2xl object-contain"
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
        <span className="pointer-events-auto rounded-full bg-black/50 px-3 py-1 text-xs text-white">
          {gallery.length > 1 ? `${index + 1} of ${gallery.length}` : (current.media.filename ?? "")}
        </span>
        <button
          type="button"
          aria-label="Close image"
          onClick={close}
          className="tap-target pointer-events-auto flex size-9 items-center justify-center rounded-full bg-black/50 text-white"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {gallery.length > 1 ? (
        <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 p-4">
          <button
            type="button"
            aria-label="Previous image"
            disabled={index === 0}
            onClick={() => {
              setIndex((value) => stepInGallery(value, -1, gallery.length));
              setZoom(1);
            }}
            className="tap-target rounded-full bg-black/50 px-4 py-1.5 text-xs text-white disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            aria-label="Next image"
            disabled={index === gallery.length - 1}
            onClick={() => {
              setIndex((value) => stepInGallery(value, 1, gallery.length));
              setZoom(1);
            }}
            className="tap-target rounded-full bg-black/50 px-4 py-1.5 text-xs text-white disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function boxOf(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * The reader's own setting, read live.
 *
 * Live rather than once, because the app's appearance layer lets somebody turn
 * motion down while they are looking at the thing that moves.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
