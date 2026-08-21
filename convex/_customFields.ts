import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canAccessTask, getSpaceForList } from "./_authz";

// Shared custom-field logic — the single source of truth for what a field
// type means, what a valid configuration looks like, what a valid value
// looks like, and how the computed types (formula / rollup / voting) are
// derived on read.
//
// Both the human mutations (convex/customFields.ts, convex/taskFieldValues.ts)
// and the key-authenticated agent surface (convex/agentApi.ts) call these,
// so a value an agent writes over MCP is validated exactly like one a human
// types into the table view. Everything thrown here is a ConvexError whose
// message tells the caller how to fix the call, because for agents that
// message IS the documentation.

export type FieldType = Doc<"customFields">["type"];
export type FieldConfig = NonNullable<Doc<"customFields">["config"]>;
export type FieldOption = { id: string; label: string; color?: string };

// ── Validators reused by every entry point ─────────────────────────────

export const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("long_text"),
  v.literal("number"),
  v.literal("money"),
  v.literal("dropdown"),
  v.literal("labels"),
  v.literal("date"),
  v.literal("checkbox"),
  v.literal("email"),
  v.literal("phone"),
  v.literal("url"),
  v.literal("location"),
  v.literal("rating"),
  v.literal("progress"),
  v.literal("people"),
  v.literal("files"),
  v.literal("relationship"),
  v.literal("rollup"),
  v.literal("formula"),
  v.literal("voting"),
);

export const fieldOptionValidator = v.object({
  id: v.string(),
  label: v.string(),
  color: v.optional(v.string()),
});

export const fieldConfigValidator = v.object({
  currency: v.optional(v.string()),
  precision: v.optional(v.number()),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  ratingMax: v.optional(v.number()),
  multiple: v.optional(v.boolean()),
  relationListId: v.optional(v.id("lists")),
  formula: v.optional(v.string()),
  rollup: v.optional(
    v.object({
      source: v.union(v.literal("subtasks"), v.literal("relationship")),
      op: v.union(v.literal("sum"), v.literal("avg"), v.literal("count")),
      sourceFieldId: v.optional(v.id("customFields")),
      relationFieldId: v.optional(v.id("customFields")),
    }),
  ),
});

export const fieldFileValidator = v.object({
  storageId: v.id("_storage"),
  name: v.string(),
  mimeType: v.string(),
  sizeBytes: v.number(),
});

export const fieldLocationValidator = v.object({
  label: v.string(),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
});

/** The wire shape `set` accepts — every column a value can land in. */
export const fieldValueArgs = {
  textValue: v.optional(v.string()),
  numberValue: v.optional(v.number()),
  booleanValue: v.optional(v.boolean()),
  dateValue: v.optional(v.number()),
  currency: v.optional(v.string()),
  optionIds: v.optional(v.array(v.string())),
  actorIds: v.optional(v.array(v.string())),
  taskIds: v.optional(v.array(v.id("tasks"))),
  location: v.optional(fieldLocationValidator),
  files: v.optional(v.array(fieldFileValidator)),
} as const;

export type FieldValueInput = {
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
  currency?: string;
  optionIds?: string[];
  actorIds?: string[];
  taskIds?: Id<"tasks">[];
  location?: { label: string; lat?: number; lng?: number };
  files?: {
    storageId: Id<"_storage">;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }[];
};

/**
 * A fully-normalized row body: every column explicitly set or cleared, so
 * `db.patch` wipes the columns this type doesn't use instead of leaving a
 * stale value behind from a previous type of write.
 */
export type FieldValuePatch = {
  textValue: string | undefined;
  numberValue: number | undefined;
  booleanValue: boolean | undefined;
  dateValue: number | undefined;
  currency: string | undefined;
  optionIds: string[] | undefined;
  actorIds: string[] | undefined;
  taskIds: Id<"tasks">[] | undefined;
  location: { label: string; lat?: number; lng?: number } | undefined;
  files:
    | {
        storageId: Id<"_storage">;
        name: string;
        mimeType: string;
        sizeBytes: number;
      }[]
    | undefined;
};

const EMPTY_PATCH: FieldValuePatch = {
  textValue: undefined,
  numberValue: undefined,
  booleanValue: undefined,
  dateValue: undefined,
  currency: undefined,
  optionIds: undefined,
  actorIds: undefined,
  taskIds: undefined,
  location: undefined,
  files: undefined,
};

// ── Type metadata ──────────────────────────────────────────────────────

