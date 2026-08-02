"use client";

// One list, measuring everything it draws.
//
// The transcript is the only scroller on the screen and it holds rows whose
// heights nobody can know in advance: a one-line message, a forty-line code
// block, a day divider, an unread rule. Virtualization here is not a
// performance nicety — a room with ten thousand messages in it mounts ten
// thousand markdown renders otherwise — but the interesting part is not the
// windowing. It is that **the dividers are in the list**.
//
// A divider drawn as decoration inside a message row makes that row a different
// height than the virtualizer was told, and the error accumulates downward
// until the scrollbar is lying and jump-to-message lands three rows off. So
// every row goes through the same path: estimated before it is mounted,
// measured the moment it is, remembered by key.
//
// Three behaviours the geometry has to protect, each one a bug somebody has
// shipped:
//
//   • **A prepend must never pin you to the bottom.** Older history arriving
//     while you read upward and yanking you to the newest message is the single
//     most infuriating thing a transcript can do. The delta is classified from
//     keys (`classifyDelta`) and a prepend instead *holds the anchor*: the
//     scroll position is corrected by exactly the height that appeared above it.
//   • **"At bottom" has two thresholds.** 72px for "the reader is effectively
//     at the bottom, keep them there"; 1px for "we are physically pinned".
//     Using the loose one for the programmatic pin leaves a permanent 70px gap
//     under the last message that nothing can close.
//   • **An unmeasured viewport renders everything.** Before the first layout —
//     and under jsdom, which never lays anything out — `clientHeight` is 0.
//     Windowing against a zero viewport renders zero rows, which is
//     indistinguishable from a broken transcript. No measurement, no window.
//   • **A shrinking viewport must not drop the reader off the bottom.** The
//     band under the transcript grows and shrinks on its own — a huddle bar
//     appears when somebody starts a call — and a scroller that loses height
//     under a reader who was pinned silently takes the newest message off
//     screen with no gesture to blame it on. A key delta re-pins; a resize has
//     to as well.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { classifyDelta } from "./row-model";

/** UI "at bottom" — close enough that new messages should follow. */
export const BOTTOM_THRESHOLD_PX = 72;
/** Physically pinned. A programmatic pin must reach this, not the loose one. */
export const TRUE_BOTTOM_THRESHOLD_PX = 1;
/** Extra rows drawn above and below the window, in pixels. */
const OVERSCAN_PX = 600;
/** How close to the top before older history is asked for. */
const NEAR_TOP_PX = 400;

export type VirtualListHandle = {
  scrollToKey: (key: string, opts?: { block?: "center" | "start" }) => boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  isAtBottom: () => boolean;
};

