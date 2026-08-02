import { coherePanel } from "@/lib/panel-intent";
import { normalizePanel, type PanelDef, type PanelShape } from "@/lib/panel";

// What a built-in panel is asking, said in the query vocabulary.
//
// ── The finding this file records ──
//
// **Built-in widgets do not carry a query.** Neither registry has one. An entry
// in `WIDGETS` (src/app/dashboard/page.tsx) or in `PROJECT_WIDGETS`
// (dashboard/project-screen/widgets.tsx) is `{ id, title, span, render }`, and
// every `render` is a bespoke component holding its own hand-written Convex
// query — `homeOverview.get`, `myWork.listForCurrent`,
// `projects.rollupsForProject`, `events.forProject`. So "mint a panel from the
// built-in's own query" cannot be done by reading one anywhere. The question
// has to be *stated*, and the only interesting question is which built-ins have
// a statement at all.
//
// Three of Home's six do not, and squinting does not fix them:
//
//   - **stats** is four questions in one strip (my open / due today / overdue /
//     agents online). A panel answers one.
//   - **projects** reads projects with health, progress and a target date.
//     There is no `projects` source in the vocabulary — deliberately, see
//     data-stream.ts — so there is nothing to say.
//   - **today** is "my open tasks that are overdue OR due today". `DueFilter`
//     offers `overdue` and `today` as separate values and no union of them, so
//     the closest statement selects a different set of tasks. A control that
//     silently changes which records a panel is about is worse than one that
//     stays greyed out.
//
// Three do, and **none of them is byte-identical to what the built-in draws** —
// which is the other half of the finding, and the part that decides how the
// control has to behave:
//
//   - Home's widgets aggregate across EVERY scope the reader can see
//     (`homeOverview` walks the personal space and every workspace). A panel
//     resolves against ONE scope, because `dataStream.resolve` takes one. A
//     minted panel on Home therefore counts the personal space only.
//   - **agents**: the built-in shows the agents that are online; the `agents`
//     source lists them all carrying an online/offline flag, which is what
//     makes the question drawable as a donut at all.
//   - **activity**: the built-in counts completions per day over the last 7.
//     The vocabulary buckets by `completed_day` happily, but `filter.window` on
//     tasks is matched against `_creationTime` rather than the completion — so
//     stating "last 7 days" here would quietly mean "tasks CREATED in the last
//     7 days, bucketed by the day they were finished", a different answer that
//     looks like the right one. (`PANEL_PRESETS.burn` already carries that
//     pair; it is not this change's to fix.) The window is left off rather than
//     stated wrongly, so the chart runs over completion history.
//
// That residual gap is why the shelf using this renders the candidate with the
// real `<Panel>` over real data before anything is minted, instead of the
// invented `SPECIMEN` series the style shelves use. A specimen drawn from made-
// up numbers cannot show a difference that exists only in the data, and this is
// exactly the case where the difference IS the data. Nothing here claims the
// minted panel equals the built-in — the reader is looking at it when they
// choose.

/**
 * The Home built-ins whose question the closed vocabulary can state.
 *
 * Keyed by the widget id in `WIDGETS`. Absent means "no honest statement" — see
 * the note above for which three and why — and the studio keeps saying the
 * shape is fixed for those, because it is.
 *
 * Stored as `unknown` and normalized on read, exactly like every other panel
 * definition in the product: these go through the same `normalizePanel` an
 * agent-authored row does, so a key misspelled here degrades the same way and
 * `tests/built-in-panel.test.ts` catches it rather than a reader discovering a
 * silently different chart.
 */
export const HOME_PANEL_QUESTIONS: Record<string, unknown> = {
  activity: {
    title: "Recent activity",
    query: {
      from: "tasks",
      // Every task, not the open ones: a chart of completions that filtered to
      // open tasks would be a chart of zero.
      filter: { status: "any" },
      dimension: "completed_day",
      measure: "completed",
      limit: 30,
    },
    shape: "column",
  },
  live: {
    title: "Live",
    query: { from: "activity", dimension: "created_day", limit: 8 },
    shape: "column",
    fields: ["actor", "when"],
  },
  agents: {
    title: "Agents",
    query: { from: "agents", dimension: "status", measure: "count" },
    shape: "donut",
    fields: ["status", "task"],
  },
};

/**
 * The question a built-in asks, as a panel definition, or null if it has none.
 *
 * Normalized on the way out for the same reason every other definition is: the
 * renderer is going to normalize it anyway, and a lookup that returned the raw
 * literal would let the studio offer shapes against a `from` the resolver would
 * have replaced.
 */
export function builtInPanelQuestion(
  widgetId: string,
  table: Record<string, unknown> = HOME_PANEL_QUESTIONS,
): PanelDef | null {
  const raw = Object.prototype.hasOwnProperty.call(table, widgetId)
    ? table[widgetId]
    : undefined;
  return raw === undefined ? null : normalizePanel(raw);
}

/**
 * The definition a shape pick mints from a built-in.
 *
 * `coherePanel` rather than `normalizePanel` alone: this is somebody actively
 * choosing, which is the one place the difference between "legal" and "what
 * they meant" is allowed to matter. A chart grouped by nothing is legal and is
 * one grey ring.
 */
export function mintFromBuiltIn(
  question: PanelDef,
  shape: PanelShape,
): PanelDef {
  return coherePanel(normalizePanel({ ...question, shape }), question);
}
