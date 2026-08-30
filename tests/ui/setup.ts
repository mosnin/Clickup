import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom lacks the browser APIs the dashboard's motion and layout primitives
// reach for. Stubbing them here rather than in each test keeps the tests
// about the component instead of about the environment.
afterEach(async () => {
  cleanup();
  // React's concurrent scheduler flushes remaining work on later macrotasks
  // (setImmediate under jsdom). Unmounting queues that flush; if the test file
  // ends first, the scheduler wakes up after the environment is gone and dies
  // on `window is not defined`.
  //
  // Two setImmediate ticks were not enough: a component's zero-timer (a
  // debounce, a positioning callback) can fire BETWEEN immediates, schedule a
  // state update, and put fresh scheduler work on the immediate queue after
  // the drain has moved on — CI's loaded worker pool lost exactly that race
  // while every laptop won it. So the drain alternates BOTH queues (immediates
  // run before timers each turn of the loop) enough rounds to exhaust a chain
  // of continuations. Bounded, so a genuinely self-rescheduling loop in a
  // component still ends the test rather than hanging it.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom lays nothing out, so every box is 0×0 and every size-observing
// component renders empty. That is indistinguishable from a broken chart, and
// the charts are the biggest size-observing thing in the app — so the stub
// reports a plausible box rather than staying silent. `observe` fires
// immediately because the real one does too (a first delivery on observation
// is part of the spec) and because nothing in a test will ever resize.
export const STUB_BOX = { width: 640, height: 320, top: 0, left: 0 };

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: STUB_BOX } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Same reason: components that measure with `getBoundingClientRect` instead of
// an observer get the same box, and only when jsdom has nothing to say.
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function measured(this: Element) {
  const rect = realRect.call(this);
  if (rect.width > 0 || rect.height > 0) return rect;
  return { ...STUB_BOX, right: STUB_BOX.width, bottom: STUB_BOX.height, x: 0, y: 0, toJSON: () => STUB_BOX } as DOMRect;
};

// jsdom implements the SVG DOM but none of its geometry, so a path cannot be
// measured. The chart library draws its stroke-reveal animations by walking
// path length; without these it throws out of an effect, which surfaces as an
// unhandled error attributed to whichever test happened to be running.
{
  const svg = SVGElement.prototype as unknown as Record<string, unknown>;
  svg.getTotalLength ??= () => 100;
  svg.getPointAtLength ??= () => ({ x: 0, y: 0 });
  svg.getBBox ??= () => ({ x: 0, y: 0, width: 100, height: 100 });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// jsdom ships no canvas: `getContext("2d")` returns null and shouts "Not
// implemented" through the virtual console once per avatar rendered. Two
// reasons that is worth stubbing rather than tolerating. The noise is the
// smaller one — a suite that prints hundreds of errors on a green run is a
// suite nobody reads when a real error appears, which this project has
// already paid for once. The larger one: with a null context every canvas
// component early-returns, so its drawing code is never executed by any test
// and a crash in there would ship green.
//
// So: a recording no-op context. Every 2D method is a function that does
// nothing, every property is settable, and `getContext` hands back the same
// object per canvas — enough for a component to run its full draw pass.
if (!HTMLCanvasElement.prototype.getContext.toString().includes("stub")) {
  const contexts = new WeakMap<HTMLCanvasElement, unknown>();
  HTMLCanvasElement.prototype.getContext = function stub(this: HTMLCanvasElement) {
    const existing = contexts.get(this);
    if (existing) return existing as CanvasRenderingContext2D;
    const canvas = this;
    const store: Record<string | symbol, unknown> = {};
    // The methods that RETURN something a caller then reads. A blanket
    // no-op is wrong for these — `getImageData(...).data` on undefined
    // throws, and the charts genuinely round-trip a colour through the
    // canvas to resolve `var()`/`color-mix()`. Opaque black is the honest
    // answer for a surface nothing was ever painted onto.
    const returns: Record<string, () => unknown> = {
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      measureText: () => ({ width: 0 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      createConicGradient: () => ({ addColorStop: () => undefined }),
      createPattern: () => null,
      isPointInPath: () => false,
      isPointInStroke: () => false,
    };
    const ctx = new Proxy(store, {
      get(target, prop) {
        if (prop in target) return target[prop];
        // The one real back-reference a component may legitimately read.
        if (prop === "canvas") return canvas;
        if (typeof prop === "string" && prop in returns) return returns[prop];
        // Everything else is a drawing call: does nothing, returns nothing.
        return () => undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
    contexts.set(this, ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
