"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { IntentComposer } from "@/components/appearance/intent-composer";
import { Chart } from "@/components/charts/operate/chart";
import { normalizeStyle } from "@/lib/component-style";
import {
  describePanel,
  isChartShape,
  normalizePanel,
  shapeLabel,
  panelIdFromWidgetId,
  shapesFor,
  type PanelDef,
} from "@/lib/panel";
import { coherePanel, diffPanels, summarizeChanges } from "@/lib/panel-intent";
import { cn } from "@/lib/utils";

// Changing what a panel asks, from beside the panel.
//
// The inspector could have been about looks alone, and the split would have
// been tidy: the builder owns the question, the rail owns the style. It is
// also wrong, and for the same reason a settings page is wrong. Once a panel
// is on your screen, showing your work, that is the moment you know it is
// asking the wrong thing — "actually only mine", "actually as a donut". Making
// that a trip back to a builder means changing the question requires leaving
// the answer.
//
// So the whole definition is editable here, in place. The panel behind the
// rail is the preview, because it is the panel.
//
// Two things it deliberately does not do:
//
// **It does not appear for a built-in panel.** Those have no definition to
// rewrite — their body is code — so the section is simply absent rather than
// present and dead. `uiComponents.get` answering `null` covers both "not a
// panel" and "not yours", which from out here is the same fact.
//
// **It does not save as you drag.** A question is not a slider; changing the
// source and then the shape would write two definitions, and the first is a
// panel nobody meant. Changes land on the draft, and Save writes once.

export function PanelQuestion({ selectionId }: { selectionId: string }) {
  // The inspector is pointed at a panel by a click, so all it has is a widget
  // id — `<screen>:<widget>`, where an authored panel's widget id carries its
  // definition id. Parsing it is what avoids threading scope through the shell
  // for the sake of one lookup.
  const componentId = useMemo(() => {
    const tail = selectionId.slice(selectionId.indexOf(":") + 1);
    return panelIdFromWidgetId(tail);
  }, [selectionId]);

  const row = useQuery(
    api.uiComponents.get,
    componentId ? { componentId } : "skip",
  );
  const update = useMutation(api.uiComponents.update);
  const setShared = useMutation(api.uiComponents.setShared);
  const { toast } = useToast();

  const stored = useMemo<PanelDef | null>(
    () => (row ? normalizePanel(row.definition) : null),
    [row],
  );
  const [draft, setDraft] = useState<PanelDef | null>(null);
  /** A sentence's answer, applied but not kept. */
  const [proposed, setProposed] = useState<PanelDef | null>(null);

  if (!componentId || !row || !stored) return null;

  const showing = proposed ?? draft ?? stored;
  const changes = diffPanels(stored, showing);
  const edit = (next: PanelDef) => {
    setProposed(null);
    setDraft(coherePanel(next, showing));
  };

  return (
    <section>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          What it asks
        </span>
        {changes.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setProposed(null);
            }}
            className="text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Reset
          </button>
        )}
      </span>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {describePanel(showing)}
      </p>

      {/* Shape is the one control worth keeping in the rail: it is the change
          people make most, and it is the one that is instantly legible. */}
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {shapesFor(showing.query.from).map((shape) => (
          <button
            key={shape}
            type="button"
            aria-pressed={shape === showing.shape}
            aria-label={shapeLabel(shape)}
            title={shapeLabel(shape)}
            onClick={() => edit(normalizePanel({ ...showing, shape }))}
            className={cn(
              "flex h-9 items-center justify-center overflow-hidden rounded-md bg-page p-1 transition-all",
              shape === showing.shape
                ? "ring-2 ring-foreground"
                : "ring-1 ring-border hover:ring-muted-foreground/40",
            )}
          >
            <ShapeMark shape={shape} />
          </button>
        ))}
      </div>

      <div className="mt-3">
        <IntentComposer
          def={draft ?? stored}
          label="what this panel shows"
          onPreview={setProposed}
          onCommit={edit}
        />
      </div>

      {/* Offering it, which is not the same as placing it on anybody's
          screen. A good panel otherwise dies with its author and ten people
          build ten of the same thing. */}
      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          checked={row.sharedAt !== null && row.sharedAt !== undefined}
          onChange={(e) =>
            void setShared({
              componentId: row.componentId,
              shared: e.currentTarget.checked,
            }).catch((err) =>
              toast(errorMessage(err, "Couldn't change that"), {
                kind: "error",
              }),
            )
          }
          className="mt-0.5"
        />
        <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
          Offer this to everyone here. It appears in their tray, never on
          their screen.
        </span>
      </label>

      {changes.length > 0 && (
        <div className="mt-3 rounded-lg bg-page p-2.5 ring-1 ring-border">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {summarizeChanges(changes)}
          </p>
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={() => {
              void update({
                componentId: row.componentId,
                definition: showing,
              })
                .then(() => {
                  setDraft(null);
                  setProposed(null);
                  toast("Panel updated");
                })
                .catch((e) =>
                  toast(errorMessage(e, "Couldn't save that"), {
                    kind: "error",
                  }),
                );
            }}
          >
            Save
          </Button>
        </div>
      )}
    </section>
  );
}

const MARK = [
  {
    key: "a",
    label: "A",
    points: [
      { key: "1", label: "", value: 6 },
      { key: "2", label: "", value: 10 },
      { key: "3", label: "", value: 4 },
    ],
  },
];

/** A shape at rail size — the chart itself where there is one to draw. */
function ShapeMark({ shape }: { shape: PanelDef["shape"] }) {
  if (isChartShape(shape)) {
    return (
      <Chart
        kind={shape as Parameters<typeof Chart>[0]["kind"]}
        series={MARK}
        style={normalizeStyle({ grid: "none", axes: "none" })}
        unit="count"
        height={24}
        label={shapeLabel(shape)}
      />
    );
  }
  const bar = "block h-[3px] rounded-full bg-muted-foreground/40";
  return (
    <span aria-hidden className="flex w-8 flex-col gap-1">
      <span className={cn(bar, "w-full")} />
      <span className={cn(bar, "w-4/5")} />
      <span className={cn(bar, "w-3/5")} />
    </span>
  );
}
