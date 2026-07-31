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

export function useQuery(ref: unknown): unknown {
  return galleryData[pathOf(ref)];
}

export function useMutation() {
  return async () => undefined;
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
