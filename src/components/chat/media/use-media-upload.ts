"use client";

// Picking files, and the order they end up in.
//
// The one non-obvious requirement is §2.6's, and it is worth stating because it
// looks like nothing: **attachment order must match selection order regardless
// of completion order.** Three files uploaded concurrently finish in whatever
// order the network decides, and a naive `setSlots(prev => [...prev, done])`
// puts the small one first. So the slots are *reserved* the moment the files are
// picked — one row each, in picked order, immediately visible — and each upload
// fills its own row. Buzz reserves `null`s and exposes the null-filtered view;
// this reserves rows that already know their name and their preview, which is
// the same property plus something to look at while it uploads.
//
// Everything here is best-effort except the refusals. A probe that fails costs a
// missing `dim`; a thumbnail that fails costs a slower first paint; a *type* that
// is refused costs the upload, and that refusal is duplicated on the server
// where it is the actual rule.

import { useCallback, useRef, useState } from "react";
import {
  LIMITS,
  checkAttachment,
  mediaKindOf,
  sanitizeFilename,
  type MediaKind,
} from "@/lib/buzz/media";

/** Exactly the object `buzz/media:post` takes for one attachment. */
export type AttachmentUpload = {
  storageId: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSecs?: number;
  thumbStorageId?: string;
  posterStorageId?: string;
};

export type AttachmentSlot = {
  /** Local, stable for the life of the slot. Not a storage id. */
  id: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  /** 0–1. Real, from the request's own progress events — not a fake crawl. */
  progress: number;
  /** An object URL, so the picture is on screen before the upload starts. */
  previewUrl?: string;
  error?: string;
  upload?: AttachmentUpload;
};

/** Longest side of the generated thumbnail. §2.3's server thumbnail is 320². */
const THUMB_MAX = 320;
/** Buzz seeks to 0.1s for a poster: frame zero is often black. */
const POSTER_SEEK_SECS = 0.1;
const POSTER_MAX = 640;

export type MediaUploadApi = {
  slots: AttachmentSlot[];
  /** The attachments that are ready to be posted, in the order they were picked. */
  ready: AttachmentUpload[];
  /**
   * Not every slot has landed — the send button waits on this.
   *
   * True while something is uploading **and** while something has failed. A
   * failed slot is deliberately blocking rather than skipped: `ready` filters it
   * out, so sending anyway would post the message without the attachment the
   * person can see sitting in the tray, and they would find out never. The tile
   * says why and offers the X; removing it unblocks the send.
   */
  busy: boolean;
  add: (files: readonly File[]) => void;
  remove: (slotId: string) => void;
  clear: () => void;
};

