"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Columns2, GripVertical, Plus, Settings2, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { morphLayout } from "@/lib/anime";
import {
  addWidget,
  cycleSpan,
  isDefaultLayout,
  moveWidgetById,
  normalizeLayout,
  removeWidget,
  screenKey,
  unusedWidgets,
  type ScreenLayout,
} from "@/lib/screen-layout";
import {
  DEFAULT_PROJECT_LAYOUT,
  PROJECT_WIDGET_IDS,
  widgetById,
  type ProjectWidgetContext,
} from "./widgets";
import { cn } from "@/lib/utils";

// A project screen someone has composed for themselves.
//
// Two modes, because they want opposite things. **Reading** is the default and
// has no chrome at all — no handles, no borders, no hover affordances, because
// a screen covered in edit controls is a screen you can't read. **Customising**
// is explicit, and while it's on, every panel grows a handle, a width control
// and a remove button, and a tray of unplaced panels appears.
//
// The alternative — always-visible handles, or hover-to-reveal — was rejected
// on the same grounds Notion rejects it: the common case is looking at your
// work, not rearranging it.
//
// Reordering uses @dnd-kit (already in the project for the board) because it
// brings keyboard support with it; resizing and adding go through anime.js
// FLIP, because those reflow the grid and dnd-kit isn't involved.

const GRID_ID = "project-screen-grid";

export function ProjectScreen(ctx: ProjectWidgetContext) {
  const key = screenKey("project", ctx.project._id);
  const stored = useQuery(api.screens.layoutFor, { screenKey: key });
  const saveLayout = useMutation(api.screens.saveLayout);
  const resetLayout = useMutation(api.screens.resetLayout);
  const { toast } = useToast();
  const [customizing, setCustomizing] = useState(false);

  // `null` from the server means "never customised", which is not the same as
  // a customised layout that happens to be empty — someone who removed every
  // panel should keep an empty screen, not get the defaults back.
  const layout = useMemo<ScreenLayout>(() => {
    if (stored === undefined || stored === null) return DEFAULT_PROJECT_LAYOUT;
    return normalizeLayout(stored.layout, PROJECT_WIDGET_IDS);
  }, [stored]);

  const customised = stored !== null && stored !== undefined;

  const persist = useCallback(
    (next: ScreenLayout) => {
      void saveLayout({ screenKey: key, layout: next }).catch((e) =>
        toast(errorMessage(e, "Couldn't save the layout"), { kind: "error" }),
      );
    },
    [key, saveLayout, toast],
  );

  const sensors = useSensors(
    // A small distance before a drag starts, so clicking a control inside a
    // panel doesn't begin dragging the panel.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    persist(moveWidgetById(layout, String(active.id), String(over.id)));
  }

  const unplaced = unusedWidgets(layout, PROJECT_WIDGET_IDS);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {customizing ? "Arranging your screen" : ""}
        </span>
        <div className="flex items-center gap-2">
          {customizing && customised && !isDefaultLayout(layout, DEFAULT_PROJECT_LAYOUT) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                morphLayout(`#${GRID_ID}`, () => {
                  void resetLayout({ screenKey: key }).catch((e) =>
                    toast(errorMessage(e, "Couldn't reset"), { kind: "error" }),
                  );
                });
              }}
            >
              Reset
            </Button>
          )}
          <Button
            variant={customizing ? "default" : "outline"}
            size="sm"
            aria-pressed={customizing}
            onClick={() => setCustomizing((c) => !c)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {customizing ? "Done" : "Customize"}
          </Button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={layout.widgets.map((w) => w.id)}
          strategy={rectSortingStrategy}
        >
          <div
            id={GRID_ID}
            className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start"
          >
            {layout.widgets.map((w) => {
              const widget = widgetById(w.id);
              if (!widget) return null;
              return (
                <SortableWidget
                  key={w.id}
                  id={w.id}
                  span={w.span}
                  title={widget.title}
                  customizing={customizing}
                  canResize={widget.minSpan !== widget.maxSpan}
                  onCycleSpan={() =>
                    morphLayout(`#${GRID_ID}`, () =>
                      persist(
                        cycleSpan(layout, w.id, {
                          min: widget.minSpan,
                          max: widget.maxSpan,
                        }),
                      ),
                    )
                  }
                  onRemove={() =>
                    morphLayout(`#${GRID_ID}`, () =>
                      persist(removeWidget(layout, w.id)),
                    )
                  }
                >
                  {widget.render(ctx)}
                </SortableWidget>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {layout.widgets.length === 0 && !customizing && (
        <div className="panel rounded-2xl p-8 text-center">
          <p className="text-sm text-muted-foreground">
            You&apos;ve cleared this screen. Customize to put something back.
          </p>
        </div>
      )}

      {customizing && (
        <div className="panel rounded-2xl p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Add a panel
          </span>
          {unplaced.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Everything is already on the screen.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {unplaced.map((id) => {
                const widget = widgetById(id);
                if (!widget) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      morphLayout(`#${GRID_ID}`, () =>
                        persist(addWidget(layout, id, widget.defaultSpan)),
                      )
                    }
                    className="bento-tile flex items-start gap-2 p-3 text-left transition-colors hover:bg-accent"
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
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
};

function SortableWidget({
  id,
  span,
  title,
  customizing,
  canResize,
  onCycleSpan,
  onRemove,
  children,
}: {
  id: string;
  span: number;
  title: string;
  customizing: boolean;
  canResize: boolean;
  onCycleSpan: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !customizing });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "min-w-0",
        SPAN_CLASS[span] ?? SPAN_CLASS[1],
        isDragging && "z-10 opacity-80",
      )}
    >
      {customizing && (
        <div className="mb-1.5 flex items-center gap-1">
          <button
            type="button"
            aria-label={`Reorder ${title}`}
            className="tap-target inline-flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {canResize && (
            <button
              type="button"
              aria-label={`Change the width of ${title}`}
              title={`${span} of 3 columns`}
              onClick={onCycleSpan}
              className="tap-target inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Columns2 className="h-3.5 w-3.5" />
              {span}
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${title} from this screen`}
            onClick={onRemove}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div
        className={cn(
          customizing &&
            "rounded-2xl outline-dashed outline-1 outline-offset-4 outline-border",
        )}
      >
        {children}
      </div>
    </div>
  );
}
