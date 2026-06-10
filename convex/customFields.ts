import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireListAccess } from "./_authz";

const typeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("dropdown"),
  v.literal("date"),
  v.literal("checkbox"),
);

const optionValidator = v.object({
  id: v.string(),
  label: v.string(),
  color: v.optional(v.string()),
});

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const list = await ctx.db.get(listId);
    if (!list) return [];
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return fields.sort((a, b) => a.position - b.position);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    name: v.string(),
    type: typeValidator,
    options: v.optional(v.array(optionValidator)),
  },
  handler: async (ctx, args) => {
    await requireListAccess(ctx, args.listId);
    if (args.type === "dropdown" && (!args.options || args.options.length === 0)) {
      throw new Error("Dropdown fields need at least one option");
    }
    const siblings = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    return await ctx.db.insert("customFields", {
      listId: args.listId,
      name: args.name,
      type: args.type,
      options: args.type === "dropdown" ? args.options : undefined,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { fieldId: v.id("customFields"), name: v.string() },
  handler: async (ctx, { fieldId, name }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) throw new Error("Field not found");
    await requireListAccess(ctx, field.listId);
    await ctx.db.patch(fieldId, { name });
  },
});

export const updateOptions = mutation({
  args: {
    fieldId: v.id("customFields"),
    options: v.array(optionValidator),
  },
  handler: async (ctx, { fieldId, options }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) throw new Error("Field not found");
    if (field.type !== "dropdown") {
      throw new Error("Only dropdown fields have options");
    }
    await requireListAccess(ctx, field.listId);
    await ctx.db.patch(fieldId, { options });
  },
});

export const remove = mutation({
  args: { fieldId: v.id("customFields") },
  handler: async (ctx, { fieldId }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) return;
    await requireListAccess(ctx, field.listId);

    // Cascade: delete all values for this field across every task in the list.
    const values = await ctx.db
      .query("taskFieldValues")
      .withIndex("by_field", (q) => q.eq("fieldId", fieldId))
      .collect();
    for (const v of values) await ctx.db.delete(v._id);

    await ctx.db.delete(fieldId);
  },
});