export function useMediaUpload(opts: {
  /** Mints an upload URL. Gated on the room, server-side. */
  requestUploadUrl: () => Promise<string>;
  /** Shown when a file is refused before it is uploaded. */
  onRefused?: (reason: string) => void;
}): MediaUploadApi {
  const [slots, setSlots] = useState<AttachmentSlot[]>([]);
  // A slot the reader removed while its upload was in flight. The descriptor
  // that lands afterwards is dropped rather than re-added — otherwise cancelling
  // an upload puts the file back a second later, which reads as the cancel
  // having failed.
  const cancelled = useRef(new Set<string>());
  const urlRef = useRef(opts.requestUploadUrl);
  urlRef.current = opts.requestUploadUrl;
  const refusedRef = useRef(opts.onRefused);
  refusedRef.current = opts.onRefused;

  const patch = useCallback((slotId: string, change: Partial<AttachmentSlot>) => {
    setSlots((current) =>
      current.map((slot) => (slot.id === slotId ? { ...slot, ...change } : slot)),
    );
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;

      setSlots((current) => {
        const room = LIMITS.attachmentsPerMessage - current.length;
        if (room <= 0) {
          refusedRef.current?.(
            `A message can carry at most ${LIMITS.attachmentsPerMessage} attachments.`,
          );
          return current;
        }

        const accepted: { slot: AttachmentSlot; file: File }[] = [];
        for (const file of files.slice(0, room)) {
          const kind = mediaKindOf(file.type);
          const refusal =
            checkAttachment({ mime: file.type, sizeBytes: file.size, filename: file.name }) ??
            (kind ? null : "That kind of file cannot be attached here.");
          if (refusal || !kind) {
            refusedRef.current?.(`${file.name}: ${refusal ?? "cannot be attached."}`);
            continue;
          }
          const slot: AttachmentSlot = {
            id: `slot-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
            name: sanitizeFilename(file.name),
            kind,
            sizeBytes: file.size,
            status: "uploading",
            progress: 0,
            ...(kind === "image" && typeof URL.createObjectURL === "function"
              ? { previewUrl: URL.createObjectURL(file) }
              : {}),
          };
          accepted.push({ slot, file });
        }
        if (files.length > room) {
          refusedRef.current?.(
            `Only ${room} more attachment${room === 1 ? "" : "s"} fit on this message.`,
          );
        }

        // Reserved here, filled later. The slots exist in picked order before a
        // single byte has moved.
        for (const { slot, file } of accepted) {
          void runUpload(slot, file, urlRef, cancelled, patch);
        }
        return [...current, ...accepted.map((entry) => entry.slot)];
      });
    },
    [patch],
  );

  const remove = useCallback((slotId: string) => {
    cancelled.current.add(slotId);
    setSlots((current) => {
      const going = current.find((slot) => slot.id === slotId);
      if (going?.previewUrl) URL.revokeObjectURL(going.previewUrl);
      return current.filter((slot) => slot.id !== slotId);
    });
  }, []);

  const clear = useCallback(() => {
    setSlots((current) => {
      for (const slot of current) {
        cancelled.current.add(slot.id);
        if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
      }
      return [];
    });
  }, []);

  return {
    slots,
    ready: slots
      .map((slot) => slot.upload)
      .filter((upload): upload is AttachmentUpload => Boolean(upload)),
    busy: slots.some((slot) => slot.status !== "ready"),
    add,
    remove,
    clear,
  };
}

async function runUpload(
  slot: AttachmentSlot,
  file: File,
  urlRef: { current: () => Promise<string> },
  cancelled: { current: Set<string> },
  patch: (slotId: string, change: Partial<AttachmentSlot>) => void,
): Promise<void> {
  try {
    const probed = await probeFile(file, slot.kind);
    if (cancelled.current.has(slot.id)) return;

    const storageId = await putBlob(file, file.type, await urlRef.current(), (fraction) => {
      if (!cancelled.current.has(slot.id)) patch(slot.id, { progress: fraction });
    });
    if (cancelled.current.has(slot.id)) return;

    const upload: AttachmentUpload = {
      storageId,
      filename: slot.name,
      mimeType: file.type,
      ...(probed.width ? { width: probed.width } : {}),
      ...(probed.height ? { height: probed.height } : {}),
      ...(probed.durationSecs ? { durationSecs: probed.durationSecs } : {}),
    };

    // A thumbnail and a poster are optimisations of the first paint. Their
    // failure is not the attachment's failure — a message that could not be sent
    // because its poster upload raced is a message somebody lost.
    if (probed.thumb) {
      try {
        upload.thumbStorageId = await putBlob(
          probed.thumb,
          "image/jpeg",
          await urlRef.current(),
        );
      } catch {
        /* the full image loads instead */
      }
    }
    if (probed.poster) {
      try {
        upload.posterStorageId = await putBlob(
          probed.poster,
          "image/jpeg",
          await urlRef.current(),
        );
      } catch {
        /* the browser decodes its own first frame instead */
      }
    }

    if (cancelled.current.has(slot.id)) return;
    patch(slot.id, { status: "ready", progress: 1, upload });
  } catch (error) {
    if (cancelled.current.has(slot.id)) return;
    patch(slot.id, {
      status: "failed",
      error: error instanceof Error && error.message ? error.message : "Upload failed",
    });
  }
}

/**
 * POST the bytes, reporting real progress.
 *
 * `XMLHttpRequest` rather than `fetch` for exactly one reason: fetch has no
 * upload progress event. A progress bar that is animated rather than measured is
 * a bar that says "nearly there" for a minute on a slow connection, which is
 * worse than no bar.
 */
function putBlob(
  blob: Blob,
  contentType: string,
  uploadUrl: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", uploadUrl, true);
    if (contentType) request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error("The upload could not be reached"));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`The upload was refused (${request.status})`));
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { storageId?: string };
        if (!body.storageId) throw new Error("no id");
        resolve(body.storageId);
      } catch {
        reject(new Error("The upload did not answer with a file id"));
      }
    };
    request.send(blob);
  });
}

type Probe = {
  width?: number;
  height?: number;
  durationSecs?: number;
  thumb?: Blob;
  poster?: Blob;
};

/**
 * What the browser can tell us about a file before it is uploaded.
 *
 * This is also the closest thing we have to Buzz's magic-byte sniff: a file that
 * cannot be decoded by a real `<img>` or `<video>` is rejected here, before the
 * bytes move. It stops mistakes — the .mov nobody can play, the "png" that is a
 * renamed something-else — and it is *not* a security boundary, because it runs
 * where the person is.
 */
async function probeFile(file: File, kind: MediaKind): Promise<Probe> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return {};
  if (kind === "image") return await probeImage(file);
  if (kind === "video") return await probeVideo(file);
  return {};
}

async function probeImage(file: File): Promise<Probe> {
  const src = URL.createObjectURL(file);
  try {
    const image = await loadImage(src);
    const probe: Probe = { width: image.naturalWidth, height: image.naturalHeight };
    const refusal = checkAttachment({
      mime: file.type,
      sizeBytes: file.size,
      width: probe.width,
      height: probe.height,
    });
    if (refusal) throw new Error(refusal);
    probe.thumb = (await drawToBlob(image, probe.width!, probe.height!, THUMB_MAX)) ?? undefined;
    return probe;
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function probeVideo(file: File): Promise<Probe> {
  const src = URL.createObjectURL(file);
  try {
    const video = await loadVideo(src);
    const probe: Probe = {
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      durationSecs: Number.isFinite(video.duration) ? video.duration : undefined,
    };
    const refusal = checkAttachment({
      mime: file.type,
      sizeBytes: file.size,
      width: probe.width,
      height: probe.height,
      durationSecs: probe.durationSecs,
    });
    if (refusal) throw new Error(refusal);
    probe.poster = (await capturePoster(video)) ?? undefined;
    return probe;
  } finally {
    URL.revokeObjectURL(src);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That file is not an image this browser can read"));
    image.src = src;
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () =>
      reject(new Error("That video cannot be played here — try an MP4 or WebM"));
    video.src = src;
  });
}

async function capturePoster(video: HTMLVideoElement): Promise<Blob | null> {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    video.onseeked = done;
    // A video shorter than the seek point still has a frame at zero.
    video.currentTime = Math.min(POSTER_SEEK_SECS, Math.max(0, (video.duration || 0) / 2));
    // Some browsers never fire `seeked` on a metadata-only load; do not hang.
    window.setTimeout(done, 1500);
  });
  return await drawToBlob(video, video.videoWidth, video.videoHeight, POSTER_MAX);
}

async function drawToBlob(
  source: CanvasImageSource,
  width: number,
  height: number,
  longest: number,
): Promise<Blob | null> {
  if (!width || !height) return null;
  const scale = Math.min(1, longest / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
  });
}
