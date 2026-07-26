"use client";

import { useEffect, useState } from "react";

/**
 * A clock that re-renders on an interval.
 *
 * Exists because of a specific class of bug: presence is derived as
 * `Date.now() - lastSeenAt < WINDOW`, and that expression inside a `useMemo`
 * keyed on the query result only re-evaluates when the data changes. Coming
 * online works by accident (the heartbeat writes the row, so the query updates)
 * — going offline never fires at all, because nothing writes when an agent
 * simply stops. The dot stays green until something unrelated happens.
 *
 * Passing this value into the dependency list makes the derivation honest.
 *
 * The interval is deliberately coarse. Presence windows are minutes wide, so a
 * 15-second tick is more than enough resolution and costs one render.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
