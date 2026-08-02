"use client";

// The composer's half of attaching a file.
//
// Everything the box needs in one object, so the composer grows one optional
// prop rather than five: the reserved slots to draw, the three verbs that change
// them, and a `send` that goes through `buzz/media:post` instead of
// `buzz/messages:post`.
//
// Why a second door and not an argument on the first: attaching is not a
// property of a message, it is a *different set of preconditions* — the upload
// URL is gated on the room, the blobs are resolved from storage, the size and
// type are checked against bytes that exist. `buzz/media:post` does that work
// and then calls the very same `postMessageCore`, so mentions, threading, the
// room's clock, notifications and workflows are identical either way.

import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { useMediaUpload, type AttachmentSlot, type AttachmentUpload } from "./use-media-upload";

type ScopeArgs = { scopeType: "user" | "workspace"; scopeId: string };

/**
 * Named by hand for the reason every Chat call site states: the checked-in
 * `convex/_generated/api` stub predates `convex/buzz/*`, so `api.buzz.media`
 * does not typecheck until somebody runs `npx convex dev`.
 */
export const generateUploadUrl = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string },
  string
>("buzz/media:generateUploadUrl");

export const postWithMedia = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    channelId: string;
    body: string;
    parentId?: string;
    rootId?: string;
    attachments: AttachmentUpload[];
  },
  { eventId: string }
>("buzz/media:post");

export type ComposerMedia = {
  slots: AttachmentSlot[];
  /** Something is still uploading; the send button waits rather than dropping it. */
  busy: boolean;
  /** Anything at all in the tray, ready or not. */
  hasAttachments: boolean;
  add: (files: File[]) => void;
  remove: (slotId: string) => void;
  clear: () => void;
  send: (args: {
    scopeType: "user" | "workspace";
    scopeId: string;
    channelId: string;
    body: string;
    parentId?: string;
    rootId?: string;
  }) => Promise<unknown>;
};

export function useComposerMedia(
  scope: ChatScope,
  channelId: string,
  onRefused?: (reason: string) => void,
): ComposerMedia {
  const mintUrl = useMutation(generateUploadUrl);
  const post = useMutation(postWithMedia);

  const requestUploadUrl = useCallback(
    () => mintUrl({ scopeType: scope.scopeType, scopeId: scope.scopeId, channelId }),
    [mintUrl, scope.scopeType, scope.scopeId, channelId],
  );

  const uploads = useMediaUpload({ requestUploadUrl, ...(onRefused ? { onRefused } : {}) });

  return useMemo(
    () => ({
      slots: uploads.slots,
      busy: uploads.busy,
      hasAttachments: uploads.slots.length > 0,
      add: uploads.add,
      remove: uploads.remove,
      clear: uploads.clear,
      send: (args) => post({ ...args, attachments: uploads.ready }),
    }),
    [uploads, post],
  );
}