/** Types whose value is derived on read and can never be written. */
export const COMPUTED_TYPES: FieldType[] = ["rollup", "formula"];

/** Types a formula or rollup can read a number out of. */
const NUMERIC_TYPES: FieldType[] = [
  "number",
  "money",
  "rating",
  "progress",
  "rollup",
  "formula",
  "voting",
];

export function isComputedType(type: FieldType): boolean {
  return COMPUTED_TYPES.includes(type);
}

export function isNumericType(type: FieldType): boolean {
  return NUMERIC_TYPES.includes(type);
}

/** Types that carry a user-managed `options` array. */
export function usesOptions(type: FieldType): boolean {
  return type === "dropdown" || type === "labels";
}

const MAX_TEXT = 2000;
const MAX_LONG_TEXT = 20000;
const MAX_MULTI = 50;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB, matching attachments
const MAX_FORMULA_CHARS = 500;
const DEFAULT_RATING_MAX = 5;

// ── Configuration validation ───────────────────────────────────────────

const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+]?[0-9 ().-]{5,32}$/;

/**
 * Validates (and normalizes) a field definition. Returns the options and
 * config to persist. Throws a ConvexError naming the fix when invalid.
 *
 * `siblings` are the other fields on the same list — needed so formulas and
 * rollups can be checked against real, numeric, non-cyclic references at
 * definition time instead of failing silently on every read.
 */
export function normalizeFieldDefinition(args: {
  type: FieldType;
  options?: FieldOption[];
  config?: Partial<FieldConfig>;
  siblings: Doc<"customFields">[];
  /** Set when reconfiguring, so a formula can't reference itself. */
  selfId?: Id<"customFields">;
  selfName?: string;
}): { options: FieldOption[] | undefined; config: FieldConfig | undefined } {
  const { type, siblings } = args;
  const config: FieldConfig = { ...(args.config ?? {}) };

  // Options only exist on the two option-backed types.
  let options: FieldOption[] | undefined;
  if (usesOptions(type)) {
    options = args.options ?? [];
    if (options.length === 0) {
      throw new ConvexError(
        `${type === "labels" ? "Labels" : "Dropdown"} fields need at least one option (pass options: [{ id, label }]).`,
      );
    }
    const seen = new Set<string>();
    for (const opt of options) {
      if (!opt.id.trim() || !opt.label.trim()) {
        throw new ConvexError("Every option needs a non-empty id and label");
      }
      if (seen.has(opt.id)) {
        throw new ConvexError(`Duplicate option id "${opt.id}"`);
      }
      seen.add(opt.id);
    }
  } else if (args.options && args.options.length > 0) {
    throw new ConvexError(
      `Options only apply to dropdown and labels fields, not ${type}`,
    );
  }

  if (config.currency !== undefined) {
    config.currency = config.currency.trim().toUpperCase();
    if (!CURRENCY_RE.test(config.currency)) {
      throw new ConvexError(
        `"${config.currency}" isn't a 3-letter currency code (e.g. USD, EUR)`,
      );
    }
  }
  if (type === "money" && config.currency === undefined) config.currency = "USD";

  if (config.precision !== undefined) {
    if (!Number.isInteger(config.precision) || config.precision < 0 || config.precision > 4) {
      throw new ConvexError("precision must be a whole number from 0 to 4");
    }
  }
  if (
    config.min !== undefined &&
    config.max !== undefined &&
    config.min > config.max
  ) {
    throw new ConvexError("min can't be greater than max");
  }
  if (config.ratingMax !== undefined) {
    if (
      !Number.isInteger(config.ratingMax) ||
      config.ratingMax < 2 ||
      config.ratingMax > 10
    ) {
      throw new ConvexError("ratingMax must be a whole number from 2 to 10");
    }
  }
  if (type === "rating" && config.ratingMax === undefined) {
    config.ratingMax = DEFAULT_RATING_MAX;
  }

  if (type === "formula") {
    const src = (config.formula ?? "").trim();
    if (!src) {
      throw new ConvexError(
        'Formula fields need a formula, e.g. "{Hours} * {Rate}". Reference other numeric fields on this list by name in braces.',
      );
    }
    if (src.length > MAX_FORMULA_CHARS) {
      throw new ConvexError(
        `Formulas are limited to ${MAX_FORMULA_CHARS} characters`,
      );
    }
    const node = parseFormula(src);
    const byName = new Map(
      siblings.map((f) => [f.name.trim().toLowerCase(), f]),
    );
    for (const ref of formulaRefs(node)) {
      const key = ref.trim().toLowerCase();
      if (args.selfName && key === args.selfName.trim().toLowerCase()) {
        throw new ConvexError(`A formula can't reference itself ({${ref}})`);
      }
      const target = byName.get(key);
      if (!target) {
        throw new ConvexError(
          `No field named "${ref}" on this list. Available: ${
            siblings.map((f) => f.name).join(", ") || "(none yet)"
          }`,
        );
      }
      if (!isNumericType(target.type)) {
        throw new ConvexError(
          `"${ref}" is a ${target.type} field — formulas can only reference numeric fields (number, money, rating, progress, voting, rollup, formula)`,
        );
      }
    }
    config.formula = src;
  } else {
    delete config.formula;
  }

  if (type === "rollup") {
    const rollup = config.rollup;
    if (!rollup) {
      throw new ConvexError(
        'Rollup fields need a rollup config, e.g. { source: "subtasks", op: "sum", sourceFieldId: "<numeric field id>" }',
      );
    }
    if (rollup.op !== "count") {
      if (!rollup.sourceFieldId) {
        throw new ConvexError(
          `A "${rollup.op}" rollup needs sourceFieldId — the numeric field it adds up`,
        );
      }
      const source = siblings.find((f) => f._id === rollup.sourceFieldId);
      // A subtask rollup reads a field on the SAME list (subtasks live in
      // the same list); a relationship rollup may point across lists, so we
      // only insist the field exists locally for the subtask case.
      if (rollup.source === "subtasks") {
        if (!source) {
          throw new ConvexError("sourceFieldId isn't a field on this list");
        }
        if (!isNumericType(source.type)) {
          throw new ConvexError(
            `sourceFieldId points at a ${source.type} field — rollups sum numeric fields`,
          );
        }
        if (source._id === args.selfId) {
          throw new ConvexError("A rollup can't roll up itself");
        }
      }
    }
    if (rollup.source === "relationship") {
      if (!rollup.relationFieldId) {
        throw new ConvexError(
          "A relationship rollup needs relationFieldId — the relationship field holding the linked tasks",
        );
      }
      const rel = siblings.find((f) => f._id === rollup.relationFieldId);
      if (!rel) {
        throw new ConvexError("relationFieldId isn't a field on this list");
      }
      if (rel.type !== "relationship") {
        throw new ConvexError(
          `relationFieldId points at a ${rel.type} field — it must be a relationship field`,
        );
      }
    }
  } else {
    delete config.rollup;
  }

  if (type !== "relationship") delete config.relationListId;
  if (type !== "rating") delete config.ratingMax;
  if (type !== "money") delete config.currency;

  // Drop an all-empty config rather than storing `{}`.
  const hasConfig = Object.values(config).some((x) => x !== undefined);
  return { options, config: hasConfig ? config : undefined };
}

