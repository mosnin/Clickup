"use client";

// The video, and the scrubber that has other people's remarks on it.
//
// Two surfaces, one component (§2.9): **inline** in the transcript, and a
// **review overlay** that gives the picture the screen and puts the comments
// beside it. The interesting part is the same on both: every comment with a
// timecode is a pin on the scrubber, and clicking one seeks. That is what turns
// a list of remarks into a review — you can see *where* the argument is before
// you read it.
//
// What is deliberately not here, and what it costs:
//
//   • **No transcoding.** Buzz's desktop client re-encodes everything through
//     ffmpeg before upload, so every video in a Buzz room is faststart H.264 that
//     every client can play. We upload what the person picked. The composer
//     probes it in a real `<video>` first, so a file this browser cannot decode
//     is refused before it is uploaded rather than after — but "this browser"
//     is not "every browser", and an HEVC-in-MP4 recorded on an iPhone will play
//     for the person who posted it and not for everyone else.
//   • **No server poster.** The poster frame is captured in the browser at
//     upload time and uploaded as its own blob, so `preload="metadata"` has
//     something to draw immediately. If that capture failed, the first frame is
//     whatever the browser decodes, which is the ordinary `<video>` behaviour.

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { MediaDescriptor } from "@/lib/buzz/media";
import { formatTimecode, parseTimecodedComment } from "@/lib/buzz/media";
import { VideoReviewPanel, type VideoReviewContext } from "./video-review";

export type ChatVideoProps = {
  media: MediaDescriptor;
  /** Present when this video can be reviewed — absent for a read-only surface. */
  review?: VideoReviewContext;
  maxWidth?: number;
};

export function ChatVideo({ media, review, maxWidth = 420 }: ChatVideoProps) {
  const [open, setOpen] = useState(false);
  // Handed to the overlay when it opens and handed back when it closes, so the
  // reader does not lose their place by opening the review (§2.9).
  const [handoff, setHandoff] = useState(0);
  const inlineRef = useRef<HTMLVideoElement | null>(null);

  const aspect = media.width && media.height ? media.width / media.height : 16 / 9;

  return (
    <>
      <div
        style={{ width: maxWidth, maxWidth: "100%", aspectRatio: String(aspect) }}
        className="relative overflow-hidden rounded-2xl bg-black"
      >
        <video
          ref={inlineRef}
          src={media.url}
          poster={media.posterUrl ?? media.thumbUrl}
          preload="metadata"
          controls
          playsInline
          aria-label={media.filename ? `Video: ${media.filename}` : "Video"}
          className="size-full object-contain"
        />
        {review ? (
          <button
            type="button"
            aria-label="Review this video"
            onClick={() => {
              const at = inlineRef.current?.currentTime ?? 0;
              inlineRef.current?.pause();
              setHandoff(at);
              setOpen(true);
            }}
            className="tap-target absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-black/60 text-white"
          >
            <Maximize2 aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>

      {open && review ? (
        <VideoReviewOverlay
          media={media}
          review={review}
          startAt={handoff}
          onClose={(at) => {
            setOpen(false);
            if (inlineRef.current) inlineRef.current.currentTime = at;
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The review: the picture, its scrubber with pins, and the conversation.
 *
 * A portal, because the transcript is a virtualized scroller with its own
 * overflow — a dialog rendered inside it is a dialog clipped by it.
 */
function VideoReviewOverlay({
  media,
  review,
  startAt,
  onClose,
}: {
  media: MediaDescriptor;
  review: VideoReviewContext;
  startAt: number;
  onClose: (at: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(startAt);
  const [duration, setDuration] = useState(media.durationSecs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const close = useCallback(() => onClose(currentTime), [onClose, currentTime]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  if (!mounted) return null;

  const markers = review.comments
    .map((comment) => ({ comment, seconds: parseTimecodedComment(comment.body).seconds }))
    .filter(
      (entry): entry is { comment: (typeof review.comments)[number]; seconds: number } =>
        entry.seconds !== null && duration > 0 && entry.seconds <= duration,
    );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={media.filename ? `Review ${media.filename}` : "Review video"}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
    >
      <div className="bento flex max-h-[95vh] w-full max-w-[1520px] flex-col overflow-hidden rounded-2xl bg-[var(--chat-surface)] md:flex-row">
        <div className="flex min-w-0 flex-1 flex-col bg-black">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="truncate text-xs text-white/80">
              {media.filename ?? "Video"}
            </span>
            <button
              type="button"
              aria-label="Close review"
              onClick={close}
              className="tap-target flex size-8 items-center justify-center rounded-full text-white"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>

          <video
            ref={videoRef}
            src={media.url}
            poster={media.posterUrl ?? media.thumbUrl}
            preload="metadata"
            playsInline
            aria-label="Video under review"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (Number.isFinite(video.duration)) setDuration(video.duration);
              if (startAt > 0) video.currentTime = startAt;
            }}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="min-h-0 w-full flex-1 object-contain"
          />

          <div className="flex items-center gap-3 px-3 py-2">
            <button
              type="button"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (video.paused) void video.play();
                else video.pause();
              }}
              className="tap-target flex size-8 items-center justify-center rounded-full bg-white/15 text-white"
            >
              {playing ? (
                <Pause aria-hidden className="size-4" />
              ) : (
                <Play aria-hidden className="size-4" />
              )}
            </button>

            <span className="font-mono text-micro tabular-nums text-white/70">
              {formatTimecode(currentTime)}
            </span>

            {/* The scrubber, and the remarks on it. A range input rather than a
                hand-rolled track: it is keyboard-operable and draggable on a
                phone for free, and the pins ride above it. */}
            <div className="relative min-w-0 flex-1">
              <input
                type="range"
                min={0}
                max={duration > 0 ? duration : 1}
                step={0.1}
                value={Math.min(currentTime, duration > 0 ? duration : 1)}
                aria-label="Seek"
                onChange={(event) => seek(Number(event.target.value))}
                className="w-full accent-[var(--chat-accent)]"
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-0">
                {markers.map(({ comment, seconds }) => (
                  <button
                    key={comment.id}
                    type="button"
                    // §2.10: the pin's tooltip is "<timecode> · <author>", and
                    // clicking it seeks. It is an affordance, not decoration.
                    title={`${parseTimecodedComment(comment.body).timecode} · ${comment.author}`}
                    aria-label={`Seek to ${comment.author}'s comment`}
                    onClick={() => seek(seconds)}
                    style={{ left: `${(seconds / duration) * 100}%` }}
                    className="pointer-events-auto absolute -top-3 size-4 -translate-x-1/2 rounded-full border border-white/70 bg-[var(--chat-accent)] text-micro text-[var(--chat-accent-fg)]"
                  >
                    {comment.author.slice(0, 1).toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <span className="font-mono text-micro tabular-nums text-white/70">
              {formatTimecode(duration)}
            </span>
          </div>
        </div>

        <div className="flex h-72 w-full shrink-0 flex-col border-t border-[var(--chat-hairline)] md:h-auto md:w-[380px] md:border-l md:border-t-0">
          <VideoReviewPanel
            context={review}
            currentTime={currentTime}
            duration={duration}
            onSeek={seek}
            onAuthoringFocus={() => videoRef.current?.pause()}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A video's length, for the card under the player. */
export function videoLengthLabel(media: MediaDescriptor): string | null {
  if (!media.durationSecs) return null;
  return formatTimecode(media.durationSecs);
}

export type { VideoReviewContext, VideoReviewComment } from "./video-review";
