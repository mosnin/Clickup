"use client";

import { useEffect, useRef, useState } from "react";

// Tracks which items in a list have changed since the last render, and
// keeps each "recent" id in the returned Set for `windowMs` (default
// 1.6s). Used to flash a subtle highlight on rows that updated under a
// teammate's cursor.
//
// Behavior contract:
//   - First render returns an empty Set. We don't claim everything is
//     "new" just because we hadn't seen it before.
//   - An item leaving + re-entering the list counts as a change.
//   - The hook is keyed on _id; the `version` is whatever scalar changes
//     when the row updates (we use _creationTime / completedAt / a
//     concatenation as needed).

export function useRecentlyChanged<T>(
  items: T[],
  getId: (item: T) => string,
  getVersion: (item: T) => string | number,
  windowMs: number = 1600,
): Set<string> {
  const [recent, setRecent] = useState<Set<string>>(() => new Set());
  const seenRef = useRef<Map<string, string | number> | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    const prev = seenRef.current;
    const next = new Map<string, string | number>();
    const becameRecent: string[] = [];

    for (const item of items) {
      const id = getId(item);
      const v = getVersion(item);
      next.set(id, v);
      if (prev !== null && prev.get(id) !== v) becameRecent.push(id);
    }

    seenRef.current = next;
    if (becameRecent.length === 0 || prev === null) return;

    setRecent((curr) => {
      const updated = new Set(curr);
      for (const id of becameRecent) updated.add(id);
      return updated;
    });

    for (const id of becameRecent) {
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setRecent((curr) => {
          if (!curr.has(id)) return curr;
          const next = new Set(curr);
          next.delete(id);
          return next;
        });
        timersRef.current.delete(id);
      }, windowMs);
      timersRef.current.set(id, timer);
    }
  }, [items, getId, getVersion, windowMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return recent;
}
