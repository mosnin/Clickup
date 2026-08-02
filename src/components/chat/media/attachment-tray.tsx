"use client";

// What is about to be sent, sitting above the box you are typing in.
//
// It is a row of tiles rather than a list of filenames, because the question
// somebody has while looking at it is "is that the right screenshot" and a name
// like `Screenshot 2026-08-02 at 09.41.13.png` cannot answer it. Images show
// themselves from a local object URL before a byte has moved (§2.6's optimistic
// preview); everything else shows its name and its size.
//
// The progress bar is measured, not animated — see `putBlob`.

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/buzz/media";
import type { AttachmentSlot } from "./use-media-upload";

export function AttachmentTray({
  slots,
  onRemove,
}: {
  slots: readonly AttachmentSlot[];
  onRemove: (slotId: string) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <ul
      data-attachment-tray=""
      aria-label="Attachments"
      className="mb-1.5 flex flex-wrap gap-2"
    >
      {slots.map((slot) => (
        <li
          key={slot.id}
          data-slot-status={slot.status}
          className={cn(
            "bento relative flex w-40 items-center gap-2 overflow-hidden rounded-xl px-2 py-1.5",
            slot.status === "failed" && "opacity-70",
          )}
        >
          {slot.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL
            <img
              src={slot.previewUrl}
              alt=""
              aria-hidden
              className="size-8 shrink-0 rounded-md object-cover"
            />
          ) : null}

          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.6875rem] font-medium">{slot.name}</span>
            <span className="chat-quiet block text-[0.625rem]">
              {slot.status === "failed"
                ? (slot.error ?? "Upload failed")
                : slot.status === "uploading"
                  ? `${Math.round(slot.progress * 100)}%`
                  : formatBytes(slot.sizeBytes)}
            </span>
          </span>

          <button
            type="button"
            aria-label={`Remove ${slot.name}`}
            onClick={() => onRemove(slot.id)}
            className="chat-icon-button tap-target shrink-0"
          >
            <X aria-hidden className="size-3.5" />
          </button>

          {slot.status === "uploading" ? (
            <span
              aria-hidden
              style={{ width: `${Math.round(slot.progress * 100)}%` }}
              className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--chat-accent)] transition-[width] duration-150"
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Drag-and-drop, with the counter that stops the highlight sticking.
 *
 * `dragenter`/`dragleave` fire for every nested element the pointer crosses, so
 * a naive boolean turns the highlight off as soon as the cursor moves over the
 * text inside the drop zone. §2.6 counts depth instead. Returned as plain
 * handlers so the caller decides what the zone *is* — a composer, a whole room,
 * a thread pane.
 */
export function dropZoneHandlers(opts: {
  onFiles: (files: File[]) => void;
  depth: { current: number };
  setActive: (active: boolean) => void;
}) {
  const reset = () => {
    opts.depth.current = 0;
    opts.setActive(false);
  };
  return {
    onDragEnter: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      opts.depth.current += 1;
      opts.setActive(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      opts.depth.current = Math.max(0, opts.depth.current - 1);
      if (opts.depth.current === 0) opts.setActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      reset();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) opts.onFiles(files);
    },
  };
}

function hasFiles(event: React.DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}

/** The files on a paste, if any. Screenshots arrive this way and only this way. */
export function pastedFiles(event: React.ClipboardEvent): File[] {
  const items = Array.from(event.clipboardData?.items ?? []);
  return items
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}