// ── Value validation ───────────────────────────────────────────────────

function round(value: number, precision: number | undefined): number {
  if (precision === undefined) return value;
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

function requireFinite(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new ConvexError(`${label} must be a number`);
  return n;
}

function clampCheck(n: number, config: FieldConfig | undefined, name: string) {
  if (config?.min !== undefined && n < config.min) {
    throw new ConvexError(`${name} must be at least ${config.min}`);
  }
  if (config?.max !== undefined && n > config.max) {
    throw new ConvexError(`${name} must be at most ${config.max}`);
  }
}

function text(input: FieldValueInput, name: string, max: number): string {
  if (input.textValue === undefined) {
    throw new ConvexError(`${name} takes textValue (a string)`);
  }
  const t = input.textValue.trim();
  if (t.length > max) {
    throw new ConvexError(`${name} is limited to ${max} characters`);
  }
  return t;
}

function dedupe(values: string[], name: string): string[] {
  const out = [...new Set(values.map((s) => s.trim()).filter(Boolean))];
  if (out.length > MAX_MULTI) {
    throw new ConvexError(`${name} accepts at most ${MAX_MULTI} entries`);
  }
  return out;
}

/**
 * Turns whatever the caller sent into the exact row body for this field's
 * type, or throws a ConvexError explaining what to send instead. Returns
 * `null` when the input means "no value" — callers delete the row.
 *
 * `voterId` is the acting principal (clerkId or agent id); voting fields use
 * it so `booleanValue` means "my vote", never "everyone's votes".
 */
export function normalizeFieldValue(
  field: Doc<"customFields">,
  input: FieldValueInput,
  opts: { voterId?: string; existing?: Doc<"taskFieldValues"> | null } = {},
): FieldValuePatch | null {
  const config = field.config;
  const name = `"${field.name}"`;

  if (isComputedType(field.type)) {
    throw new ConvexError(
      `${name} is a ${field.type} field — its value is computed from other fields and can't be set directly`,
    );
  }

  switch (field.type) {
    case "text": {
      const t = text(input, name, MAX_TEXT);
      return t ? { ...EMPTY_PATCH, textValue: t } : null;
    }
    case "long_text": {
      const t = text(input, name, MAX_LONG_TEXT);
      return t ? { ...EMPTY_PATCH, textValue: t } : null;
    }
    case "email": {
      const t = text(input, name, 320).toLowerCase();
      if (!t) return null;
      if (!EMAIL_RE.test(t)) {
        throw new ConvexError(`"${t}" isn't a valid email address`);
      }
      return { ...EMPTY_PATCH, textValue: t };
    }
    case "phone": {
      const t = text(input, name, 32);
      if (!t) return null;
      if (!PHONE_RE.test(t)) {
        throw new ConvexError(
          `"${t}" isn't a valid phone number (digits, spaces, and + ( ) - . only)`,
        );
      }
      return { ...EMPTY_PATCH, textValue: t };
    }
    case "url": {
      const t = text(input, name, 2048);
      if (!t) return null;
      let parsed: URL;
      try {
        parsed = new URL(t);
      } catch {
        throw new ConvexError(
          `"${t}" isn't a valid URL — include the scheme, e.g. https://example.com`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ConvexError("Website fields accept http:// or https:// URLs");
      }
      return { ...EMPTY_PATCH, textValue: parsed.toString() };
    }
    case "number": {
      if (input.numberValue === undefined) {
        throw new ConvexError(`${name} takes numberValue (a number)`);
      }
      const n = round(
        requireFinite(input.numberValue, name),
        config?.precision,
      );
      clampCheck(n, config, name);
      return { ...EMPTY_PATCH, numberValue: n };
    }
    case "money": {
      if (input.numberValue === undefined) {
        throw new ConvexError(
          `${name} takes numberValue (the amount) and optionally currency`,
        );
      }
      const n = round(
        requireFinite(input.numberValue, name),
        config?.precision ?? 2,
      );
      clampCheck(n, config, name);
      let currency = (input.currency ?? config?.currency ?? "USD")
        .trim()
        .toUpperCase();
      if (!CURRENCY_RE.test(currency)) {
        throw new ConvexError(
          `"${currency}" isn't a 3-letter currency code (e.g. USD, EUR)`,
        );
      }
      if (config?.currency && currency !== config.currency) {
        // A field pinned to one currency shouldn't silently hold another.
        currency = config.currency;
      }
      return { ...EMPTY_PATCH, numberValue: n, currency };
    }
    case "rating": {
      if (input.numberValue === undefined) {
        throw new ConvexError(`${name} takes numberValue (the star count)`);
      }
      const max = config?.ratingMax ?? DEFAULT_RATING_MAX;
      const n = requireFinite(input.numberValue, name);
      if (n === 0) return null;
      if (!Number.isInteger(n) || n < 1 || n > max) {
        throw new ConvexError(
          `${name} takes a whole number from 1 to ${max} (0 clears it)`,
        );
      }
      return { ...EMPTY_PATCH, numberValue: n };
    }
    case "progress": {
      if (input.numberValue === undefined) {
        throw new ConvexError(`${name} takes numberValue (0–100)`);
      }
      const n = Math.round(requireFinite(input.numberValue, name));
      if (n < 0 || n > 100) {
        throw new ConvexError(`${name} takes a percentage from 0 to 100`);
      }
      return { ...EMPTY_PATCH, numberValue: n };
    }
    case "checkbox": {
      if (input.booleanValue === undefined) {
        throw new ConvexError(`${name} takes booleanValue (true or false)`);
      }
      return input.booleanValue
        ? { ...EMPTY_PATCH, booleanValue: true }
        : null;
    }
    case "date": {
      if (input.dateValue === undefined) {
        throw new ConvexError(`${name} takes dateValue (epoch milliseconds)`);
      }
      const d = requireFinite(input.dateValue, name);
      return { ...EMPTY_PATCH, dateValue: d };
    }
    case "dropdown": {
      const id = (input.textValue ?? input.optionIds?.[0] ?? "").trim();
      if (!id) return null;
      const opt = (field.options ?? []).find((o) => o.id === id);
      if (!opt) {
        throw new ConvexError(
          `"${id}" isn't an option on ${name}. Valid ids: ${
            (field.options ?? []).map((o) => o.id).join(", ") || "(none)"
          }`,
        );
      }
      return { ...EMPTY_PATCH, textValue: opt.id };
    }
    case "labels": {
      const ids = dedupe(input.optionIds ?? [], name);
      if (ids.length === 0) return null;
      const valid = new Set((field.options ?? []).map((o) => o.id));
      for (const id of ids) {
        if (!valid.has(id)) {
          throw new ConvexError(
            `"${id}" isn't an option on ${name}. Valid ids: ${
              [...valid].join(", ") || "(none)"
            }`,
          );
        }
      }
      return { ...EMPTY_PATCH, optionIds: ids };
    }
    case "location": {
      const loc = input.location;
      if (!loc) {
        const fallback = (input.textValue ?? "").trim();
        if (!fallback) {
          throw new ConvexError(
            `${name} takes location: { label, lat?, lng? }`,
          );
        }
        return { ...EMPTY_PATCH, location: { label: fallback.slice(0, 300) } };
      }
      const label = loc.label.trim();
      if (!label) return null;
      if (loc.lat !== undefined && (loc.lat < -90 || loc.lat > 90)) {
        throw new ConvexError("Latitude must be between -90 and 90");
      }
      if (loc.lng !== undefined && (loc.lng < -180 || loc.lng > 180)) {
        throw new ConvexError("Longitude must be between -180 and 180");
      }
      return {
        ...EMPTY_PATCH,
        location: { label: label.slice(0, 300), lat: loc.lat, lng: loc.lng },
      };
    }
    case "people": {
      const ids = dedupe(input.actorIds ?? [], name);
      if (ids.length === 0) return null;
      if (config?.multiple === false && ids.length > 1) {
        throw new ConvexError(`${name} holds a single person`);
      }
      return { ...EMPTY_PATCH, actorIds: ids };
    }
    case "relationship": {
      const ids = [...new Set(input.taskIds ?? [])];
      if (ids.length === 0) return null;
      if (ids.length > MAX_MULTI) {
        throw new ConvexError(`${name} links at most ${MAX_MULTI} tasks`);
      }
      if (config?.multiple === false && ids.length > 1) {
        throw new ConvexError(`${name} links a single task`);
      }
      return { ...EMPTY_PATCH, taskIds: ids };
    }
    case "files": {
      const files = input.files ?? [];
      if (files.length === 0) return null;
      if (files.length > MAX_FILES) {
        throw new ConvexError(`${name} holds at most ${MAX_FILES} files`);
      }
      for (const f of files) {
        if (!f.name.trim()) throw new ConvexError("Every file needs a name");
        if (f.sizeBytes > MAX_FILE_BYTES) {
          throw new ConvexError("Files are limited to 50 MB");
        }
      }
      return {
        ...EMPTY_PATCH,
        files: files.map((f) => ({ ...f, name: f.name.trim().slice(0, 200) })),
      };
    }
    case "voting": {
      const voterId = opts.voterId;
      if (!voterId) throw new ConvexError("Voting needs an acting principal");
      if (input.booleanValue === undefined) {
        throw new ConvexError(
          `${name} is a voting field — pass booleanValue: true to add your vote, false to remove it`,
        );
      }
      const current = opts.existing?.actorIds ?? [];
      const next = input.booleanValue
        ? [...new Set([...current, voterId])]
        : current.filter((id) => id !== voterId);
      if (next.length === 0) return null;
      return { ...EMPTY_PATCH, actorIds: next };
    }
    default:
      // Computed types are refused above; this keeps the switch total.
      throw new ConvexError(`${name} can't be written directly`);
  }
}

/**
 * Async half of value validation: confirms people/relationship references
 * point at principals and tasks inside the same boundary, so a field value
 * can't be used to smuggle a foreign id (or probe for one) into a list.
 */
export async function assertValueReferences(
  ctx: QueryCtx | MutationCtx,
  field: Doc<"customFields">,
  patch: FieldValuePatch,
): Promise<void> {
  if (field.type === "people" && patch.actorIds) {
    const list = await ctx.db.get(field.listId);
    if (!list) throw new ConvexError("Orphan field");
    const space = await getSpaceForList(ctx, list);
    if (!space) throw new ConvexError("Orphan list");
    for (const actorId of patch.actorIds) {
      if (!(await actorBelongsToSpace(ctx, space, actorId))) {
        throw new ConvexError(
          `"${actorId}" isn't a member or agent here — use list_members / the people picker for valid ids`,
        );
      }
    }
  }
  if (field.type === "relationship" && patch.taskIds) {
    const targetListId = field.config?.relationListId;
    const sourceList = await ctx.db.get(field.listId);
    const sourceSpace = sourceList
      ? await getSpaceForList(ctx, sourceList)
      : null;
    for (const taskId of patch.taskIds) {
      const target = await ctx.db.get(taskId);
      if (!target) throw new ConvexError(`Linked task ${taskId} not found`);
      if (targetListId && target.listId !== targetListId) {
        throw new ConvexError(
          `"${field.name}" only links tasks from its configured list`,
        );
      }
      if (!targetListId && target.listId !== field.listId) {
        // Unconfigured relationship fields stay inside their own list, so a
        // link can never reach a list the reader can't see.
        throw new ConvexError(
          `"${field.name}" links tasks in this list. Configure relationListId to link across projects.`,
        );
      }
      const targetList = await ctx.db.get(target.listId);
      const targetSpace = targetList
        ? await getSpaceForList(ctx, targetList)
        : null;
      if (
        !sourceSpace ||
        !targetSpace ||
        sourceSpace.parentType !== targetSpace.parentType ||
        sourceSpace.parentId !== targetSpace.parentId
      ) {
        throw new ConvexError(
          `"${field.name}" can only link tasks in the same workspace`,
        );
      }
    }
  }
}

/**
 * A relationship field's target list must live in the same tenant as the
 * field. Without this, relationListId could point at another workspace
 * (or another person's personal space) and the value/rollup paths would
 * read across that boundary.
 */
export async function assertRelationListInScope(
  ctx: QueryCtx | MutationCtx,
  sourceListId: Id<"lists">,
  relationListId: Id<"lists">,
): Promise<void> {
  const source = await ctx.db.get(sourceListId);
  const target = await ctx.db.get(relationListId);
  if (!source || !target) throw new ConvexError("Related list not found");
  const sourceSpace = await getSpaceForList(ctx, source);
  const targetSpace = await getSpaceForList(ctx, target);
  if (!sourceSpace || !targetSpace) throw new ConvexError("Orphan list");
  if (
    sourceSpace.parentType !== targetSpace.parentType ||
    sourceSpace.parentId !== targetSpace.parentId
  ) {
    throw new ConvexError(
      "A relationship field can only link lists in the same workspace",
    );
  }
}

async function actorBelongsToSpace(
  ctx: QueryCtx | MutationCtx,
  space: Doc<"spaces">,
  actorId: string,
): Promise<boolean> {
  if (space.parentType === "user") {
    if (actorId === space.parentId) return true;
  } else {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", actorId)
          .eq("workspaceId", space.parentId as Id<"workspaces">),
      )
      .unique();
    if (membership) return true;
  }
  // Agents are principals too — an agent id is a valid "person" wherever the
  // agent is scoped.
  const agents = await ctx.db
    .query("agents")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", space.parentType).eq("parentId", space.parentId),
    )
    .collect();
  return agents.some((a) => a._id === actorId);
}

