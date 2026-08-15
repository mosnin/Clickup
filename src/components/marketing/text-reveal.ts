import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Text Reveal 02 (vendored) — split text into lines/words/chars with
// SplitText and fade each piece in from opacity 0.1. Opt in with
// `data-reveal-02="lines|words|chars"` on the TEXT ELEMENT ITSELF; add
// `data-scroll` for a threshold trigger or `data-scroll="scrub"` to follow
// the scroll position. Per-element overrides: data-duration, data-stagger,
// data-delay, data-ease, data-once, data-manual.
//
// Ported near-verbatim on the founder's instruction — the config values,
// the `clamp()` start, the onSplit contract and the once/kill behaviour ARE
// the effect, so they are not re-authored here. Two adaptations only, both
// sanctioned by the resource: the DOMContentLoaded footer is dropped (the
// marketing template calls this from the mounted client lifecycle), and the
// module is typed just enough to live in a strict TS tree.
//
// REDUCED MOTION is handled by the CALLER, deliberately: the required CSS
// hides every `[data-reveal-02]` before JS runs, so whoever skips this
// helper must also un-hide the text or it stays invisible forever.
// `page-effects.tsx` owns that decision — do not call this from anywhere
// else without reproducing it.

gsap.registerPlugin(SplitText, ScrollTrigger);

type SplitKind = "lines" | "words" | "chars";

export function textReveal02(
  scope: Document | Element = document,
  delay = 0,
  { ignoreManual = false } = {},
) {
  const CONFIG = {
    lines: { duration: 0.04, stagger: 0.03, ease: "power1.out" },
    words: { duration: 0.04, stagger: 0.03, ease: "power1.out" },
    chars: { duration: 0.04, stagger: 0.03, ease: "power1.out" },
    scrollStart: "top 85%",
    scrubStart: "top 80%",
    scrubEnd: "top 20%",
    once: true,
    markers: false,
  };

  const allSplitEls = scope.querySelectorAll<HTMLElement>("[data-reveal-02]");
  const autoEls = ignoreManual
    ? [...allSplitEls]
    : [...allSplitEls].filter((el) => !el.hasAttribute("data-manual"));

  gsap.set(autoEls, { visibility: "visible" });

  allSplitEls.forEach((el) => {
    const splitType = el.getAttribute("data-reveal-02") as SplitKind | null;
    const c = splitType ? CONFIG[splitType] : undefined;
    if (!splitType || !c) return;

    let type: string;
    let linesClass: string | undefined;
    let wordsClass: string | undefined;
    let charsClass: string | undefined;
    switch (splitType) {
      case "lines":
        type = "lines";
        linesClass = "line";
        break;
      case "words":
        type = "words, lines";
        wordsClass = "word";
        linesClass = "line";
        break;
      case "chars":
        type = "chars, words, lines";
        charsClass = "char";
        wordsClass = "word";
        linesClass = "line";
        break;
      default:
        return;
    }

    if (!ignoreManual && el.hasAttribute("data-manual")) {
      SplitText.create(el, {
        type,
        autoSplit: true,
        ...(linesClass && { linesClass }),
        ...(wordsClass && { wordsClass }),
        ...(charsClass && { charsClass }),
      });
      return;
    }

    const scrollMode = el.getAttribute("data-scroll");
    const useScroll = el.hasAttribute("data-scroll");
    const useScrub = scrollMode === "scrub";

    SplitText.create(el, {
      type,
      autoSplit: true,
      ...(linesClass && { linesClass }),
      ...(wordsClass && { wordsClass }),
      ...(charsClass && { charsClass }),
      onSplit(instance) {
        const durationValue = parseFloat(el.dataset.duration ?? "");
        const staggerValue = parseFloat(el.dataset.stagger ?? "");
        const delayValue = parseFloat(el.dataset.delay ?? "");
        const duration = Number.isNaN(durationValue)
          ? c.duration
          : durationValue;
        const stagger = Number.isNaN(staggerValue) ? c.stagger : staggerValue;
        const elDelay = Number.isNaN(delayValue) ? 0 : delayValue;
        const ease = el.dataset.ease || c.ease;

        const targets = instance[splitType];
        const once = el.hasAttribute("data-once")
          ? el.getAttribute("data-once") !== "false"
          : CONFIG.once;

        // gsap.TweenVars is structurally open; assembled exactly as the
        // resource assembles it (scrollTrigger attached conditionally).
        const tween: gsap.TweenVars = {
          opacity: 0.1,
          duration,
          stagger,
          delay: useScroll ? elDelay : elDelay + delay,
          immediateRender: true,
          ease,
        };

        if (useScrub) {
          tween.scrollTrigger = {
            trigger: el,
            start: CONFIG.scrubStart,
            end: CONFIG.scrubEnd,
            scrub: true,
            markers: CONFIG.markers,
            ...(once && {
              onLeave: (self: ScrollTrigger) => self.kill(false),
            }),
          };
        } else if (useScroll) {
          const start = scrollMode || CONFIG.scrollStart;
          tween.scrollTrigger = {
            trigger: el,
            start: `clamp(${start})`,
            markers: CONFIG.markers,
            ...(once
              ? { once: true }
              : { toggleActions: "play none none reverse" }),
          };
        }

        return gsap.from(targets, tween);
      },
    });
  });
}
