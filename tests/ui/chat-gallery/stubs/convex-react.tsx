// A Convex stand-in for the Chat gallery.
//
// The shell is a pure function of its query results, so handing it results is
// the honest way to see what it looks like — the alternative is a hand-built
// lookalike, which is a picture of a design rather than the design, and drifts
// the moment the real one changes.
//
// Keyed by `getFunctionName`, which answers `"module:function"` for both the
// generated `api` proxy and a `makeFunctionReference` — and the channel query
// is the second kind, because `convex/buzz/*` is not in the checked-in api
// stub yet.

import { getFunctionName } from "convex/server";

/** Fixtures by `"module:function"`, set by the gallery before it renders. */
export const galleryData: Record<string, unknown> = {};

type Ref = Parameters<typeof getFunctionName>[0];

export function useQuery(ref: Ref, args?: unknown) {
  if (args === "skip") return undefined;
  return galleryData[getFunctionName(ref)];
}

export function useMutation() {
  return async () => undefined;
}

export function useAction() {
  return async () => undefined;
}

export function useConvex() {
  return null;
}