// ── Formula: a tiny arithmetic parser (never eval) ─────────────────────

export type FormulaNode =
  | { kind: "num"; value: number }
  | { kind: "ref"; name: string }
  | { kind: "neg"; arg: FormulaNode }
  | {
      kind: "bin";
      op: "+" | "-" | "*" | "/";
      left: FormulaNode;
      right: FormulaNode;
    };

type Token =
  | { k: "num"; v: number }
  | { k: "ref"; v: string }
  | { k: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i + 1);
      if (end === -1) throw new ConvexError("Unclosed { in formula");
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new ConvexError("Empty {} reference in formula");
      out.push({ k: "ref", v: name });
      i = end + 1;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) {
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) {
        throw new ConvexError(`"${src.slice(i, j)}" isn't a number`);
      }
      out.push({ k: "num", v: num });
      i = j;
      continue;
    }
    if ("+-*/()".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new ConvexError(
      `Unexpected "${c}" in formula. Only numbers, {Field name} references, + - * / and parentheses are allowed.`,
    );
  }
  return out;
}

/** Parses an arithmetic formula. Throws ConvexError on anything unparseable. */
export function parseFormula(src: string): FormulaNode {
  const tokens = tokenize(src);
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }
  function eatOp(op: string): boolean {
    const t = peek();
    if (t && t.k === "op" && t.v === op) {
      pos++;
      return true;
    }
    return false;
  }
  function parseExpr(): FormulaNode {
    let left = parseTerm();
    for (;;) {
      if (eatOp("+")) left = { kind: "bin", op: "+", left, right: parseTerm() };
      else if (eatOp("-")) {
        left = { kind: "bin", op: "-", left, right: parseTerm() };
      } else return left;
    }
  }
  function parseTerm(): FormulaNode {
    let left = parseFactor();
    for (;;) {
      if (eatOp("*")) {
        left = { kind: "bin", op: "*", left, right: parseFactor() };
      } else if (eatOp("/")) {
        left = { kind: "bin", op: "/", left, right: parseFactor() };
      } else return left;
    }
  }
  function parseFactor(): FormulaNode {
    if (eatOp("-")) return { kind: "neg", arg: parseFactor() };
    if (eatOp("+")) return parseFactor();
    const t = peek();
    if (!t) throw new ConvexError("Formula ends unexpectedly");
    if (t.k === "num") {
      pos++;
      return { kind: "num", value: t.v };
    }
    if (t.k === "ref") {
      pos++;
      return { kind: "ref", name: t.v };
    }
    if (t.v === "(") {
      pos++;
      const inner = parseExpr();
      if (!eatOp(")")) throw new ConvexError("Missing ) in formula");
      return inner;
    }
    throw new ConvexError(`Unexpected "${t.v}" in formula`);
  }

  if (tokens.length === 0) throw new ConvexError("Formula is empty");
  const node = parseExpr();
  if (pos !== tokens.length) {
    const t = tokens[pos];
    throw new ConvexError(
      `Unexpected "${t.k === "op" ? t.v : String(t.v)}" after the end of the formula`,
    );
  }
  return node;
}

