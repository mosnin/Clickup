"use client";

import { useEffect, useRef } from "react";
import { Datamosh } from "./engine";
import { onTransitionChange } from "@/lib/view-transition";

export function DatamoshCard({
  bare = false,
}: { bare?: boolean } = {}) {
  void bare;
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let engine: Datamosh | null = null;
    let raf = 0;
    let created = false;
    let onScreen = false;
    let hidden = false;
    let inTransition = false;

    const running = () => onScreen && !hidden && !inTransition;
    const sync = () => {
      if (!engine || reduced) return;
      if (running()) engine.start();
      else engine.stop();
    };

    const create = () => {
      if (created) return;
      created = true;
      raf = requestAnimationFrame(() => {
        if (!hostRef.current) return;

        engine = new Datamosh(host, 1 + Math.floor(Math.random() * 9999));
        if (!engine.ok) return;
        if (reduced) engine.renderStill();
        else sync();
      });
    };

    const io = new IntersectionObserver(
      (es) => {
        onScreen = es.some((e) => e.isIntersecting);
        if (onScreen && !created) create();
        if (created) sync();
      },
      { rootMargin: "200px" },
    );
    io.observe(host);

    const onVis = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVis);
    const offTransition = onTransitionChange((active) => {
      inTransition = active;
      sync();
    });

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      offTransition();
      if (raf) cancelAnimationFrame(raf);
      engine?.destroy();
      engine = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label="A corrupted video decode: fixed columns of saturated colour, each one falling on its own fast clock. Tiles snap open through the middle of the frame and squeeze back down at the top and bottom, staggered column by column so the motion sweeps from right to left."
      className="relative aspect-[1344/620] w-full overflow-hidden rounded-[12px] border border-[var(--border-line)] bg-[#14101f]"
    />
  );
}
