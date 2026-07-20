// Public intake forms: tokenized per-list forms whose submissions become
// tasks. The manage-side functions (listForList/create/update/remove) are
// Clerk-authenticated and go through the usual list hierarchy check.
// getPublic/submitPublic are unauthenticated — /f/[token] is a capability
// URL, not a login-gated route — so they must never leak anything beyond
// the fields a visitor is meant to see, and never accept a listId/token
// they didn't already have.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireListAccess } from "./_authz";
import { createTaskCore } from "./tasks";

// Same "Convex mutations have no CSPRNG" tradeoff as invites.ts: this
// gates form submission (spammable, not sensitive), is revocable via
// `enabled`, and per-form abuse is bounded by the write below.
function randomToken(): string {
  return Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 10),
  ).join("");
}

const MAX_FORMS_PER_LIST = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 5000;

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

// ── Manage-side (Clerk-authenticated) ───────────────────────────────────

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    await requireListAccess(ctx, listId);
    return await ctx.db
      .query("forms")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
  },
});

export const create = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: async (ctx, { listId, title }) => {
    const { identity } = await requireListAccess(ctx, listId);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Title is required");

    const existing = await ctx.db
      .query("forms")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    if (existing.length >= MAX_FORMS_PER_LIST) {
      throw new Error(`A list can have at most ${MAX_FORMS_PER_LIST} forms`);
    }

    return await ctx.db.insert("forms", {
      listId,
      token: randomToken(),
      title: trimmed,
      enabled: true,
      createdByClerkId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    formId: v.id("forms"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    askDescription: v.optional(v.boolean()),
    askPriority: v.optional(v.boolean()),
    askEmail: v.optional(v.boolean()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");
    await requireListAccess(ctx, form.listId);

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const trimmed = args.title.trim();
      if (!trimmed) throw new Error("Title is required");
      patch.title = trimmed;
    }
    if (args.description !== undefined) {
      patch.description = args.description ?? undefined;
    }
    if (args.askDescription !== undefined) {
      patch.askDescription = args.askDescription;
    }
    if (args.askPriority !== undefined) {
      patch.askPriority = args.askPriority;
    }
    if (args.askEmail !== undefined) {
      patch.askEmail = args.askEmail;
    }
    if (args.enabled !== undefined) {
      patch.enabled = args.enabled;
    }
    await ctx.db.patch(args.formId, patch);
  },
});

export const remove = mutation({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    const form = await ctx.db.get(formId);
    if (!form) return;
    await requireListAccess(ctx, form.listId);
    await ctx.db.delete(formId);
  },
});

// ── Public surface (no auth — /f/[token]) ───────────────────────────────

export const getPublic = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!form || !form.enabled) return null;
    // Only the fields a visitor needs to render the form — never listId,
    // createdByClerkId, token, or submissionCount.
    return {
      title: form.title,
      description: form.description,
      askDescription: form.askDescription,
      askPriority: form.askPriority,
      askEmail: form.askEmail,
    };
  },
});

export const submitPublic = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!form || !form.enabled) {
      throw new Error("This form is closed");
    }

    const title = args.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error(
        `Title must be between 1 and ${MAX_TITLE_LENGTH} characters`,
      );
    }

    const submittedDescription = form.askDescription
      ? args.description?.trim()
      : undefined;
    if (
      submittedDescription &&
      submittedDescription.length > MAX_DESCRIPTION_LENGTH
    ) {
      throw new Error(
        `Description must be under ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }

    const priority =
      form.askPriority && args.priority ? args.priority : undefined;

    let description = submittedDescription || undefined;
    const email = form.askEmail ? args.email?.trim() : undefined;
    if (email) {
      const line = `Submitted by: ${email}`;
      description = description ? `${description}\n\n${line}` : line;
    }

    const taskId = await createTaskCore(
      ctx,
      {
        listId: form.listId,
        title,
        description,
        priority,
      },
      {
        type: "system",
        id: "form",
        name: form.title.slice(0, 40) || "Form",
      },
    );

    await ctx.db.patch(form._id, {
      submissionCount: (form.submissionCount ?? 0) + 1,
    });

    return { taskId };
  },
});
