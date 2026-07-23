// CSV import: rows become tasks via the shared task cores.
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireListAccess } from "./_authz";
import { createTaskCore } from "./tasks";
import type { Actor } from "./_agentAuth";

// One call imports at most this many rows — the client chunks larger CSVs
// into multiple calls (see import-dialog.tsx).
const MAX_ROWS_PER_CALL = 500;
const MAX_TITLE_LENGTH = 300;

const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

const IMPORT_ACTOR: Actor = { type: "system", id: "import", name: "CSV import" };

// How many distinct unmatched status names to echo back to the client —
// enough to spot a typo/casing mismatch without dumping an unbounded list.
const MAX_UNMATCHED_STATUS_NAMES = 5;

// Bulk-creates tasks from parsed CSV rows (client-parsed — see
// import-dialog.tsx for the ClickUp-export and generic-CSV column mapping).
// Routes through createTaskCore so imported tasks fire task_created
// automations, emit events, and get indexed for search exactly like any
// other task creation.
export const importTasks = mutation({
  args: {
    listId: v.id("lists"),
    rows: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        priority: v.optional(v.string()),
        dueDate: v.optional(v.number()),
        statusName: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { listId, rows }) => {
    if (rows.length > MAX_ROWS_PER_CALL) {
      throw new Error(
        `Too many rows in one import call (${rows.length}); send at most ${MAX_ROWS_PER_CALL} per call.`,
      );
    }

    await requireListAccess(ctx, listId);

    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    const statusByName = new Map(
      statuses.map((s) => [s.name.trim().toLowerCase(), s._id]),
    );

    let created = 0;
    let skipped = 0;
    let unmatchedStatusCount = 0;
    const unmatchedStatusNames = new Set<string>();

    for (const row of rows) {
      const title = row.title.trim().slice(0, MAX_TITLE_LENGTH);
      if (!title) {
        skipped++;
        continue;
      }

      const normalizedPriority = row.priority?.trim().toLowerCase();
      const priority =
        normalizedPriority && VALID_PRIORITIES.has(normalizedPriority)
          ? (normalizedPriority as "urgent" | "high" | "normal" | "low")
          : undefined;

      const trimmedStatusName = row.statusName?.trim();
      const statusId = trimmedStatusName
        ? statusByName.get(trimmedStatusName.toLowerCase())
        : undefined;
      if (trimmedStatusName && statusId === undefined) {
        unmatchedStatusCount++;
        if (unmatchedStatusNames.size < MAX_UNMATCHED_STATUS_NAMES) {
          unmatchedStatusNames.add(trimmedStatusName);
        }
      }

      const dueDate =
        row.dueDate !== undefined && Number.isFinite(row.dueDate)
          ? row.dueDate
          : undefined;

      await createTaskCore(
        ctx,
        {
          listId,
          title,
          description: row.description,
          statusId,
          priority,
          dueDate,
        },
        IMPORT_ACTOR,
      );
      created++;
    }

    return {
      created,
      skipped,
      unmatchedStatusCount,
      unmatchedStatusNames: Array.from(unmatchedStatusNames),
    };
  },
});
