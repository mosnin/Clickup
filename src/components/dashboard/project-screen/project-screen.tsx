"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { morphLayout, wake } from "@/lib/anime";
import {
  addWidget,
  insertWidget,
  normalizeLayout,
  screenKey,
  unusedWidgets,
  type ScreenLayout,
} from "@/lib/screen-layout";
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

  // `null` from the server means "never arranged", which is not the same as an
  // arranged layout that happens to be empty — someone who cleared the screen
  // should keep a clear screen rather than get the defaults back.
  const layout = useMemo<ScreenLayout>(() => {
    if (stored === undefined || stored === null) return DEFAULT_PROJECT_LAYOUT;
    return normalizeLayout(stored.layout, PROJECT_WIDGET_IDS);
  }, [stored]);

  const persist = useCallback(
    (next: ScreenLayout, opts?: { droppedAt?: number }) => {
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
    [key, saveLayout, toast],
  );

  const tiles = useMemo<EditableTile[]>(
    () =>
      layout.widgets.flatMap((w) => {
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
    [ctx, layout.widgets],
  );

  const unplaced = unusedWidgets(layout, PROJECT_WIDGET_IDS);

  return (
    <EditableGrid
      gridId={GRID_ID}
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
          </div>
        ) : null
      }
    </EditableGrid>
  );
}
