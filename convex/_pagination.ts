// Opaque cursor helpers for agent/MCP list reads. Convex allows only one
// `.paginate()` per query, so a scope-wide walk uses `.take()` per list and
// this cursor names the list we are in plus how far through its filtered
// rows we have already returned.

export type ScopeCursor = {
  listOffset: number;
  skip: number;
};

export function encodeCursor(value: ScopeCursor): string {
  return btoa(JSON.stringify(value));
}

export function decodeCursor(raw: string | undefined): ScopeCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "listOffset" in parsed &&
      typeof (parsed as { listOffset: unknown }).listOffset === "number"
    ) {
      const c = parsed as { listOffset: number; skip?: unknown };
      const skip =
        typeof c.skip === "number" && Number.isFinite(c.skip)
          ? Math.max(0, Math.floor(c.skip))
          : 0;
      return {
        listOffset: Math.max(0, Math.floor(c.listOffset)),
        skip,
      };
    }
  } catch {
    // Hostile or stale cursors start over rather than throw.
  }
  return null;
}

export function pageLimit(
  requested: number | undefined,
  fallback: number,
  max: number,
): number {
  const n = requested ?? fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export const LIST_SCAN_CAP = 2000;
