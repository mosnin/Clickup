import { afterAll, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

async function flushReactScheduler() {
  // React's concurrent scheduler flushes remaining work on later macrotasks
  // (setImmediate under jsdom). Unmounting queues that flush; if the test
  // file ends first, the scheduler wakes up after the environment is gone
  // and dies on `window is not defined`. Two ticks still lost the race
  // under CI's loaded worker pool (page-editor + Tiptap). Drain several
  // immediates and one timeout so a continuation scheduled by a flush
  // still sees `window`.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// jsdom lacks the browser APIs the dashboard's motion and layout primitives
// reach for. Stubbing them here rather than in each test keeps the tests
// about the component instead of about the environment.
afterEach(async () => {
  cleanup();
  await flushReactScheduler();
});

afterAll(async () => {
  cleanup();
  await flushReactScheduler();
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
