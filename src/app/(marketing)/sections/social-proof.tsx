"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { Container, Eyebrow, ScreenshotFrame, IconDock } from "@/components/marketing/ui";
import { GsapReveal, useGsap, prefersReducedMotion, isHoverCapable, EASE_OUT } from "@/components/marketing/gsap";
import { SOCIAL_PROOF, RUNTIMES } from "@/lib/marketing-content";

// Dock magnification tuning — mouse-only, matches the macOS-dock reference
// interaction. Falls off linearly from MAX_SCALE at the cursor to 1 at
// FALLOFF_PX away.
const DOCK_MAX_SCALE = 1.35;
const DOCK_FALLOFF_PX = 120;
const DOCK_LIFT_PX = 6;

// Social proof band — sits directly under the Hero, inside the shared
// azure→navy gradient wrapper (see page.tsx). No own background here; the
// gradient is darkest (navy) behind this section. The announcement strip
// at the bottom is deliberately opaque white, so it reads as a separate,
// slim bar that closes the blue band out — matching the reference layout.

export function SocialProof() {
  const frameRef = useGsap(({ root }) => {
    const notes = root.querySelectorAll<HTMLElement>(".gs-float-note");
    notes.forEach((note, i) => {
      gsap.to(note, {
        y: i % 2 === 0 ? -6 : 6,
        duration: 3 + i * 0.3,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
        delay: i * 0.4,
      });
    });

    // Slow scroll parallax layered on top of the idle float above — the
    // wrapper carries the scrub drift, the inner note keeps its own
    // independent bob, so the two transforms compose instead of fighting
    // over the same tween.
    const wraps = root.querySelectorAll<HTMLElement>(".gs-float-wrap");
    wraps.forEach((wrap, i) => {
      gsap.fromTo(
        wrap,
        { y: i % 2 === 0 ? -20 : 20 },
        {
          y: i % 2 === 0 ? 20 : -20,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "bottom top",
            scrub: true,
          },
        },
      );
    });

    // Screenshot entrance — subtle scale-up as it scrolls into place,
    // matching the showcase treatment.
    const shot = root.querySelector<HTMLElement>(".gs-shot");
    if (shot) {
      gsap.fromTo(
        shot,
        { scale: 0.95 },
        {
          scale: 1,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "top 45%",
            scrub: true,
          },
        },
      );
    }
  });

  const dockRef = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelectorAll(".gs-dock-icon"),
      { scale: 0.6, autoAlpha: 0 },
      {
        scale: 1,
        autoAlpha: 1,
        duration: 0.6,
        ease: "back.out(1.7)",
        stagger: 0.05,
        scrollTrigger: {
          trigger: root,
          start: "top 85%",
          once: true,
        },
      },
    );
  });

  // Dock magnification — the signature interaction. A plain effect (rather
  // than useGsap's context) because it needs a real removeEventListener
  // cleanup on unmount; the reduced-motion + hover-only guards below give
  // the same "skip entirely" behavior useGsap applies to its own tweens.
  const dockWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const wrap = dockWrapRef.current;
    if (!wrap) return;
    if (prefersReducedMotion()) return;
    if (!isHoverCapable()) return;

    const icons = Array.from(
      wrap.querySelectorAll<HTMLElement>(".gs-dock-icon"),
    );
    if (icons.length === 0) return;

    const setters = icons.map((icon) => ({
      scale: gsap.quickTo(icon, "scale", { duration: 0.3, ease: EASE_OUT }),
      y: gsap.quickTo(icon, "y", { duration: 0.3, ease: EASE_OUT }),
    }));

    const onMove = (e: PointerEvent) => {
      icons.forEach((icon, i) => {
        const rect = icon.getBoundingClientRect();
        const dist = Math.abs(e.clientX - (rect.left + rect.width / 2));
        const t = Math.max(0, 1 - dist / DOCK_FALLOFF_PX);
        setters[i].scale(1 + (DOCK_MAX_SCALE - 1) * t);
        setters[i].y(-DOCK_LIFT_PX * t);
      });
    };

    const onLeave = () => {
      setters.forEach((setter) => {
        setter.scale(1);
        setter.y(0);
      });
    };

    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      gsap.set(icons, { clearProps: "scale,y" });
    };
  }, []);

  return (
    <>
      <section className="py-24 sm:py-28">
        <Container>
          <GsapReveal className="text-center">
            <Eyebrow tone="dark">{SOCIAL_PROOF.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {SOCIAL_PROOF.title.split(" ").map((word, i, words) => (
                <span
                  key={i}
                  className={i === words.length - 1 ? "text-gradient" : undefined}
                >
                  {word}
                  {i < words.length - 1 ? " " : ""}
                </span>
              ))}
            </h2>
          </GsapReveal>

          <GsapReveal className="mt-12">
            <div ref={frameRef} className="relative mx-auto max-w-4xl">
              <div className="gs-shot">
                <ScreenshotFrame
                  tone="dark"
                  // Native aspect (2502x1420) so nothing gets cropped.
                  ratio="2502/1420"
                  label={SOCIAL_PROOF.screenshot}
                  src="/screenshots/mission-control.png"
                  alt="Mission Control — the live agent fleet in operate.to"
                />
              </div>
              <div className="gs-float-wrap absolute -left-4 top-8 hidden sm:block">
                <div className="gs-float-note rounded-full bg-white/10 px-3 py-1.5 text-xs text-white ring-1 ring-white/20 backdrop-blur">
                  {SOCIAL_PROOF.floatingNotes[0]}
                </div>
              </div>
              <div className="gs-float-wrap absolute -right-4 bottom-10 hidden sm:block">
                <div className="gs-float-note rounded-full bg-white/10 px-3 py-1.5 text-xs text-white ring-1 ring-white/20 backdrop-blur">
                  {SOCIAL_PROOF.floatingNotes[1]}
                </div>
              </div>
            </div>
          </GsapReveal>

          <div ref={dockRef} className="mt-12 flex flex-col items-center">
            <p className="text-xs uppercase tracking-widest text-white/60">
              {SOCIAL_PROOF.dockLabel}
            </p>
            <div
              ref={dockWrapRef}
              className="mt-4 flex w-full justify-center overflow-x-auto"
            >
              <IconDock items={RUNTIMES} className="shrink-0" />
            </div>
          </div>
        </Container>
      </section>

    </>
  );
}
