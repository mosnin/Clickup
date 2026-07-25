"use client";

import { useEffect, useRef } from "react";

// The hero's background film.
//
// Two things this has to get right, both learned the hard way:
//
// 1. AUTOPLAY ON PHONES. Shipping `autoplay muted loop playsinline` in the
//    markup is not enough on iOS. Safari checks the muted *property* when it
//    evaluates the gesture requirement, and a `muted` attribute added by
//    server-rendered HTML does not always set it in time. So we set the
//    property (and defaultMuted, which survives a src change) BEFORE
//    assigning src, then call play() ourselves and retry as the media
//    becomes ready. Low Power Mode can still refuse outright, so the first
//    interaction anywhere on the page is taken as permission.
//
// 2. SHARPNESS. The hero box is tall and narrow, so `object-cover` on a
//    landscape clip crops hard and magnifies what is left — measured at 2.6x
//    on desktop and 3.5x on a phone, which turns fine ASCII into mush. Phones
//    get a 9:16 centre-crop encode instead of the landscape one, so the
//    visible slice is close to native resolution.
//
// src is assigned on the client, so only the variant that will actually play
// is ever downloaded (preload="none" + a poster covers the first paint).

const LANDSCAPE = {
  src: "/screenshots/hero-ascii.mp4",
  poster: "/screenshots/hero-ascii-poster.jpg",
};
const PORTRAIT = {
  src: "/screenshots/hero-ascii-portrait.mp4",
  poster: "/screenshots/hero-ascii-poster-portrait.jpg",
};

export function HeroFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const portrait = window.matchMedia("(max-width: 768px)").matches;
    const chosen = portrait ? PORTRAIT : LANDSCAPE;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    video.poster = chosen.poster;
    if (!video.src.endsWith(chosen.src)) {
      video.src = chosen.src;
      video.load();
    }

    const play = () => {
      // Rejections are expected (not ready yet, or a policy block) — the
      // retries below cover both, so swallowing is correct here.
      void video.play().catch(() => {});
    };

    play();
    video.addEventListener("loadeddata", play);
    video.addEventListener("canplay", play);
    document.addEventListener("visibilitychange", play);
    // Last resort for Low Power Mode / strict data-saver setups.
    const onGesture = () => play();
    document.addEventListener("touchstart", onGesture, {
      once: true,
      passive: true,
    });
    document.addEventListener("pointerdown", onGesture, { once: true });

    return () => {
      video.removeEventListener("loadeddata", play);
      video.removeEventListener("canplay", play);
      document.removeEventListener("visibilitychange", play);
      document.removeEventListener("touchstart", onGesture);
      document.removeEventListener("pointerdown", onGesture);
    };
  }, []);

  return (
    <video
      ref={ref}
      aria-hidden
      tabIndex={-1}
      autoPlay
      loop
      muted
      playsInline
      preload="none"
      poster={LANDSCAPE.poster}
      disablePictureInPicture
      className="h-full w-full object-cover opacity-70"
    />
  );
}
