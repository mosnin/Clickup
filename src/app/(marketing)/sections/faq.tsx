"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import gsap from "gsap";
import { Container, SectionHeading } from "@/components/marketing/ui";
import { DUR, EASE_OUT, GsapReveal, prefersReducedMotion } from "@/components/marketing/gsap";
import { FAQ } from "@/lib/marketing-content";

// Two-column FAQ accordion. Each item toggles independently; the answer
// wrapper animates its own height open/closed with GSAP.
//
// The height tween below is the sanctioned exception to the kit's
// transforms-only rule: `height: auto` <-> `0` has no transform
// equivalent (max-height/scaleY both fake it — auto-height content needs
// the real box height measured by the browser). It intentionally lives
// outside useGsap() too, since it runs imperatively from a click handler
// rather than on mount/scroll, and it hand-rolls its own
// prefersReducedMotion() branch (instant display toggle, no tween) rather
// than relying on useGsap's scroll-trigger-skip behavior.
function FaqItem({ q, a, id }: { q: string; a: string; id: string }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const answerRef = useRef<HTMLParagraphElement | null>(null);
  const chevronRef = useRef<SVGSVGElement | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const el = contentRef.current;
    const answerEl = answerRef.current;
    const chevronEl = chevronRef.current;

    if (chevronEl) {
      if (prefersReducedMotion()) {
        gsap.set(chevronEl, { rotate: next ? 180 : 0 });
      } else {
        gsap.to(chevronEl, {
          rotate: next ? 180 : 0,
          duration: DUR.fast,
          ease: EASE_OUT,
        });
      }
    }

    if (!el) return;

    if (prefersReducedMotion()) {
      el.style.display = next ? "block" : "none";
      return;
    }

    gsap.killTweensOf(el);
    if (answerEl) gsap.killTweensOf(answerEl);

    if (next) {
      el.style.display = "block";
      if (answerEl) gsap.set(answerEl, { y: -4, autoAlpha: 0 });
      gsap.fromTo(
        el,
        { height: 0, autoAlpha: 0 },
        { height: "auto", autoAlpha: 1, duration: DUR.fast, ease: EASE_OUT },
      );
      if (answerEl) {
        gsap.to(answerEl, {
          y: 0,
          autoAlpha: 1,
          duration: DUR.fast,
          ease: EASE_OUT,
        });
      }
    } else {
      // Let the collapse finish fully before hiding — no snap.
      gsap.to(el, {
        height: 0,
        autoAlpha: 0,
        duration: DUR.fast,
        ease: EASE_OUT,
        onComplete: () => {
          el.style.display = "none";
        },
      });
    }
  };

  return (
    <div
      className={`overflow-hidden rounded-[20px] bg-muted transition-colors ${
        open ? "" : "hover:bg-muted/80"
      }`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
      >
        <span className="text-[15px] font-medium text-foreground">{q}</span>
        <ChevronDown ref={chevronRef} className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <div
        ref={contentRef}
        id={id}
        style={{ display: "none", height: 0, overflow: "hidden" }}
      >
        <p
          ref={answerRef}
          className="px-6 pb-5 text-sm leading-relaxed text-muted-foreground"
        >
          {a}
        </p>
      </div>
    </div>
  );
}

export function Faq() {
  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading title={FAQ.title} />
        <GsapReveal stagger className="mt-12 grid items-start gap-4 md:grid-cols-2">
          {FAQ.items.map((item, i) => (
            <FaqItem key={item.q} q={item.q} a={item.a} id={`faq-answer-${i}`} />
          ))}
        </GsapReveal>
      </Container>
    </section>
  );
}