export function formulaRefs(node: FormulaNode): string[] {
  switch (node.kind) {
    case "num":
      return [];
    case "ref":
      return [node.name];
    case "neg":
      return formulaRefs(node.arg);
    case "bin":
      return [...formulaRefs(node.left), ...formulaRefs(node.right)];
  }
}

/**
 * Evaluates a parsed formula. `lookup` resolves a field name to a number;
 * a missing/blank reference makes the whole expression null (rather than
 * silently reading as zero), and division by zero yields null too.
 */
export function evalFormula(
  node: FormulaNode,
  lookup: (name: string) => number | null,
): number | null {
  switch (node.kind) {
    case "num":
      return node.value;
    case "ref":
      return lookup(node.name);
    case "neg": {
      const a = evalFormula(node.arg, lookup);
      return a === null ? null : -a;
    }
    case "bin": {
      const a = evalFormula(node.left, lookup);
      const b = evalFormula(node.right, lookup);
      if (a === null || b === null) return null;
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? null : a / b;
      }
    }
  }
}

// ── Derived values (formula / rollup / voting count) ───────────────────

export type ComputedValue = { fieldId: Id<"customFields">; value: number | null };

/**
 * Computes every derived field for one task. Returns one entry per
 * computed-or-counted field (formula, rollup, voting), so callers can merge
 * derived numbers into their read without a second round trip.
 */
