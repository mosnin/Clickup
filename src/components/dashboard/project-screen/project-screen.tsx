"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { EASE } from "@/components/motion";
import { api } from "@convex/_generated/api";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { morphLayout, wake } from "@/lib/anime";
import {
  addWidget,
  describeLayoutChange,
  insertWidget,
  normalizeLayout,
  replaceWidget,
  screenKey,
  unusedWidgets,
  type ScreenLayout,
} from "@/lib/screen-layout";
import { OnlyWhenList } from "@/components/appearance/only-when";
import {
  EditableGrid,
  TrayTile,
  type EditableTile,
} from "@/components/dashboard/screen/editable-grid";
import {
  DEFAULT_PROJECT_LAYOUT,
  PROJECT_WIDGET_IDS,
  widgetById,
  type ProjectWidgetContext,
} from "./widgets";
import { Panel } from "@/components/dashboard/panel";
import { PanelBuilder } from "@/components/dashboard/panel-builder";
import { PanelProposal } from "@/components/dashboard/panel-proposal";
import {
  describePanel,
  isMetricShape,
  normalizePanel,
  panelIdFromWidgetId,
  panelWidgetId,
} from "@/lib/panel";
import { useOfferMintablePanels } from "@/components/appearance/mintable-panels";
import { projectPanelQuestion } from "@/lib/built-in-panel";

// A project screen, arranged by the person reading it.
//
// The editing model lives in `EditableGrid`, which behaves like a phone's home
// screen: hold a panel until the screen wobbles, then move it. This file only
// supplies what the panels *are* and where the arrangement is stored — the right
// split, because "how do I rearrange things" should be answered once for the
// whole product rather than reinvented per surface.

const GRID_ID = "project-screen-grid";

