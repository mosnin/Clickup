"use client";

import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// The block drag handle.
//
// Hand-rolled rather than @tiptap/extension-drag-handle, which depends on
// tippy.js (removed from this editor on purpose — the selection toolbar and
// the suggestion menus all position off the editor's own coordinates) and
// peer-depends on the collaboration + y-prosemirror chain this project
// doesn't use. Dragging a block is a ProseMirror primitive; the only work is
// finding the block under the cursor and handing ProseMirror a NodeSelection.
//
// Reordering is invisible in the stored markdown — the blocks come out in
// their new order and nothing else changes — which is why this is safe to add
// to a markdown-backed editor at all.

export const DragHandlePluginKey = new PluginKey("pageDragHandle");

/** The top-level block containing a viewport point, if any. */
function blockAt(
  view: EditorView,
  x: number,
  y: number,
): { pos: number; dom: HTMLElement } | null {
  const found = view.posAtCoords({ left: x, top: y });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  // Depth 1 is a direct child of the doc: the thing a person means by "this
  // block", not the paragraph inside a list item three levels down.
  const depth = Math.min($pos.depth, 1);
  const pos = depth === 0 ? $pos.before(1) : $pos.before(depth);
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  return { pos, dom };
}

export const DragHandle = Extension.create({
  name: "pageDragHandle",

  addProseMirrorPlugins() {
    let handle: HTMLButtonElement | null = null;
    let currentPos: number | null = null;
    let currentDom: HTMLElement | null = null;

    function hide() {
      if (handle) handle.style.opacity = "0";
      currentPos = null;
      currentDom = null;
    }

    return [
      new Plugin({
        key: DragHandlePluginKey,
        view(view) {
          handle = document.createElement("button");
          handle.type = "button";
          handle.draggable = true;
          handle.className = "page-drag-handle";
          handle.setAttribute("aria-label", "Drag to reorder this block");
          handle.style.opacity = "0";
          // Six dots, the shape everyone already reads as "grab me".
          handle.textContent = "⠿";
          view.dom.parentElement?.appendChild(handle);

          handle.addEventListener("dragstart", (event) => {
            if (currentPos === null || !currentDom) return;
            const selection = NodeSelection.create(view.state.doc, currentPos);
            view.dispatch(view.state.tr.setSelection(selection));
            // Handing ProseMirror the slice and `move: true` is what makes
            // its own drop handling do the reorder — no custom drop logic.
            event.dataTransfer?.clearData();
            event.dataTransfer?.setDragImage(currentDom, 0, 0);
            view.dragging = { slice: selection.content(), move: true };
          });
          handle.addEventListener("dragend", () => {
            view.dragging = null;
          });

          return {
            destroy() {
              handle?.remove();
              handle = null;
            },
          };
        },
        props: {
          handleDOMEvents: {
            mousemove(view, event) {
              if (!handle || !view.editable) return false;
              const block = blockAt(view, event.clientX, event.clientY);
              if (!block) {
                hide();
                return false;
              }
              currentPos = block.pos;
              currentDom = block.dom;

              const wrapper = view.dom.parentElement;
              if (!wrapper) return false;
              const wrapperBox = wrapper.getBoundingClientRect();
              const blockBox = block.dom.getBoundingClientRect();
              handle.style.opacity = "1";
              handle.style.top = `${blockBox.top - wrapperBox.top}px`;
              // Parked inside the surface's own left padding rather than
              // outside its box, so the handle can't be clipped by whatever
              // the editor is sitting in.
              handle.style.left = `${
                view.dom.getBoundingClientRect().left - wrapperBox.left + 2
              }px`;
              return false;
            },
            mouseleave() {
              hide();
              return false;
            },
          },
        },
      }),
    ];
  },
});
