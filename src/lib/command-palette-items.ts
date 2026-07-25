const CORE_ACTION_KEYS = new Set(["search-everything", "new-task"]);

/**
 * Caps the command palette without allowing workspace inventory to crowd out
 * its two core actions. Items already inside the cap keep their ranking; a
 * missing core action replaces the lowest-ranked non-core item.
 */
export function capCommandPaletteItems<T extends { key: string }>(
  items: T[],
  limit = 24,
): T[] {
  if (limit <= 0) return [];

  const visible = items.slice(0, limit);
  for (const key of CORE_ACTION_KEYS) {
    if (visible.some((item) => item.key === key)) continue;
    const coreItem = items.find((item) => item.key === key);
    if (!coreItem) continue;

    const replaceAt = visible.findLastIndex(
      (item) => !CORE_ACTION_KEYS.has(item.key),
    );
    if (replaceAt >= 0) visible.splice(replaceAt, 1);
    visible.push(coreItem);
  }
  return visible;
}
