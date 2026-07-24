// View customization settings — the shared contract behind the "Customize
// view" panel (src/components/dashboard/view-customize-panel.tsx).
//
// Where the state lives:
//   1. The URL (`?vs=` for the toggles/choices, `?vf=` for the field list) —
//      so a copied link reproduces the exact view for whoever opens it, the
//      same way `?view=`, `?f=` and `?pri=` already work on the list page.
//   2. localStorage, per user-agent and per list (see use-view-settings.ts) —
//      so a bare link back to the project restores your own last setup.
//
// The URL is the source of truth whenever it carries either param; the
// stored copy is only the fallback. Only non-default values are serialized,
// so an untouched view keeps a clean URL.
//
// Server-side persistence would belong on `userSettings` (one row per user)
// as a `listViewSettings` array — see the note at the bottom of this file.
//
// This module is deliberately pure (no React, no Convex) so every view can
// import it, including ones owned by other surfaces (e.g. Table view reading
// the visible-field contract).

export type GroupBy =
  | "none"
  | "status"
  | "assignee"
  | "priority"
  | "due"
  | "milestone";

export type SubtaskMode = "collapsed" | "expanded" | "flat";

export type ViewSettings = {
  /** Keep status groups / Board columns visible when they hold no tasks. */
  emptyStatuses: boolean;
  /** Wrap long titles instead of truncating them to one line. */
  wrapText: boolean;
  /** Include tasks sitting in a closed-category status. */
  showClosed: boolean;
  /** Render the Space › Folder › List breadcrumb on each row/card. */
  showLocation: boolean;
  /** Label subtasks with their parent task's title. */
  showSubtaskParents: boolean;
  /** How rows are grouped (List view). */
  group: GroupBy;
  /** How subtasks are surfaced. */
  subtasks: SubtaskMode;
  /**
   * Ordered visible field keys. `null` means "the default set" — resolve it
   * with {@link resolveVisibleFields}, which appends the list's custom
   * fields. An empty array means "no metadata columns at all".
   */
  fields: string[] | null;
};

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  emptyStatuses: true,
  wrapText: false,
  // Defaults are deliberately "show everything, reorganize nothing": an
  // uncustomized project renders exactly as it did before this panel existed.
  showClosed: true,
  showLocation: false,
  showSubtaskParents: true,
  group: "none",
  subtasks: "collapsed",
  fields: null,
};

// ── Fields ───────────────────────────────────────────────────────────────
// Built-in field keys are short literals; a custom field is identified by
// its `customFields` document id, which never collides with these.

export const BUILTIN_FIELDS = [
  { key: "status", label: "Status" },
  { key: "assignees", label: "Assignees" },
  { key: "priority", label: "Priority" },
  // Table view always had a Start column; it needs a key here or honouring
  // "show exactly the selected fields" would silently delete it.
  { key: "start", label: "Start date" },
  { key: "due", label: "Due date" },
  { key: "points", label: "Estimate" },
] as const;

export type BuiltinFieldKey = (typeof BUILTIN_FIELDS)[number]["key"];

const BUILTIN_KEYS: readonly string[] = BUILTIN_FIELDS.map((f) => f.key);

/** The columns a view shows before anyone customizes it. */
export const DEFAULT_BUILTIN_FIELDS: readonly string[] = [
  "status",
  "priority",
  "due",
];

export function isBuiltinFieldKey(key: string): key is BuiltinFieldKey {
  return BUILTIN_KEYS.includes(key);
}

/**
 * The ordered field keys a view should render, given the list's custom
 * fields. Unknown/removed field ids are dropped so a stale link (or a stale
 * stored preference) can't ask for a column that no longer exists.
 */
