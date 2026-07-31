"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAppearance } from "@/components/appearance/appearance-provider";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import {
  clearStyleKeys,
  normalizeStylePatch,
  resolveStyle,
  type ComponentStyle,
  type StyleKey,
  type StyleLayerId,
  type StylePatch,
} from "@/lib/component-style";

// How panels are drawn, resolved for wherever you are standing.
//
// Deliberately a hook rather than a second provider. The appearance provider
// already knows which space you are in and holds the live subscription; adding
// another context that re-derives the same thing is two sources for one answer.
// Panels read this; nothing else has to.
//
// The one piece of local state is the same one the appearance provider keeps
// and for the same reason: a control mid-drag has to repaint on the frame and
// must not write sixty times a second. Everything else comes off the
// subscription, so a change lands in every tab.

export type ComponentStyleScope =
  | "personal"
  | "space"
  | "personalSpace"
  | "panel";

export type ComponentStyleContext = {
  /** What panels are drawn with right now, preview included. */
  style: ComponentStyle;
  /** Which layer each value came from. */
  sources: Record<StyleKey, StyleLayerId>;
  /** Exactly what is set at one scope — what a control offers to clear. */
  patchFor: (scope: ComponentStyleScope) => StylePatch;
  /** Apply without saving. For a control being dragged. */
  preview: (patch: StylePatch) => void;
  /** Apply and persist to one layer. */
  commit: (patch: StylePatch, scope: ComponentStyleScope) => void;
  /** Stop setting these keys here, so they inherit again. */
  clear: (keys: readonly StyleKey[], scope: ComponentStyleScope) => void;
  /** Clear a whole layer. */
  reset: (scope: ComponentStyleScope) => void;
  /** Throw the preview away. */
  revert: () => void;
  scopes: ComponentStyleScope[];
  spaceName: string | null;
  dirty: boolean;
};

/**
 * @param panelId When given, resolves the narrowest layer too — this panel's
 * own override — and lets `commit` write to it. That is what the in-place
 * inspector edits: you point at a panel on your own screen and change that
 * panel, without touching anything else that looks like it.
 *
 * @param definitionStyle The look the panel's definition carries. Sits under
 * the reader's own override, so an authored panel arrives drawn the way its
 * author meant without ever outranking the person reading it.
 */