export async function computeDerivedValues(
  ctx: QueryCtx | MutationCtx,
  task: Doc<"tasks">,
  fields: Doc<"customFields">[],
  storedValues: Doc<"taskFieldValues">[],
): Promise<ComputedValue[]> {
  const stored = new Map(storedValues.map((v) => [v.fieldId as string, v]));
  const byId = new Map(fields.map((f) => [f._id as string, f]));
  const byName = new Map(
    fields.map((f) => [f.name.trim().toLowerCase(), f]),
  );
  const memo = new Map<string, number | null>();

  // Rollups read other tasks, so they're resolved first (async), then
  // formulas fold over the resulting numbers synchronously.
  for (const field of fields) {
    if (field.type !== "rollup") continue;
    memo.set(field._id, await resolveRollup(ctx, task, field, byId));
  }

  function numberOf(field: Doc<"customFields">, depth: number): number | null {
    const cached = memo.get(field._id);
    if (cached !== undefined) return cached;
    if (depth > 8) return null; // cycle guard
    let result: number | null = null;
    if (field.type === "formula") {
      memo.set(field._id, null); // break cycles while we recurse
      try {
        const node = parseFormula(field.config?.formula ?? "");
        result = evalFormula(node, (name) => {
          const target = byName.get(name.trim().toLowerCase());
          if (!target || target._id === field._id) return null;
          return numberOf(target, depth + 1);
        });
      } catch {
        result = null; // a formula that no longer parses reads as blank
      }
    } else if (field.type === "voting") {
      result = stored.get(field._id)?.actorIds?.length ?? 0;
    } else {
      const row = stored.get(field._id);
      result = row?.numberValue ?? null;
    }
    memo.set(field._id, result);
    return result;
  }

  const out: ComputedValue[] = [];
  for (const field of fields) {
    if (field.type === "formula" || field.type === "rollup") {
      out.push({ fieldId: field._id, value: numberOf(field, 0) });
    } else if (field.type === "voting") {
      out.push({
        fieldId: field._id,
        value: stored.get(field._id)?.actorIds?.length ?? 0,
      });
    }
  }
  return out;
}

