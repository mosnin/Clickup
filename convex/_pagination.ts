// Opaque cursor helpers for agent/MCP list reads. Convex paginate() covers
// a single index query; a scope-wide walk is a sequence of those, so the
// cursor names the list we are in and the Convex cursor inside it.

export type ScopeCursor = {
  listOffset: number;
  continueCursor: string | null;
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
      typeof (parsed as ScopeCursor).listOffset === "number"
    ) {
      const c = parsed as ScopeCursor;
      return {
        listOffset: Math.max(0, Math.floor(c.listOffset)),
        continueCursor:
          typeof c.continueCursor === "string" ? c.continueCursor : null,
      };
    }
  } catch {
    // Hostile or stale cursors start over rather than throw.
  }
  return null;
}

export function pageLimit(requested: number | undefined, fallback: number, max: number): number {
  const n = requested ?? fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}
