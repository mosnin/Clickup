// Sidebar tree: `personal` is the default (named Personal, else first).
// `personalSpaces` is every user-scoped space. Older fixtures only set
// `personal`; fall back so they keep working.

export function userSpacesFromTree<T>(tree: {
  personal: T | null | undefined;
  personalSpaces?: T[] | null;
}): T[] {
  if (tree.personalSpaces && tree.personalSpaces.length > 0) {
    return tree.personalSpaces;
  }
  return tree.personal ? [tree.personal] : [];
}