async function resolveRollup(
  ctx: QueryCtx | MutationCtx,
  task: Doc<"tasks">,
  field: Doc<"customFields">,
  byId: Map<string, Doc<"customFields">>,
): Promise<number | null> {
  const rollup = field.config?.rollup;
  if (!rollup) return null;

  let targetIds: Id<"tasks">[] = [];
  if (rollup.source === "subtasks") {
    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", task._id))
      .collect();
    targetIds = subtasks.map((s) => s._id);
  } else {
    if (!rollup.relationFieldId) return null;
    const relRow = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", task._id).eq("fieldId", rollup.relationFieldId!),
      )
      .unique();
    targetIds = relRow?.taskIds ?? [];
  }

  const identity = await ctx.auth.getUserIdentity();
  const visibleIds: Id<"tasks">[] = [];
  for (const id of targetIds) {
    if (
      identity &&
      !(await canAccessTask(ctx, id, identity.subject))
    ) {
      continue;
    }
    visibleIds.push(id);
  }
  if (rollup.op === "count") return visibleIds.length;
  const sourceFieldId = rollup.sourceFieldId;
  if (!sourceFieldId) return null;
  const sourceField = byId.get(sourceFieldId);

  const numbers: number[] = [];
  for (const id of visibleIds) {
    const row = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_task_and_field", (q) =>
        q.eq("taskId", id).eq("fieldId", sourceFieldId),
      )
      .unique();
    if (sourceField?.type === "voting") {
      numbers.push(row?.actorIds?.length ?? 0);
    } else if (row?.numberValue !== undefined) {
      numbers.push(row.numberValue);
    }
  }
  if (numbers.length === 0) return rollup.op === "sum" ? 0 : null;
  const sum = numbers.reduce((a, b) => a + b, 0);
  return rollup.op === "sum" ? sum : sum / numbers.length;
}

