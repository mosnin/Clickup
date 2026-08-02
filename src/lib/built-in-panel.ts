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
// The project screen is the same exercise over a different registry, and it
// comes out at one of eleven — see `projectPanelQuestions` below, including the
// trap that disqualifies the one other candidate.
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
 * The project screen's built-ins, for one project.
 *
 * A function rather than a table because the only honest statement here carries
 * the project's own id: a panel resolves against a SCOPE (a user or a
 * workspace), and a project is neither — `filter.scopeTo{Kind,Id}` is what
 * narrows a scope-wide query down to one project's lists.
 *
 * ── Why exactly one of eleven ──
 *
 * `PROJECT_WIDGETS` has eleven entries and ten of them have no question:
 *
 *   - **about / status / owner / target-date / notes** edit a field on the
 *     project record. They are controls, not readings; there is no set of
 *     records to draw.
 *   - **lists** is the project's lists. There is no `lists` source — and
 *     "tasks grouped by list" is a different question wearing the same word.
 *   - **plan** is open questions, **agent-stream** is live runs, **pages** is
 *     the pages *attached* to this project. None of the three has a source: the
 *     `pages` source reads a whole scope's pages, which is a different set.
 *   - **activity** is the one that looks expressible and is not, and the reason
 *     is worth recording because it is invisible from the pure layer: the
 *     `scopeTo` filter is honoured **only for `from: "tasks"`**. Every other
 *     source is answered by `resolveOther` in convex/dataStream.ts, which never
 *     reads it. So `{ from: "activity", scopeToKind: "project" }` normalizes,
 *     renders, and quietly shows the entire scope's activity instead of this
 *     project's — the `today` failure again: the nearest statement selects a
 *     different set of records, and a chart that is wrong about *which* records
 *     is worse than no chart.
 *
 * That leaves **progress**, which does narrow, because it reads tasks.
 *
 * ── What progress says, and what it does not ──
 *
 * The built-in reads `projects.rollupsForProject` and shows one percentage:
 * completed ÷ total across every list whose `parentType` is this project. The
 * statement below selects exactly that set of records — `rollupsForProject`
 * ranges `lists.by_parent(project, id)` and the resolver filters
 * `l.parentType === "project" && l.parentId === scopeToId`, which are the same
 * lists — and draws its composition: how many tasks stand in each status.
 *
 * That is the same relationship `agents` has to its built-in above (the card
 * shows who is online; the panel shows everyone, carrying online/offline), and
 * it is the relationship a chart has to a percentage: the fraction the built-in
 * prints is the complete slice over the whole ring, so nothing is lost and
 * nothing is invented. The measure is `count` rather than `completion_rate`
 * deliberately — "share complete, by status" is 100% or 0% in every bucket,
 * which is the degenerate chart this control exists not to produce.
 *
 * The dimension is stated rather than left to `coherePanel` for the same
 * reason. Coherence picks a source's first grouping when a chart has none; here
 * that guess would be the whole answer, and a guess nobody wrote down is a
 * guess nobody can check.
 */
export function projectPanelQuestions(
  projectId: string,
): Record<string, unknown> {
  return {
    progress: {
      title: "Progress",
      query: {
        from: "tasks",
        // Every task, not the open ones: a chart of what is finished that
        // filtered out finished work is a chart of zero.
        filter: { status: "any", scopeToKind: "project", scopeToId: projectId },
        dimension: "status",
        measure: "count",
      },
      shape: "donut",
    },
  };
}

/**
 * The question a project built-in asks, or null.
 *
 * The narrowing is re-read off the normalized definition rather than trusted,
 * and that check is the whole point of this wrapper. `normalizeQuery` cleans
 * `scopeToId` against a character class and drops **both** halves of the pair
 * when either fails — so an id this build cannot express does not produce a
 * refused panel, it produces a panel about the entire workspace with a title
 * reading "Progress". Answering null keeps the control saying the shape is
 * fixed, which is the truth in that case.
 */
export function projectPanelQuestion(
  widgetId: string,
  projectId: string,
): PanelDef | null {
  if (!projectId) return null;
  const def = builtInPanelQuestion(widgetId, projectPanelQuestions(projectId));
  if (!def) return null;
  const { scopeToKind, scopeToId } = def.query.filter;
  if (scopeToKind !== "project" || scopeToId !== projectId) return null;
  return def;
}

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
 * The widget inside a `customizable()` selection id, if it is on this grid.
 *
 * The id is `<gridId>:<widgetId>` — written by `EditableGrid`. Split on the
 * FIRST colon only: an authored panel's widget id carries one of its own
 * (`custom:<id>`), and splitting on the last (or on all of them) hands back
 * something that resolves to nothing, which reads as a control that did not
 * work rather than as a parsing bug.
 */
export function widgetIdFromSelection(
  selectionId: string | null,
  gridId: string | null,
): string | null {
  if (!selectionId || !gridId) return null;
  const cut = selectionId.indexOf(":");
  if (cut === -1) return null;
  if (selectionId.slice(0, cut) !== gridId) return null;
  return selectionId.slice(cut + 1) || null;
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