export function VirtualList({
  keys,
  estimate,
  render,
  handleRef,
  onNearTop,
  leading,
  className,
  label,
}: {
  /** One stable key per row, in draw order. */
  keys: readonly string[];
  /** Height guess for a row that has never been mounted. */
  estimate: (index: number) => number;
  render: (index: number) => ReactNode;
  handleRef?: RefObject<VirtualListHandle | null>;
  /** Fired when the reader scrolls near the top — older history. */
  onNearTop?: () => void;
  /** Pinned above the first row (the "load earlier" chip). Never virtualized. */
  leading?: ReactNode;
  className?: string;
  label: string;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const measured = useRef(new Map<string, number>());
  // A counter, not the map itself: the map is mutated in place by the observer
  // (it has to be — the callback fires outside React's knowledge), so the
  // *fact that it changed* is what the layout memo can depend on.
  const [measureTick, setMeasureTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  // Heights and offsets. Recomputed whenever the key list changes or a
  // measurement lands; a prefix-sum array makes the window lookup a binary
  // search rather than a walk.
  const layout = useMemo(() => {
    void measureTick;
    const heights = keys.map((key, i) => measured.current.get(key) ?? estimate(i));
    const offsets = new Array<number>(keys.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < heights.length; i += 1) offsets[i + 1] = offsets[i] + heights[i];
    return { heights, offsets, total: offsets[keys.length] };
  }, [keys, estimate, measureTick]);

  // ---------------------------------------------------------------------
  // Measurement
  // ---------------------------------------------------------------------
  const observerRef = useRef<ResizeObserver | null>(null);
  const pending = useRef(false);

  const flush = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    // Batched: a page of rows measuring at once would otherwise be a state
    // update per row, and each one recomputes the prefix sums.
    queueMicrotask(() => {
      pending.current = false;
      setMeasureTick((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey;
        if (!key) continue;
        const height = entry.contentRect.height;
        if (height <= 0) continue;
        const previous = measured.current.get(key);
        // Half a pixel of hysteresis: sub-pixel reflow from a font settling in
        // would otherwise loop measure → layout → measure forever.
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          measured.current.set(key, height);
          changed = true;
        }
      }
      if (changed) flush();
    });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [flush]);

  const rowRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    observerRef.current?.observe(node);
  }, []);

  // ---------------------------------------------------------------------
  // Scroll position
  // ---------------------------------------------------------------------
  // Whether the reader is effectively at the bottom *right now*, kept current
  // by every scroll and every measurement — as opposed to `wasAtBottom` below,
  // which is deliberately a snapshot taken before a key delta lands.
  const pinned = useRef(true);
  /** The scroll height this component last accounted for. See below. */
  const contentHeight = useRef(0);

  const readGeometry = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight);
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    readGeometry();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = { w: el.clientWidth, h: el.clientHeight };
    const observer = new ResizeObserver(() => {
      const node = scrollerRef.current;
      if (!node) return;
      // Either dimension. Height is the obvious one (a huddle bar appears);
      // width matters just as much, because a pane docking beside the room
      // makes every row taller and pushes the newest message below the fold.
      const resized =
        node.clientWidth !== last.w || node.clientHeight !== last.h;
      last = { w: node.clientWidth, h: node.clientHeight };
      // Re-pin before re-reading, so the geometry that lands in state is the
      // corrected one rather than the frame where the reader was adrift.
      if (resized && pinned.current) node.scrollTop = node.scrollHeight;
      readGeometry();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [readGeometry]);

  const isAtBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  // `scrollTo` with options is not universal (and jsdom has none at all), so
  // every programmatic move goes through this rather than assuming it. The
  // fallback is not a degradation — it lands in the same place, without the
  // easing.
  const scrollTo = useCallback((top: number, behavior: ScrollBehavior = "auto") => {
    const el = scrollerRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior });
    else el.scrollTop = top;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = scrollerRef.current;
      if (el) scrollTo(el.scrollHeight, behavior);
    },
    [scrollTo],
  );

  // ---------------------------------------------------------------------
  // Delta handling: stick to the bottom, hold the anchor on a prepend
  // ---------------------------------------------------------------------
  const previousKeys = useRef<readonly string[]>([]);
  const wasAtBottom = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | null>(null);

  // Recorded during render-commit, before the DOM has the new rows: what the
  // reader was looking at, and whether they were pinned.
  useLayoutEffect(() => {
    const delta = classifyDelta({ current: keys, previous: previousKeys.current });
    const el = scrollerRef.current;
    if (el) {
      if (delta === "prepend" && anchor.current) {
        // Restore the anchor: find where the remembered row sits now and put
        // it back under the same pixel it was under before.
        const index = keys.indexOf(anchor.current.key);
        if (index >= 0) {
          el.scrollTop = layout.offsets[index] - anchor.current.offset;
        }
        //
        // Two different questions below, and using one answer for both is a
        // bug in either direction. A key delta asks "were they at the bottom
        // *before* this arrived", which is a snapshot taken last time round. A
        // pure measurement change — a row taller than its estimate, a reflow
        // because a pane opened beside the room — asks "are they at the bottom
        // right now", because by then the snapshot is stale and re-pinning on
        // it yanks a reader who has since scrolled up back to the newest
        // message.
      } else if (delta === "none" ? pinned.current : wasAtBottom.current) {
        el.scrollTop = el.scrollHeight;
      }
      // Record for the next change.
      wasAtBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
      pinned.current = wasAtBottom.current;
      // This commit's height is accounted for, so the growth check below has
      // nothing left to correct — which is what keeps it from second-guessing
      // the anchor a prepend just restored.
      contentHeight.current = el.scrollHeight;
      const firstVisible = firstIndexAt(layout.offsets, el.scrollTop);
      anchor.current =
        keys.length > 0
          ? {
              key: keys[Math.min(firstVisible, keys.length - 1)],
              offset: layout.offsets[Math.min(firstVisible, keys.length - 1)] - el.scrollTop,
            }
          : null;
    }
    previousKeys.current = keys;
  }, [keys, layout]);

  /**
   * Content that grew without the key list or the measured heights changing.
   *
   * The common case is a disclosure opening inside a row — "why didn't this
   * notify me" under a message — which makes the last row taller with nothing
   * this component's props announce. Checked on every commit for that reason:
   * there is no dependency to key it on, and the correction only ever moves a
   * reader who is already at the bottom, so a reader who has scrolled up is
   * never touched.
   */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const grew = el.scrollHeight > contentHeight.current;
    if (grew && pinned.current) el.scrollTop = el.scrollHeight;
    contentHeight.current = el.scrollHeight;
  });

  // ---------------------------------------------------------------------
  // The imperative handle: jump-to-message and the composer's "go to bottom"
  // ---------------------------------------------------------------------
  useImperativeHandle(
    handleRef,
    () => ({
      scrollToKey(key, opts) {
        const el = scrollerRef.current;
        const index = keys.indexOf(key);
        if (!el || index < 0) return false;
        const top = layout.offsets[index];
        const block = opts?.block ?? "center";
        scrollTo(
          block === "center"
            ? Math.max(0, top - el.clientHeight / 2 + layout.heights[index] / 2)
            : Math.max(0, top - 8),
        );
        return true;
      },
      scrollToBottom,
      isAtBottom,
    }),
    [keys, layout, scrollTo, scrollToBottom, isAtBottom],
  );

  // ---------------------------------------------------------------------
  // The window
  // ---------------------------------------------------------------------
  // No measured viewport means no window. Under jsdom every box is 0×0, and a
  // list that renders nothing there is indistinguishable from a broken one.
  const windowed = viewport > 0 && keys.length > 40;
  const start = windowed
    ? Math.max(0, firstIndexAt(layout.offsets, scrollTop - OVERSCAN_PX))
    : 0;
  const end = windowed
    ? Math.min(keys.length, firstIndexAt(layout.offsets, scrollTop + viewport + OVERSCAN_PX) + 1)
    : keys.length;

  const nearTopFired = useRef(false);
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
    if (el.scrollTop < NEAR_TOP_PX) {
      if (!nearTopFired.current) {
        nearTopFired.current = true;
        onNearTop?.();
      }
    } else {
      nearTopFired.current = false;
    }
  }, [onNearTop]);

  const visible: ReactNode[] = [];
  for (let i = start; i < end; i += 1) {
    visible.push(
      <div key={keys[i]} data-row-key={keys[i]} ref={rowRef}>
        {render(i)}
      </div>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      data-transcript-scroller=""
      role="log"
      aria-label={label}
      aria-live="polite"
      className={cn("chat-scroll min-h-0 flex-1", className)}
    >
      {leading}
      <div style={{ paddingTop: layout.offsets[start] ?? 0 }} />
      {visible}
      <div style={{ paddingTop: Math.max(0, layout.total - (layout.offsets[end] ?? 0)) }} />
    </div>
  );
}

/**
 * The index of the first row whose bottom is past `y`.
 *
 * Binary search over the prefix sums, so a jump into a ten-thousand-row
 * transcript costs fourteen comparisons rather than a walk.
 */
function firstIndexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid + 1] <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}