// ── Read-side shaping (shared by the human and agent surfaces) ──────────

/** The value of one field on one task, in a shape both UIs and agents read. */
export function fieldValueSummary(
  field: Doc<"customFields">,
  row: Doc<"taskFieldValues"> | undefined,
  computed: number | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fieldId: field._id,
    name: field.name,
    type: field.type,
  };
  switch (field.type) {
    case "formula":
    case "rollup":
      return { ...base, value: computed ?? null, computed: true };
    case "voting":
      return {
        ...base,
        votes: row?.actorIds?.length ?? 0,
        voterIds: row?.actorIds ?? [],
      };
    case "labels":
      return {
        ...base,
        optionIds: row?.optionIds ?? [],
        labels: (row?.optionIds ?? []).map(
          (id) => field.options?.find((o) => o.id === id)?.label ?? id,
        ),
      };
    case "dropdown":
      return {
        ...base,
        optionId: row?.textValue ?? null,
        label:
          field.options?.find((o) => o.id === row?.textValue)?.label ?? null,
      };
    case "people":
      return { ...base, actorIds: row?.actorIds ?? [] };
    case "relationship":
      return { ...base, taskIds: row?.taskIds ?? [] };
    case "files":
      return { ...base, files: row?.files ?? [] };
    case "location":
      return { ...base, location: row?.location ?? null };
    case "money":
      return {
        ...base,
        amount: row?.numberValue ?? null,
        currency: row?.currency ?? field.config?.currency ?? "USD",
      };
    case "number":
    case "rating":
    case "progress":
      return { ...base, value: row?.numberValue ?? null };
    case "checkbox":
      return { ...base, value: row?.booleanValue ?? false };
    case "date":
      return { ...base, value: row?.dateValue ?? null };
    default:
      return { ...base, value: row?.textValue ?? null };
  }
}