export function resolveVisibleFields(
  settings: ViewSettings,
  customFieldIds: readonly string[],
): string[] {
  if (settings.fields === null) {
    return [...DEFAULT_BUILTIN_FIELDS, ...customFieldIds];
  }
  const known = new Set<string>([...BUILTIN_KEYS, ...customFieldIds]);
  const seen = new Set<string>();
  return settings.fields.filter((key) => {
    if (!known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every field a user can turn on for this list, in a stable canonical order:
 * the built-ins first, then the list's own custom fields.
 */
export function allFieldKeys(customFieldIds: readonly string[]): string[] {
  return [...BUILTIN_KEYS, ...customFieldIds];
}

// ── URL serialization ────────────────────────────────────────────────────
// `vs` is a dot-separated token list; `vf` is a dot-separated field list.
// Both use only characters URLSearchParams leaves untouched (alphanumerics
// plus `.` `-` `_` `*`), so the query string stays readable.

export const VIEW_SETTINGS_PARAM = "vs";
export const VIEW_FIELDS_PARAM = "vf";

/** Sentinel for "no metadata fields at all" — never a real field key. */
const NO_FIELDS = "0";

type BoolKey =
  | "emptyStatuses"
  | "wrapText"
  | "showClosed"
  | "showLocation"
  | "showSubtaskParents";

const BOOL_TOKENS: Record<string, BoolKey> = {
  e: "emptyStatuses",
  w: "wrapText",
  c: "showClosed",
  l: "showLocation",
  p: "showSubtaskParents",
};

const GROUPS: readonly GroupBy[] = [
  "none",
  "status",
  "assignee",
  "priority",
  "due",
  "milestone",
];

const SUBTASK_MODES: readonly SubtaskMode[] = [
  "collapsed",
  "expanded",
  "flat",
];

export const GROUP_OPTIONS: readonly { key: GroupBy; label: string }[] = [
  { key: "none", label: "None" },
  { key: "status", label: "Status" },
  { key: "assignee", label: "Assignee" },
  { key: "priority", label: "Priority" },
  { key: "due", label: "Due date" },
  { key: "milestone", label: "Milestone" },
];

export const SUBTASK_OPTIONS: readonly {
  key: SubtaskMode;
  label: string;
  hint: string;
}[] = [
  {
    key: "collapsed",
    label: "Collapsed",
    hint: "Subtasks stay tucked under their parent until you expand it.",
  },
  {
    key: "expanded",
    label: "Expanded",
    hint: "Every parent opens with its subtasks already showing.",
  },
  {
    key: "flat",
    label: "Flat",
    hint: "Subtasks are listed as rows of their own, alongside their parents.",
  },
];

/** Minimal shape shared by URLSearchParams and Next's ReadonlyURLSearchParams. */
export type ParamsLike = { get(name: string): string | null };

export function hasViewSettingsParams(params: ParamsLike): boolean {
  return (
    params.get(VIEW_SETTINGS_PARAM) !== null ||
    params.get(VIEW_FIELDS_PARAM) !== null
  );
}

export function parseViewSettings(params: ParamsLike): ViewSettings {
  const settings: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };

  for (const token of (params.get(VIEW_SETTINGS_PARAM) ?? "").split(".")) {
    if (!token) continue;
    if (token.startsWith("g-")) {
      const value = token.slice(2);
      if ((GROUPS as string[]).includes(value)) settings.group = value as GroupBy;
      continue;
    }
    if (token.startsWith("s-")) {
      const value = token.slice(2);
      if ((SUBTASK_MODES as string[]).includes(value)) {
        settings.subtasks = value as SubtaskMode;
      }
      continue;
    }
    const key = BOOL_TOKENS[token[0]];
    if (key && (token[1] === "0" || token[1] === "1")) {
      settings[key] = token[1] === "1";
    }
  }

  const rawFields = params.get(VIEW_FIELDS_PARAM);
  if (rawFields !== null) {
    settings.fields =
      rawFields === NO_FIELDS || rawFields === ""
        ? []
        : rawFields.split(".").filter(Boolean);
  }

  return settings;
}

/**
 * Writes the settings into `params` in place, deleting anything that matches
 * the defaults so an untouched view leaves no trace in the URL.
 */
export function writeViewSettingsToParams(
  params: URLSearchParams,
  settings: ViewSettings,
): URLSearchParams {
  const tokens: string[] = [];
  for (const [token, key] of Object.entries(BOOL_TOKENS)) {
    const value = settings[key];
    if (value !== DEFAULT_VIEW_SETTINGS[key]) {
      tokens.push(`${token}${value ? 1 : 0}`);
    }
  }
  if (settings.group !== DEFAULT_VIEW_SETTINGS.group) {
    tokens.push(`g-${settings.group}`);
  }
  if (settings.subtasks !== DEFAULT_VIEW_SETTINGS.subtasks) {
    tokens.push(`s-${settings.subtasks}`);
  }

  if (tokens.length) params.set(VIEW_SETTINGS_PARAM, tokens.join("."));
  else params.delete(VIEW_SETTINGS_PARAM);

  if (settings.fields === null) params.delete(VIEW_FIELDS_PARAM);
  else if (settings.fields.length === 0) {
    params.set(VIEW_FIELDS_PARAM, NO_FIELDS);
  } else params.set(VIEW_FIELDS_PARAM, settings.fields.join("."));

  return params;
}

/** True when anything differs from the out-of-the-box view. */
export function isCustomized(settings: ViewSettings): boolean {
  const params = writeViewSettingsToParams(new URLSearchParams(), settings);
  return params.toString().length > 0;
}

/**
 * Coerces an unknown blob (a localStorage payload, a server row) into a
 * valid ViewSettings, falling back field by field. Never throws.
 */
export function normalizeViewSettings(input: unknown): ViewSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const bool = (key: BoolKey) =>
    typeof raw[key] === "boolean"
      ? (raw[key] as boolean)
      : DEFAULT_VIEW_SETTINGS[key];
  const group =
    typeof raw.group === "string" && (GROUPS as string[]).includes(raw.group)
      ? (raw.group as GroupBy)
      : DEFAULT_VIEW_SETTINGS.group;
  const subtasks =
    typeof raw.subtasks === "string" &&
    (SUBTASK_MODES as string[]).includes(raw.subtasks)
      ? (raw.subtasks as SubtaskMode)
      : DEFAULT_VIEW_SETTINGS.subtasks;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.filter((f): f is string => typeof f === "string")
    : null;
  return {
    emptyStatuses: bool("emptyStatuses"),
    wrapText: bool("wrapText"),
    showClosed: bool("showClosed"),
    showLocation: bool("showLocation"),
    showSubtaskParents: bool("showSubtaskParents"),
    group,
    subtasks,
    fields,
  };
}

// ── Server persistence ───────────────────────────────────────────────────
// Per-user-per-list settings round-trip through Convex so they follow a user
// across devices: `userSettings.listViewSettings` (convex/schema.ts) is an
// array of `{ listId, settings }` where `settings` is exactly the `vs`/`vf`
// encoding produced above, written by `userSettings.setListViewSettings`.
// Because the server stores that string opaquely, adding a toggle here needs
// no backend change. The hook in use-view-settings.ts owns the precedence
// (URL → server → localStorage) and the debounced write-through.
