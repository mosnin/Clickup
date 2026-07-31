"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/dashboard/panel";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { useActiveSpace } from "@/lib/use-active-space";
import { PANEL_PRESETS } from "@/lib/panel-intent";
import {
  normalizePanel,
  shapeLabel,
  shapesFor,
  type PanelDef,
  type PanelShape,
} from "@/lib/panel";

// Making a card, one question at a time.
//
// The old builder was a form: source picker, filter pickers, dimension picker,
// measure picker, shape grid, fields checklist — every piece of the vocabulary
// exposed at once, which is a settings page whatever it is called. This asks
// the way a person actually decides:
//
//   1. **What should it watch?** — a shelf of finished starting points, each
//      one the REAL panel running on your real data. Not descriptions of
//      cards: the cards. Picking one answers source, filter, dimension and
//      measure in one gesture, because the preset already composed them.
//   2. **How should it be drawn?** — the same panel, drawn every legal way,
//      each again live on your data. Scroll, lock, pick.
//   3. **Add it.** One button. It lands in your scope and every project
//      screen's shelf offers it.
//
// There is deliberately no naming step and no field-picking step. The preset
// names it sensibly, and both are editable afterwards by clicking the panel —
// where every other panel edit already lives. A wizard that front-loads every
// decision is the form again, wearing steps.
//
// The vocabulary stays closed the whole way: presets come from
// `PANEL_PRESETS`, shapes from `shapesFor`, and the definition is normalized
// before it is stored — this flow cannot author anything the renderer would
// refuse.

export type BuilderStep = "watch" | "shape";

export function useCardBuilder() {
  const [presetId, setPresetId] = useState<string | null>(null);
  const step: BuilderStep = presetId === null ? "watch" : "shape";
  return {
    step,
    presetId,
    pickPreset: setPresetId,
    back: () => setPresetId(null),
  };
}

/**
 * The scope a new card belongs to: the space you are standing in, or your
 * personal scope anywhere that has none (Home, the inbox). Resolved here so
 * the builder body stays a function of its inputs.
 */
export function useBuilderScope(): {
  scopeType: "user" | "workspace";
  scopeId: string;
} | null {
  const space = useActiveSpace();
  const { user } = useUser();
  if (space) return { scopeType: space.scopeType, scopeId: space.scopeId };
  if (user?.id) return { scopeType: "user", scopeId: user.id };
  return null;
}

/** The definition a preset starts from, with a shape applied on step two. */
export function builderDef(
  presetId: string | null,
  shape: PanelShape | null,
): PanelDef | null {
  const preset = PANEL_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const base = normalizePanel(preset.def);
  return shape ? normalizePanel({ ...base, shape }) : base;
}

/** Step one's shelf: every starting point, live. */
export function watchItems(scope: {
  scopeType: "user" | "workspace";
  scopeId: string;
}) {
  return PANEL_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.name,
    hint: preset.description,
    render: () => (
      <LivePanelCard
        def={normalizePanel(preset.def)}
        scope={scope}
      />
    ),
  }));
}

/** Step two's shelf: the chosen question, drawn every legal way, live. */
export function shapeItems(
  presetId: string,
  scope: { scopeType: "user" | "workspace"; scopeId: string },
) {
  const base = builderDef(presetId, null);
  if (!base) return [];
  return shapesFor(base.query.from).map((shape) => ({
    id: shape,
    label: shapeLabel(shape),
    render: () => (
      <LivePanelCard
        def={normalizePanel({ ...base, shape })}
        scope={scope}
      />
    ),
  }));
}

/**
 * A real panel at shelf size. `<Panel>` runs the definition through the same
 * resolver the dashboard uses, so what the shelf shows is what the screen
 * gets — there is no gap for a preview to lie in.
 */
function LivePanelCard({
  def,
  scope,
}: {
  def: PanelDef;
  scope: { scopeType: "user" | "workspace"; scopeId: string };
}) {
  // Keyed by shape+preset so arriving cards mount fresh and their charts
  // play the library's entrance — the same lock-in moment the style shelves
  // have.
  return (
    <span className="pointer-events-none block h-[340px] overflow-hidden text-left [&>*]:h-full">
      <Panel
        definition={def}
        key={`${def.title}:${def.shape}`}
        scopeId={scope.scopeId}
        scopeType={scope.scopeType}
      />
    </span>
  );
}

/** The one commit. Creates the card and says where it went. */
export function useAddCard(onDone: () => void) {
  const create = useMutation(api.uiComponents.create);
  const { toast } = useToast();

  return useMemo(
    () => ({
      add: (
        def: PanelDef,
        scope: { scopeType: "user" | "workspace"; scopeId: string },
      ) => {
        void create({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          definition: def,
        })
          .then(() => {
            toast(
              `"${def.title}" is ready — it's on the shelf when you arrange any screen.`,
            );
            onDone();
          })
          .catch((e) =>
            toast(errorMessage(e, "Couldn't create the card"), {
              kind: "error",
            }),
          );
      },
    }),
    [create, toast, onDone],
  );
}

export { Button as BuilderButton };
