"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pause, Square, Trash2, Video } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/duration";

// Recorder state machine.
//   idle    -> requesting (asks the user for screen + mic)
//   requesting -> recording | error
//   recording  -> uploading
//   uploading  -> idle (saved) | error
type RecorderState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "uploading" }
  | { kind: "error"; message: string };

export function Clips({ taskId }: { taskId: Id<"tasks"> }) {
  const clips = useQuery(api.clips.listForTask, { taskId });

  return (
    <div className="space-y-3">
      <Recorder taskId={taskId} />
      {clips === undefined ? (
        <div className="h-12 animate-pulse rounded-3xl bg-muted/40" />
      ) : clips.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clips yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {clips.map((clip) => (
            <li key={clip._id}>
              <ClipCard clip={clip} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Recorder({ taskId }: { taskId: Id<"tasks"> }) {
  const [state, setState] = useState<RecorderState>({ kind: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);

  const generateUploadUrl = useMutation(api.clips.generateUploadUrl);
  const createClip = useMutation(api.clips.create);

  // Always release media tracks when this component unmounts so we don't
  // leave the user's screen/mic indicator on if they navigate away.
  useEffect(
    () => () => {
      for (const stream of streamsRef.current)
        stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setState({
        kind: "error",
        message: "Screen recording isn't supported in this browser.",
      });
      return;
    }
    setState({ kind: "requesting" });
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      let mic: MediaStream | null = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Mic denial is fine — record video only.
      }

      const tracks = [
        ...display.getVideoTracks(),
        ...(mic ? mic.getAudioTracks() : []),
      ];
      const combined = new MediaStream(tracks);
      streamsRef.current = mic ? [display, mic] : [display];

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        combined,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => uploadAndSave();

      // If the user clicks the browser's native "Stop sharing", finalize.
      display.getVideoTracks()[0].addEventListener("ended", () => {
        if (recorder.state === "recording") recorder.stop();
      });

      recorder.start();
      startedAtRef.current = Date.now();
      setState({ kind: "recording", startedAt: startedAtRef.current });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to start",
      });
    }
  }

  function stop() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
    for (const stream of streamsRef.current)
      stream.getTracks().forEach((t) => t.stop());
    streamsRef.current = [];
  }

  async function uploadAndSave() {
    setState({ kind: "uploading" });
    try {
      const blob = new Blob(chunksRef.current, {
        type: recorderRef.current?.mimeType || "video/webm",
      });
      chunksRef.current = [];

      const uploadUrl = await generateUploadUrl({});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: string };

      await createClip({
        taskId,
        storageId: storageId as Id<"_storage">,
        durationMs: Date.now() - startedAtRef.current,
        mimeType: blob.type,
        sizeBytes: blob.size,
      });
      setState({ kind: "idle" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  return (
    <div className="rounded-3xl border border-border bg-background p-3">
      {state.kind === "idle" && (
        <Button type="button" size="sm" onClick={start}>
          <Video className="h-3.5 w-3.5" /> Record clip
        </Button>
      )}
      {state.kind === "requesting" && (
        <p className="text-sm text-muted-foreground">
          Asking for screen + mic permission…
        </p>
      )}
      {state.kind === "recording" && <RecordingPanel onStop={stop} />}
      {state.kind === "uploading" && (
        <p className="text-sm text-muted-foreground">Uploading clip…</p>
      )}
      {state.kind === "error" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-red-700">{state.message}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setState({ kind: "idle" })}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function RecordingPanel({ onStop }: { onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500"
        />
        Recording — {formatDuration(now - startedAt.current)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        onClick={onStop}
      >
        <Square className="h-3.5 w-3.5" /> Stop
      </Button>
    </div>
  );
}

function ClipCard({ clip }: { clip: Doc<"clips"> }) {
  const url = useQuery(api.clips.getUrl, { storageId: clip.storageId });
  const remove = useMutation(api.clips.remove);

  return (
    <div className="rounded-3xl border border-border bg-background p-2">
      <div className="aspect-video w-full overflow-hidden rounded-2xl bg-black">
        {url ? (
          <video
            src={url}
            controls
            playsInline
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            <Pause className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>
          {clip.durationMs ? formatDuration(clip.durationMs) : "—"}
        </span>
        <span className="ml-auto">
          {new Date(clip.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        <button
          type="button"
          aria-label="Delete clip"
          onClick={() => {
            if (window.confirm("Delete this clip?")) {
              remove({ clipId: clip._id });
            }
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function pickMimeType(): string | null {
  // Different browsers prefer different containers/codecs. Try the most
  // widely supported options first.
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}