export function useComponentStyle(
  panelId?: string | null,
  definitionStyle?: StylePatch,
): ComponentStyleContext {
  const { toast } = useToast();
  const { space } = useAppearance();
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const save = useMutation(api.appearance.saveComponentStyle);
  const setSpaceStyle = useMutation(api.appearance.setSpaceComponentStyle);
  const savePanel = useMutation(api.appearance.savePanelStyle);
  const [previewPatch, setPreviewPatch] = useState<StylePatch | null>(null);

  const spaceId = space?.spaceId ?? null;

  const personal = useMemo(
    () => normalizeStylePatch(remote?.componentStyle),
    [remote?.componentStyle],
  );
  const spacePatch = useMemo(
    () => normalizeStylePatch(space?.componentStyle),
    [space?.componentStyle],
  );
  const personalSpace = useMemo(() => {
    if (!remote || !spaceId) return {};
    const stored = (remote.componentStyleBySpace ?? {})[spaceId];
    return normalizeStylePatch(stored);
  }, [remote, spaceId]);

  const panel = useMemo(() => {
    if (!remote || !panelId) return {};
    const stored = (remote.panelStyles ?? {})[panelId];
    return normalizeStylePatch(stored);
  }, [remote, panelId]);

  // Held by value rather than by reference: callers build this from a
  // definition and would otherwise hand over a fresh object every render.
  const definitionKey = JSON.stringify(definitionStyle ?? {});
  const definition = useMemo(
    () => normalizeStylePatch(JSON.parse(definitionKey)),
    [definitionKey],
  );

  const resolved = useMemo(
    () =>
      resolveStyle({
        personal,
        space: spacePatch,
        personalSpace,
        definition,
        component: panel,
      }),
    [personal, spacePatch, personalSpace, definition, panel],
  );

  // The preview sits on top of everything, so a control always visibly moves
  // even when the value it edits is shadowed by a narrower layer. Saying so is
  // the studio's job; a dead-feeling control is nobody's idea of feedback.
  const style = useMemo<ComponentStyle>(() => {
    if (!previewPatch) return resolved.style;
    return { ...resolved.style, ...normalizeStylePatch(previewPatch) };
  }, [previewPatch, resolved.style]);

  const patchFor = useCallback(
    (scope: ComponentStyleScope): StylePatch => {
      if (scope === "personal") return personal;
      if (scope === "space") return spacePatch;
      if (scope === "panel") return panel;
      return personalSpace;
    },
    [personal, spacePatch, personalSpace, panel],
  );

  const persist = useCallback(
    (scope: ComponentStyleScope, patch: StylePatch) => {
      // Say so. This used to be an empty catch with a comment arguing that a
      // preference which didn't stick is not a broken app — while the preview
      // stayed on screen, so a failed write looked exactly like a successful
      // one until the next reload. Hiding a failed save is worse than the
      // failed save: it is the difference between "that didn't work" and
      // "this product doesn't work".
      const failed = (e: unknown) =>
        toast(errorMessage(e, "That style didn't save"), { kind: "error" });

      if (scope === "panel") {
        if (!panelId) {
          toast("Pick a panel first", { kind: "error" });
          return;
        }
        void savePanel({ panelId, patch }).catch(failed);
        return;
      }
      if (scope === "personal") {
        void save({ patch }).catch(failed);
      } else if (!spaceId) {
        // Reachable only if a caller offers a space scope outside a space,
        // which is a wiring bug rather than something a person can do. It
        // used to be an empty branch, so the write vanished in silence.
        toast("Open a space to change how it looks for everyone", {
          kind: "error",
        });
      } else if (scope === "space") {
        void setSpaceStyle({
          spaceId: spaceId as Parameters<typeof setSpaceStyle>[0]["spaceId"],
          style: patch,
        }).catch(failed);
      } else {
        void save({
          patch,
          spaceId: spaceId as Parameters<typeof save>[0]["spaceId"],
        }).catch(failed);
      }
    },
    [save, savePanel, setSpaceStyle, spaceId, panelId, toast],
  );

  const preview = useCallback((patch: StylePatch) => {
    setPreviewPatch((current) => ({ ...(current ?? {}), ...patch }));
  }, []);

  const commit = useCallback(
    (patch: StylePatch, scope: ComponentStyleScope) => {
      const allowed = normalizeStylePatch(patch);
      setPreviewPatch((current) => ({ ...(current ?? {}), ...allowed }));
      persist(scope, { ...patchFor(scope), ...allowed });
    },
    [patchFor, persist],
  );

  const clear = useCallback(
    (keys: readonly StyleKey[], scope: ComponentStyleScope) => {
      // Clear the preview for these keys too, or the control keeps showing
      // the value that was just handed back to the layer beneath.
      setPreviewPatch((current) => (current ? clearStyleKeys(current, keys) : current));
      persist(scope, clearStyleKeys(patchFor(scope), keys));
    },
    [patchFor, persist],
  );

  const reset = useCallback(
    (scope: ComponentStyleScope) => {
      setPreviewPatch(null);
      persist(scope, {});
    },
    [persist],
  );

  const revert = useCallback(() => setPreviewPatch(null), []);

  const scopes = useMemo<ComponentStyleScope[]>(() => {
    const out: ComponentStyleScope[] = [];
    // Narrowest first, because it is the one you reached for by pointing at a
    // panel — offering "everywhere" ahead of "this one" invites the change
    // nobody asked for.
    if (panelId) out.push("panel");
    out.push("personal");
    if (space) {
      if (space.mayTheme) out.push("space");
      out.push("personalSpace");
    }
    return out;
  }, [space, panelId]);

  return {
    style,
    sources: resolved.sources,
    patchFor,
    preview,
    commit,
    clear,
    reset,
    revert,
    scopes,
    spaceName: space?.name ?? null,
    dirty: previewPatch !== null,
  };
}
