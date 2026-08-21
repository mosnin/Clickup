import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireListAccess } from "./_authz";
import {
  assertRelationListInScope,
  fieldConfigValidator,
  fieldOptionValidator,
  fieldTypeValidator,
  isComputedType,
  normalizeFieldDefinition,
  usesOptions,
  type FieldConfig,
  type FieldOption,
  type FieldType,
} from "./_customFields";

// Per-list custom field definitions. The type union and every per-type
// rule live in _customFields.ts so the agent API (agentApi.createCustomField)
// enforces exactly the same contract — there is no second code path.

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return fields.sort((a, b) => a.position - b.position);
  },
});

/**
 * Shared definition writer. Reads the list's other fields so formulas and
 * rollups are checked against real references, then persists the normalized
 * options + config.
 */
async function siblingsOf(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
  excludeId?: Id<"customFields">,
): Promise<Doc<"customFields">[]> {
  const all = await ctx.db
    .query("customFields")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  return excludeId ? all.filter((f) => f._id !== excludeId) : all;
}

export const create = mutation({
  args: {
    listId: v.id("lists"),
    name: v.string(),
    type: fieldTypeValidator,
    options: v.optional(v.array(fieldOptionValidator)),
    config: v.optional(fieldConfigValidator),
  },
  handler: async (ctx, args) => {
    await requireListAccess(ctx, args.listId);
    const name = args.name.trim();
    if (!name) throw new ConvexError("Field name is required");

    const siblings = await siblingsOf(ctx, args.listId);
    const { options, config } = normalizeFieldDefinition({
      type: args.type,
      options: args.options,
      config: args.config,
      siblings,
      selfName: name,
    });
    if (config?.relationListId) {
      await requireListAccess(ctx, config.relationListId);
      await assertRelationListInScope(ctx, args.listId, config.relationListId);
    }

    return await ctx.db.insert("customFields", {
      listId: args.listId,
      name,
      type: args.type,
      options,
      config,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { fieldId: v.id("customFields"), name: v.string() },
  handler: async (ctx, { fieldId, name }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) throw new ConvexError("Field not found");
    await requireListAccess(ctx, field.listId);
    const next = name.trim();
    if (!next) throw new ConvexError("Field name is required");
    await ctx.db.patch(fieldId, { name: next });
  },
});

export const updateOptions = mutation({
  args: {
    fieldId: v.id("customFields"),
    options: v.array(fieldOptionValidator),
  },
  handler: async (ctx, { fieldId, options }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) throw new ConvexError("Field not found");
    if (!usesOptions(field.type)) {
      throw new ConvexError("Only dropdown and labels fields have options");
    }
    await requireListAccess(ctx, field.listId);
    const siblings = await siblingsOf(ctx, field.listId, fieldId);
    const normalized = normalizeFieldDefinition({
      type: field.type,
      options,
      config: field.config,
      siblings,
      selfId: fieldId,
      selfName: field.name,
    });
    await ctx.db.patch(fieldId, { options: normalized.options });

    // Values pointing at options that no longer exist would render as raw
    // ids forever — prune them so the data matches the definition.
    const validIds = new Set(options.map((o) => o.id));
    const values = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_field", (q) => q.eq("fieldId", fieldId))
      .collect();
    for (const row of values) {
      if (field.type === "dropdown") {
        if (row.textValue && !validIds.has(row.textValue)) {
          await ctx.db.delete(row._id);
        }
      } else {
        const kept = (row.optionIds ?? []).filter((id) => validIds.has(id));
        if (kept.length === (row.optionIds ?? []).length) continue;
        if (kept.length === 0) await ctx.db.delete(row._id);
        else await ctx.db.patch(row._id, { optionIds: kept });
      }
    }
  },
});

/**
 * Reconfigure a field in place (currency, precision, bounds, stars, the
 * formula, the rollup target…). The type itself is immutable: changing it
 * would leave every stored value in the wrong column, so callers delete and
 * recreate instead — and the error says so.
 */
export const updateConfig = mutation({
  args: {
    fieldId: v.id("customFields"),
    config: fieldConfigValidator,
  },
  handler: async (ctx, { fieldId, config }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) throw new ConvexError("Field not found");
    await requireListAccess(ctx, field.listId);
    const siblings = await siblingsOf(ctx, field.listId, fieldId);
    const normalized = normalizeFieldDefinition({
      type: field.type,
      options: field.options,
      config,
      siblings,
      selfId: fieldId,
      selfName: field.name,
    });
    if (normalized.config?.relationListId) {
      await requireListAccess(ctx, normalized.config.relationListId);
      await assertRelationListInScope(
        ctx,
        field.listId,
        normalized.config.relationListId,
      );
    }
    await ctx.db.patch(fieldId, { config: normalized.config });
  },
});

/** Persist a new left-to-right column order for a list's fields. */
export const reorder = mutation({
  args: {
    listId: v.id("lists"),
    orderedIds: v.array(v.id("customFields")),
  },
  handler: async (ctx, { listId, orderedIds }) => {
    await requireListAccess(ctx, listId);
    const fields = await siblingsOf(ctx, listId);
    const known = new Set(fields.map((f) => f._id as string));
    for (const id of orderedIds) {
      if (!known.has(id)) {
        throw new ConvexError("That field isn't on this list");
      }
    }
    let position = 0;
    for (const id of orderedIds) {
      await ctx.db.patch(id, { position: position++ });
    }
    // Anything the caller didn't mention keeps its relative order at the end.
    for (const field of fields.sort((a, b) => a.position - b.position)) {
      if (orderedIds.includes(field._id)) continue;
      await ctx.db.patch(field._id, { position: position++ });
    }
  },
});

export const remove = mutation({
  args: { fieldId: v.id("customFields") },
  handler: async (ctx, { fieldId }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) return;
    await requireListAccess(ctx, field.listId);

    // Refuse to strand a computed field: a formula or rollup that points at
    // this field would silently start reading blank.
    const siblings = await siblingsOf(ctx, field.listId, fieldId);
    for (const other of siblings) {
      if (!isComputedType(other.type)) continue;
      const rollup = other.config?.rollup;
      if (
        rollup &&
        (rollup.sourceFieldId === fieldId || rollup.relationFieldId === fieldId)
      ) {
        throw new ConvexError(
          `"${other.name}" rolls up "${field.name}" — delete or reconfigure it first`,
        );
      }
      if (
        other.type === "formula" &&
        (other.config?.formula ?? "")
          .toLowerCase()
          .includes(`{${field.name.trim().toLowerCase()}}`)
      ) {
        throw new ConvexError(
          `"${other.name}" uses "${field.name}" in its formula — update it first`,
        );
      }
    }

    // Cascade: delete all values for this field across every task in the list.
    const values = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_field", (q) => q.eq("fieldId", fieldId))
      .collect();
    for (const row of values) await ctx.db.delete(row._id);

    await ctx.db.delete(fieldId);
  },
});

// Re-exported so callers that already import from this module keep working.
export type { FieldConfig, FieldOption, FieldType };
