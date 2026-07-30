// Which space a dashboard path points at.
//
// Pure and separate from the hook so the mapping can be tested without a
// router: "does /dashboard/l/<id> belong to a space" is a question about the
// URL grammar, not about React.
//
// Deliberately *not* every route. A doc, a whiteboard and a page belong to a
// user or a workspace rather than to a space, and Home belongs to nothing.
// Those render the person's own look, which is the honest answer — there is no
// room to be in.

export type SpaceTarget = {
  kind: "space" | "project" | "list" | "task";
  id: string;
};

const ROUTES: { pattern: RegExp; kind: SpaceTarget["kind"] }[] = [
  { pattern: /^\/dashboard\/s\/([^/?#]+)/, kind: "space" },
  { pattern: /^\/dashboard\/p\/([^/?#]+)/, kind: "project" },
  // A task page carries its list in the path, and a list is one hop from the
  // space where a task is two, so the cheaper resolution is also the shorter
  // one. The "task" kind stays supported for surfaces that only know a task id.
  { pattern: /^\/dashboard\/l\/([^/?#]+)/, kind: "list" },
];

/** The space-shaped thing this path points at, or null for the rest of the app. */
export function spaceTargetForPath(pathname: string | null): SpaceTarget | null {
  if (!pathname) return null;
  for (const { pattern, kind } of ROUTES) {
    const match = pattern.exec(pathname);
    if (match) return { kind, id: match[1] };
  }
  return null;
}
