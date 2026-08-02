// A Convex stand-in for the gallery.
//
// The gallery renders real dashboard surfaces, and a real surface talks to
// Convex. Rather than mock per-component, this answers every `useQuery` from
// one table of fixtures keyed by the function's dotted path — the same trick
// `tests/ui/harness.tsx` uses, and for the same reason: the components are
// pure functions of their query results, so handing them results is the
// honest way to see what they look like.

import * as React from "react";
import { getFunctionName } from "convex/server";

/** Fixtures by dotted path, set by the gallery before it renders. */
export const galleryData: Record<string, unknown> = {};

function pathProxy(prefix = ""): unknown {
  return new Proxy(
    { __path: prefix },
    {
      get(target, prop) {
        if (prop === "__path") return prefix;
        if (typeof prop !== "string") return undefined;
        return pathProxy(prefix ? `${prefix}.${prop}` : prop);
      },
    },
  );
}

export const anyApi = pathProxy();

/**
 * The dotted path of a function reference.
 *
 * The app imports the real generated `api`, which is Convex's own opaque
 * proxy — reading `__path` off it gets nothing. `getFunctionName` is the
 * supported way to ask, and it answers `"module:function"`, which this
 * normalises to the dotted form the fixtures are keyed by.
 */
function pathOf(ref: unknown): string {
  const own = (ref as { __path?: string })?.__path;
  if (typeof own === "string" && own) return own;
  try {
    return getFunctionName(ref as never).replace(":", ".");
  } catch {
    return "";
  }
}

/**
 * Answer a query.
 *
 * A fixture may be a VALUE or a FUNCTION of the arguments. The function form
 * exists because a page that draws nineteen panels draws them all through one
 * query, and a fixture that cannot see the arguments can only ever answer all
 * nineteen the same way — which means the empty state, the truncated state and
 * the "one number" state are three states no gallery page could ever hold at
 * once. Every one of those is a state that ships.
 *
 * The argument is the real one the component passes, so a fixture that
 * branches on it branches on the same vocabulary the resolver does.
 */
export function useQuery(ref: unknown, args?: unknown): unknown {
  const fixture = galleryData[pathOf(ref)];
  if (typeof fixture === "function") {
    return (fixture as (a: unknown) => unknown)(args);
  }
  return fixture;
}

/**
 * A mutation that does nothing, and — crucially — that can still be *built*.
 *
 * The real `useMutation` returns a callable carrying `.withOptimisticUpdate`,
 * and surfaces reach for it during render, not on click: Home's task list
 * calls it at the top of the component. A bare async function therefore threw
 * before anything painted, and the widget vanished from the screenshot while
 * the harness reported a shot taken. The stub has to match the SHAPE of the
 * thing, or it tests a page nobody runs.
 */
type GalleryMutation = ((...args: unknown[]) => Promise<undefined>) & {
  withOptimisticUpdate: (fn: unknown) => GalleryMutation;
};

/**
 * Mutations a fixture wants to actually HAPPEN, by dotted path.
 *
 * A mutation that resolves and changes nothing is fine for a screenshot and
 * wrong for anything that reconciles. Home writes its layout optimistically and
 * drops the draft the moment the write resolves — on the reasonable assumption
 * that the subscription has caught up — so against a black-hole stub every
 * layout change on Home snapped back a beat later, and a harness driving that
 * page would have reported the product broken when it was the harness that had
 * no memory.
 *
 * A handler here writes into `galleryData`, which the query stub reads on the
 * next render. That is the whole of "a backend that remembers", and it is what
 * lets a gate walk a surface rather than photograph it.
 */
export const galleryMutations: Record<string, (args: unknown) => void> = {};

export function useMutation(ref?: unknown): GalleryMutation {
  const path = ref === undefined ? "" : pathOf(ref);
  const fn = (async (args: unknown) => {
    galleryMutations[path]?.(args);
    return undefined;
  }) as GalleryMutation;
  fn.withOptimisticUpdate = () => fn;
  return fn;
}

export function useAction() {
  return async () => undefined;
}

export function useConvex() {
  return { query: async () => undefined };
}

export function usePaginatedQuery() {
  return { results: [], status: "Exhausted", loadMore: () => {} };
}

export function Authenticated({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
export function Unauthenticated() {
  return null;
}
export function AuthLoading() {
  return null;
}
export function ConvexProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
export class ConvexReactClient {}
