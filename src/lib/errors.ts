import { ConvexError } from "convex/values";

// The one place server refusals become toast copy. ConvexError.data is the
// only error payload Convex preserves in production (plain Error messages
// are redacted to "Server Error" on the wire), so prefer it; the regex
// fallback still extracts dev-mode messages from either error class.
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ConvexError) {
    const data: unknown = e.data;
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    return msg.split("\n")[0]?.trim() || fallback;
  }
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw
      .split(/Uncaught (?:Convex)?Error:/)
      .pop()
      ?.split("\n")[0]
      ?.trim() || fallback
  );
}
