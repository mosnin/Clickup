// In-process cap on /api/mcp. Per-agent budgets do not stop unauthenticated
// key-guessing load. This is a second line after Vercel Firewall — a single
// warm lambda's memory, not a global counter.

const WINDOW_MS = 60_000;
const LIMIT = 60;

type Bucket = { window: number; count: number };

const buckets = new Map<string, Bucket>();

function windowId(now: number): number {
  return Math.floor(now / WINDOW_MS);
}

export function mcpClientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Returns false when the caller should receive 429. */
export function allowMcpRequest(key: string, now = Date.now()): boolean {
  const window = windowId(now);
  const existing = buckets.get(key);
  if (!existing || existing.window !== window) {
    buckets.set(key, { window, count: 1 });
    // Bound the map so a unique-IP flood cannot grow it forever.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (v.window !== window) buckets.delete(k);
      }
    }
    return true;
  }
  if (existing.count >= LIMIT) return false;
  existing.count += 1;
  return true;
}
