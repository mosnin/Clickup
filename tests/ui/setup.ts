import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom lacks the browser APIs the dashboard's motion and layout primitives
// reach for. Stubbing them here rather than in each test keeps the tests
// about the component instead of about the environment.
afterEach(async () => {
  cleanup();
  // React's concurrent scheduler flushes remaining work on a later macrotask
  // (setImmediate under jsdom). Unmounting queues that flush; if the test file
  // ends first, the scheduler wakes up after the environment is gone and dies
  // on `window is not defined`. One tick here lets it land while the window
  // still exists.
  await new Promise((resolve) => setImmediate(resolve));
  // Twice: the first flush can itself schedule a continuation (React yields
  // long work across multiple macrotasks), and a single tick still lost the
  // race under a loaded worker pool.
  await new Promise((resolve) => setImmediate(resolve));
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

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
