"use client";

import { useEffect, useRef } from "react";
import { Tldraw, type Editor, type StoreSnapshot, type TLRecord } from "tldraw";
import "tldraw/tldraw.css";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

const SAVE_DEBOUNCE_MS = 800;

export function TldrawCanvas({
  whiteboardId,
  initialSnapshot,
}: {
  whiteboardId: Id<"whiteboards">;
  initialSnapshot: unknown;
}) {
  const updateSnapshot = useMutation(api.whiteboards.updateSnapshot);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  function onMount(editor: Editor) {
    editorRef.current = editor;

    if (initialSnapshot) {
      try {
        editor.store.loadSnapshot(
          initialSnapshot as StoreSnapshot<TLRecord>,
        );
      } catch (err) {
        // Snapshot from an older tldraw version, etc — start blank.
        console.warn("Failed to load whiteboard snapshot:", err);
      }
    }

    // Subscribe to store changes; debounce a save mutation.
    editor.store.listen(
      () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          if (!editorRef.current) return;
          const snapshot = editorRef.current.store.getSnapshot();
          updateSnapshot({ whiteboardId, snapshot });
        }, SAVE_DEBOUNCE_MS);
      },
      { source: "user", scope: "document" },
    );
  }

  return (
    <div className="h-[70vh] overflow-hidden rounded-3xl border border-border">
      <Tldraw onMount={onMount} />
    </div>
  );
}