export function ProjectScreen(ctx: ProjectWidgetContext) {
  const key = screenKey("project", ctx.project._id);
  const stored = useQuery(api.screens.layoutFor, { screenKey: key });
  const saveLayout = useMutation(api.screens.saveLayout);
  const { toast } = useToast();
  const removePanel = useMutation(api.uiComponents.remove);
  /** Panels hidden pending an undo window — deleted only when it closes. */
  const [deleting, setDeleting] = useState<string[]>([]);

  // Panels this person authored. Merged into the registry the same way custom
  // skills merge with built-in ones: the screen doesn't care which is which.
  const scope = ctx.scope;
  const customQuery = useQuery(api.uiComponents.listForScope, scope);
  // Held stable: `?? []` mints a new array every render, which would make the
  // layout memo below recompute on every render and re-derive every tile.
  const custom = useMemo(() => customQuery ?? [], [customQuery]);
  const customById = useMemo(
    () => new Map(custom.map((c) => [c.componentId as string, c])),
    [custom],
  );
  const availableIds = useMemo(
    () => [
      ...PROJECT_WIDGET_IDS,
      ...custom.map((c) => panelWidgetId(c.componentId as string)),
    ],
    [custom],
  );

  // `null` from the server means "never arranged", which is not the same as an
  // arranged layout that happens to be empty — someone who cleared the screen
  // should keep a clear screen rather than get the defaults back.
  const ownLayout = useMemo<ScreenLayout>(() => {
    if (stored === undefined || stored === null) return DEFAULT_PROJECT_LAYOUT;
    return normalizeLayout(stored.layout, availableIds);
  }, [stored, availableIds]);

  // ── A suggestion from an agent ──
  //
  // Previewing swaps the proposed layout in as what the grid renders — the
  // same grid, morphed, not a mockup beside it — and nothing is written until
  // Accept. The preview is honest because it IS the result.
  const proposals = useQuery(api.screens.proposalsFor, { screenKey: key });
  const resolveProposal = useMutation(api.screens.resolveProposal);
  const [previewingProposal, setPreviewingProposal] = useState<string | null>(
    null,
  );
  const proposal = (proposals ?? [])[0] ?? null;
  const proposedLayout = useMemo<ScreenLayout | null>(
    () =>
      proposal
        ? normalizeLayout(proposal.layout, availableIds)
        : null,
    [availableIds, proposal],
  );
  const previewing =
    proposal !== null &&
    proposedLayout !== null &&
    previewingProposal === proposal.proposalId;
  const baseLayout = previewing && proposedLayout ? proposedLayout : ownLayout;

  function resolve(accept: boolean) {
    if (!proposal) return;
    setPreviewingProposal(null);
    // Accepting from preview: the grid is already showing the result, so the
    // resolution lands without a second reflow. Dismissing from preview morphs
    // back to your own arrangement.
    if (!accept && previewing) {
      morphLayout(`#${GRID_ID}`, () => {});
    }
    void resolveProposal({
      proposalId: proposal.proposalId as Parameters<
        typeof resolveProposal
      >[0]["proposalId"],
      accept,
    }).catch((e) =>
      toast(errorMessage(e, "Couldn't resolve the suggestion"), {
        kind: "error",
      }),
    );
  }

  /** What the grid draws: yours, or an agent's proposal while it is previewed. */
  const layout = baseLayout;

  const persist = useCallback(
    (next: ScreenLayout, opts?: { droppedAt?: number }) => {
      // While previewing a suggestion the grid renders the proposal; an edit
      // made in that state would silently save the agent's layout as yours.
      // Accepting is the only way a proposal becomes your arrangement.
      //
      // The matching rule for a panel arriving on a condition is NOT here any
      // more, and deliberately: it moved into `EditableGrid`, which is the only
      // thing that knows a panel has been offered and not yet accepted. A guard
      // restated per caller is a guard the next surface forgets.
      if (previewingProposal !== null) return;
      void saveLayout({ screenKey: key, layout: next }).catch((e) =>
        toast(errorMessage(e, "Couldn't save the arrangement"), {
          kind: "error",
        }),
      );
      if (opts?.droppedAt !== undefined) {
        // The grid settling around where the panel landed: confirmation that the
        // drop registered *and* which neighbours moved because of it.
        const grid = document.getElementById(GRID_ID);
        if (grid) {
          wake(Array.from(grid.querySelectorAll("[data-tile]")), opts.droppedAt);
        }
      }
    },
    [key, previewingProposal, saveLayout, toast],
  );

  // Offer this screen's built-ins to the studio's chart chapter.
  //
  // Without this the control was present and inert on every project page —
  // exactly the failure Home's half of this fixed, one screen along. The
  // mechanism is general; what is screen-specific is the three things only a
  // screen knows: which grid it is, where a minted panel is stored, and where
  // in ITS layout the built-in was standing.
  //
  // `projectId` rather than a static table because a project is not a scope:
  // the question has to carry the id that narrows a scope-wide query down to
  // this project's lists. Ten of the eleven widgets answer null — see
  // `projectPanelQuestions` for each one's reason.
  useOfferMintablePanels({
    gridId: GRID_ID,
    scope,
    questionFor: (widgetId) => projectPanelQuestion(widgetId, ctx.project._id),
    // Straight through `persist`, so a swap obeys the same rule every other
    // edit here does — including refusing to write while an agent's proposed
    // layout is being previewed, which would otherwise save the agent's
    // arrangement as yours on the way past.
    replace: (widgetId, componentId) =>
      morphLayout(`#${GRID_ID}`, () =>
        persist(replaceWidget(layout, widgetId, panelWidgetId(componentId))),
      ),
  });

  // Every tile this screen can draw, placed or not.
  //
  // It used to be derived from `layout.widgets`, which made "what is on the
  // screen" and "what the screen can draw" the same list — invisible until the
  // grid had to preview a panel the layout did not contain yet. An unplaced
  // tile's `content` is an element that is never mounted, so the whole set
  // costs nothing.
  const tiles = useMemo<EditableTile[]>(
    () =>
      availableIds.flatMap((id): EditableTile[] => {
        const w = layout.widgets.find((x) => x.id === id) ?? {
          id,
          span: 1 as const,
        };
        const customId = panelIdFromWidgetId(w.id);
        if (customId) {
          const row = customById.get(customId);
          if (!row) return [];
          // Read through the panel model rather than the old component one:
          // it understands both shapes (see `liftLegacy`) and it is what the
          // renderer draws, so the title and height agree with what appears.
          const def = normalizePanel(row.definition);
          return [
            {
              id: w.id,
              span: w.span,
              title: def.title,
              // A user-authored panel can be any width; it was written to be
              // whatever its author wanted rather than to a designed size.
              minSpan: 1 as const,
              maxSpan: 3 as const,
              rows: (isMetricShape(def.shape) ? 1 : 2) as 1 | 2,
              content: (
                <Panel
                  definition={row.definition}
                  scopeType={scope.scopeType}
                  scopeId={scope.scopeId}
                  // Scoped to the screen as well as the panel: the same panel
                  // on two screens is two places you look, and "since I last
                  // looked" is a fact about the looking.
                  panelId={`${GRID_ID}:${w.id}`}
                />
              ),
            },
          ];
        }
        const widget = widgetById(w.id);
        if (!widget) return [];
        return [
          {
            id: w.id,
            span: w.span,
            title: widget.title,
            minSpan: widget.minSpan,
            maxSpan: widget.maxSpan,
            rows: widget.rows,
            content: widget.render(ctx),
          },
        ];
      }),
    [availableIds, ctx, customById, layout.widgets, scope],
  );

  const unplaced = unusedWidgets(layout, availableIds);

  const diff =
    proposal && proposedLayout
      ? describeLayoutChange(ownLayout, proposedLayout)
      : null;
  const diffSentence = diff
    ? [
        diff.added.length > 0 && `adds ${nameList(diff.added)}`,
        diff.removed.length > 0 && `removes ${nameList(diff.removed)}`,
        diff.resized.length > 0 && `resizes ${nameList(diff.resized)}`,
        diff.reordered && "reorders the rest",
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <div className="space-y-4">
      {/* A panel an agent wrote, which does not exist anywhere yet — so it is
          previewed inline rather than morphed into the grid. */}
      <PanelProposal
        screenKey={key}
        scopeType={scope.scopeType}
        scopeId={scope.scopeId}
        onAccept={(componentId) =>
          morphLayout(`#${GRID_ID}`, () =>
            persist(addWidget(layout, panelWidgetId(componentId), 1), {
              droppedAt: layout.widgets.length,
            }),
          )
        }
      />

      <AnimatePresence initial={false}>
        {proposal && (
          <motion.div
            key={proposal.proposalId}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="bento-tile flex flex-wrap items-center gap-3 rounded-2xl p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-medium">{proposal.agentName}</span>{" "}
                suggests a different arrangement
                {diffSentence ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {diffSentence}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {proposal.reason}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={previewing}
                onClick={() => {
                  const next = previewing ? null : proposal.proposalId;
                  morphLayout(`#${GRID_ID}`, () =>
                    setPreviewingProposal(next),
                  );
                }}
                className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {previewing ? "Show mine" : "Preview"}
              </button>
              <button
                type="button"
                onClick={() => resolve(false)}
                className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  if (previewing) resolve(true);
                  else morphLayout(`#${GRID_ID}`, () => resolve(true));
                }}
                className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background"
              >
                Accept
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    <EditableGrid
      gridId={GRID_ID}
      // The screen, not the element — a condition set on this project's panel
      // must not be the same row as one set on another project's. See the note
      // on the prop.
      screenKey={key}
      // While an agent's proposal is on the canvas, the layout below is not
      // this reader's — so the grid refuses edits, and must not offer a panel
      // it would then refuse to place.
      layoutIsProvisional={previewing}
      tiles={tiles}
      layout={layout}
      onChange={persist}
      emptyMessage={
        <div className="panel rounded-2xl p-8 text-center">
          <p className="text-sm text-muted-foreground">
            You&apos;ve cleared this screen. Arrange to put something back.
          </p>
        </div>
      }
    >
      {(editing) =>
        editing && unplaced.length > 0 ? (
          <div className="panel rounded-2xl p-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Drag a panel onto the screen
            </span>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {unplaced.map((id) => {
                const customId = panelIdFromWidgetId(id);
                if (customId) {
                  const row = customById.get(customId);
                  if (!row) return null;
                  // The panel model, like everywhere else — the tray must
                  // describe a panel the way the renderer will draw it.
                  const def = normalizePanel(row.definition);
                  if (deleting.includes(customId)) return null;
                  return (
                    <TrayTile
                      key={id}
                      gridId={GRID_ID}
                      onDrop={(slot) =>
                        morphLayout(`#${GRID_ID}`, () =>
                          persist(insertWidget(layout, id, 1, slot), {
                            droppedAt: slot,
                          }),
                        )
                      }
                      onClick={() =>
                        morphLayout(`#${GRID_ID}`, () =>
                          persist(addWidget(layout, id, 1), {
                            droppedAt: layout.widgets.length,
                          }),
                        )
                      }
                      className="bento-tile flex cursor-grab items-start gap-2 p-3 text-left transition-colors hover:bg-accent active:cursor-grabbing"
                    >
                      <Plus className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {def.title}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {describePanel(def)}
                          {row.authoredByName
                            ? ` — by ${row.authoredByName}`
                            : ""}
                        </span>
                      </span>
                      {/* The only place a panel can be thrown away. It lives
                          here because deleting the definition is what removes
                          it from every screen — `normalizeLayout` drops ids
                          that no longer resolve — and this is the one surface
                          holding both the layout and the definitions. */}
                      <button
                        type="button"
                        aria-label={`Delete ${def.title}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting((ids) => [...ids, customId]);
                          toast(`Deleted "${def.title}"`, {
                            action: {
                              label: "Undo",
                              onClick: () =>
                                setDeleting((ids) =>
                                  ids.filter((i) => i !== customId),
                                ),
                            },
                            // The mutation only runs once the undo window
                            // closes, so nothing is destroyed while it can
                            // still be taken back.
                            onExpire: () => {
                              void removePanel({
                                componentId: customId as Parameters<
                                  typeof removePanel
                                >[0]["componentId"],
                              }).catch((e) =>
                                toast(
                                  errorMessage(e, "Couldn't delete that"),
                                  { kind: "error" },
                                ),
                              );
                            },
                          });
                        }}
                        className="tap-target flex-shrink-0 self-start text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    </TrayTile>
                  );
                }
                const widget = widgetById(id);
                if (!widget) return null;
                return (
                  <TrayTile
                    key={id}
                    gridId={GRID_ID}
                    onDrop={(slot) =>
                      morphLayout(`#${GRID_ID}`, () =>
                        persist(
                          insertWidget(layout, id, widget.defaultSpan, slot),
                          { droppedAt: slot },
                        ),
                      )
                    }
                    onClick={() =>
                      morphLayout(`#${GRID_ID}`, () =>
                        persist(addWidget(layout, id, widget.defaultSpan), {
                          droppedAt: layout.widgets.length,
                        }),
                      )
                    }
                    className="bento-tile flex cursor-grab items-start gap-2 p-3 text-left transition-colors hover:bg-accent active:cursor-grabbing"
                  >
                    <Plus className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {widget.title}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {widget.description}
                      </span>
                    </span>
                  </TrayTile>
                );
              })}
            </div>
            {/* Every panel here that is only sometimes here, and the one tap
                out of each. It belongs beside the unplaced panels because it
                answers the same question they do — "what is not on my screen,
                and why" — and it has to be SOMEWHERE, since a panel governed
                by a condition is invisible exactly when the condition is
                false. A setting you can only reach by pointing at a thing that
                is not on screen is a setting that cannot be unset. */}
            <OnlyWhenList screenKey={key} />

            {/* The ceiling this whole system exists to remove: you are no
                longer choosing from what we shipped. */}
            <div className="mt-4 border-t border-border/60 pt-4">
              <PanelBuilder
                scopeType={scope.scopeType}
                scopeId={scope.scopeId}
                onCreated={(componentId: string) =>
                  morphLayout(`#${GRID_ID}`, () =>
                    persist(
                      addWidget(layout, panelWidgetId(componentId), 1),
                      { droppedAt: layout.widgets.length },
                    ),
                  )
                }
              />
            </div>
          </div>
        ) : null
      }
    </EditableGrid>
    </div>
  );
}

/** Panel ids as readable names, from the registry so labels never drift. */
function nameList(ids: string[]): string {
  return ids
    .map((id) => widgetById(id)?.title.toLowerCase() ?? id)
    .join(", ");
}
