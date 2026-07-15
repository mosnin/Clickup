// Local-time helpers for <input type="date"> round-trips.
//
// Date inputs speak "YYYY-MM-DD" in the user's local calendar. Converting a
// stored epoch through toISOString() renders the UTC day, which is off by
// one for anyone west of Greenwich in the evening (and east in the
// morning). These helpers keep both directions in local time.

// Epoch millis → "YYYY-MM-DD" in the user's local timezone.
export function toDateInputValue(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "YYYY-MM-DD" from a date input → epoch millis at local midnight.
// Returns undefined for an empty/cleared input.
export function fromDateInputValue(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).getTime();
}
