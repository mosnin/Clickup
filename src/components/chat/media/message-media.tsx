"use client";

// What a message's attachments look like under it.
//
// One component, reading `ChatMessage.tags` — which is the *overlaid* tag set,
// the edit's media over the original's everything else. That is the whole reason
// the phase's data shape is an `imeta` tag and not a column: a renderer that read
// a column would have to know what an edit did to it, and this one gets the
// answer from the projection for free.
//
// The images share one lightbox, and the lightbox builds its gallery from the
// DOM inside this element (§2.8) — so arrow keys step through the pictures in
// *this* message, which is what a reader means by "the next one".

import { useMemo, useRef, useState } from "react";
import { mediaKindOf, parseImetaTags, type MediaDescriptor } from "@/lib/buzz/media";
import { FileCard } from "./file-card";
import { ImageLightbox, type LightboxRequest } from "./lightbox";
import { ProgressiveImage } from "./progressive-image";
import { ChatVideo } from "./video-player";
import type { VideoReviewContext } from "./video-review";

export type MessageMediaProps = {
  tags: readonly (readonly string[])[];
  /**
   * The review context for this message's video, when there is one.
   *
   * Passed in rather than assembled here: the comments are the message's thread
   * replies, and only the surface holding the transcript knows them.
   */
  review?: VideoReviewContext;
};

export function MessageMedia({ tags, review }: MessageMediaProps) {
  const media = useMemo(() => parseImetaTags(tags), [tags]);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [lightbox, setLightbox] = useState<LightboxRequest | null>(null);

  if (media.length === 0) return null;

  const images = media.filter((entry) => mediaKindOf(entry.mime) === "image");

  return (
    <div ref={scopeRef} data-message-media="" className="mt-1.5 flex flex-col gap-2">
      {media.map((entry) => (
        <MediaEntry
          key={entry.url}
          media={entry}
          review={review}
          onOpenImage={(element) =>
            setLightbox({ trigger: element, scope: scopeRef.current, media: images })
          }
        />
      ))}
      <ImageLightbox request={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

function MediaEntry({
  media,
  review,
  onOpenImage,
}: {
  media: MediaDescriptor;
  review?: VideoReviewContext;
  onOpenImage: (element: HTMLElement) => void;
}) {
  const kind = mediaKindOf(media.mime);
  // A type the renderer cannot name is a download card, never an inline frame.
  // It should not be attachable at all — the mutation refuses it — but a tag
  // written by another client, or by a build older than this one, must degrade
  // to something safe rather than to an `<img>` with an arbitrary MIME.
  if (kind === "image") return <ProgressiveImage media={media} onActivate={onOpenImage} />;
  if (kind === "video") return <ChatVideo media={media} review={review} />;
  return <FileCard media={media} />;
}
