"use client";

import { useEffect, useRef } from "react";

// The hero's background film.
//
// Three things this has to get right, all learned the hard way:
//
// 1. AUTOPLAY. Shipping `autoplay muted loop playsinline` in the markup is
//    not enough on iOS: Safari checks the muted *property* when it evaluates
//    the gesture requirement, and an attribute from server-rendered HTML does
//    not reliably set it in time. So we set the properties, call play()
//    ourselves, and retry as the media becomes ready. Low Power Mode can
//    still refuse outright, so the first interaction anywhere counts as
//    permission. The service worker also has to leave video alone — a cached
//    video answers a byte-range request with a complete body, which Safari
//    rejects outright (see src/app/sw.ts).
//
// 2. SHARPNESS. `object-cover` in a tall narrow box crops hard and magnifies
//    what is left — measured 2.6x on desktop and 3.5x on a phone, which turns
//    fine ASCII into mush. Phones get a 9:16 centre-crop encode, and the
//    layer is deliberately short and wide, which keeps both near native.
//
// 3. CODECS. H.264 is universal in shipping browsers, but Chromium builds
//    without proprietary codecs (and some Linux Firefox installs) cannot
//    decode it at all — there, the mp4 fails with MEDIA_ERR_SRC_NOT_SUPPORTED
//    and the hero silently sits on its poster. A VP9/WebM alternative is
//    picked when the browser says it cannot play mp4.

type Variant = { mp4: string; webm: string; poster: string };

const LANDSCAPE: Variant = {
  mp4: "/screenshots/hero-ascii.mp4",
  webm: "/screenshots/hero-ascii.webm",
  poster: "/screenshots/hero-ascii-poster.jpg",
};
const PORTRAIT: Variant = {
  mp4: "/screenshots/hero-ascii-portrait.mp4",
  webm: "/screenshots/hero-ascii-portrait.webm",
  poster: "/screenshots/hero-ascii-poster-portrait.jpg",
};

export function HeroFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;

    const variant = window.matchMedia("(max-width: 768px)").matches
      ? PORTRAIT
      : LANDSCAPE;
    // canPlayType returns "" when the container/codec is unsupported.
    const canMp4 = video.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "";
    const wanted = canMp4 ? variant.mp4 : variant.webm;

    if (!video.currentSrc.endsWith(wanted)) {
      video.poster = variant.poster;
      video.src = wanted;
      video.load();
    }

    const play = () => {
      // Rejections are expected (not ready yet, or a policy block); the
      // retries below cover both cases, so swallowing here is correct.
      void video.play().catch(() => {});
    };
    // If the chosen file still fails to decode, fall back once to the other
    // container rather than leaving a dead poster on screen.
    const onError = () => {
      const other = video.currentSrc.endsWith(variant.mp4)
        ? variant.webm
        : variant.mp4;
      if (!video.currentSrc.endsWith(other)) {
        video.src = other;
        video.load();
        play();
      }
    };

    play();
    video.addEventListener("loadeddata", play);
    video.addEventListener("canplay", play);
    video.addEventListener("error", onError);
    document.addEventListener("visibilitychange", play);
    const onGesture = () => play();
    document.addEventListener("touchstart", onGesture, {
      once: true,
      passive: true,
    });
    document.addEventListener("pointerdown", onGesture, { once: true });

    return () => {
      video.removeEventListener("loadeddata", play);
      video.removeEventListener("canplay", play);
      video.removeEventListener("error", onError);
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
      // src ships in the HTML so the film plays with zero JavaScript; the
      // effect above only swaps it for the phone crop or a WebM fallback.
      src={LANDSCAPE.mp4}
      preload="metadata"
      poster={LANDSCAPE.poster}
      disablePictureInPicture
      className="h-full w-full object-cover opacity-70"
    />
  );
}
