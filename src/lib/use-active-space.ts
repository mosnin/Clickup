"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { spaceTargetForPath } from "@/lib/space-route";
export type { SpaceTarget } from "@/lib/space-route";

// Which space the person is looking at, derived from the URL.
//
// Read from the route rather than tracked in state, because every surface that
// belongs to a space would otherwise have to remember to announce itself, and
// the one that forgot would silently render in the wrong space's colours. The
// URL already knows; it just needs resolving up the hierarchy, which the server
// does in one query.

export type ActiveSpace = {
  spaceId: string;
  name: string;
  color: string | null;
  theme: unknown;
  /** How this space draws its panels — src/lib/component-style.ts. */
  componentStyle: unknown;
  mayTheme: boolean;
  /** The scope this space lives in — what authored panels belong to. */
  scopeType: "user" | "workspace";
  scopeId: string;
};

/**
 * The active space, held across the gap while the next one loads.
 *
 * Without the hold, navigating between two themed spaces paints the default
 * look for one frame in between, which reads as the UI breaking rather than as
 * a transition. Holding the previous answer means exactly one morph, from the
 * old room straight into the new one.
 *
 * Leaving for somewhere that has no space clears immediately — that is not a
 * gap to cover, it is the answer.
 */
export function useActiveSpace(): ActiveSpace | null {
  const pathname = usePathname();
  const target = spaceTargetForPath(pathname);
  const remote = useQuery(
    api.appearance.spaceContext,
    target ? { kind: target.kind, id: target.id } : "skip",
  );

  const [held, setHeld] = useState<ActiveSpace | null>(null);
  // Tracked so a resolved-to-nothing answer (an id we can't see) clears the
  // hold instead of leaving the previous space's colours up forever.
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (!target) {
      answered.current = null;
      setHeld(null);
      return;
    }
    if (remote === undefined) return;
    answered.current = target.id;
    setHeld(remote ?? null);
  }, [remote, target?.id, target?.kind, target]);

  if (!target) return null;
  return held;
}
